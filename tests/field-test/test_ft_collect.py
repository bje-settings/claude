"""Black-box tests for ft-collect.py.

Ported from `spec/field-test/collect_spec.sh`, one test per example and one
example per branch of `lib/collect.py`, which `test_collect.py` also covers
directly. The dropped example is "requires jq": there is no jq to require.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FT_COLLECT, ft_fixture_events, ft_fixture_run, ft_fixture_transcript

ROOT_USER = os.geteuid() == 0
not_as_root = pytest.mark.skipif(ROOT_USER, reason="running as root, permissions do not apply")


def collect(ft, run_script, *args):
    return run_script(FT_COLLECT, str(ft.run_dir), *args)


def findings(result):
    return json.loads(result.stdout)


def kinds(result):
    return [record["kind"] for record in findings(result)]


def prepare(ft, case, args=None):
    """The run marker and events one example is asserted against."""
    ft_fixture_events(ft.events, case)
    ft_fixture_run(ft.marker, "gh:shepherd", [] if args is None else args)


def with_transcript(ft, case):
    ft_fixture_transcript(ft.path / "transcript.jsonl", case)
    marker = ft.read_marker()
    marker["transcript_path"] = str(ft.path / "transcript.jsonl")
    ft.marker.write_text(json.dumps(marker))


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(ft_sandbox, run_script):
    """prints usage for --help"""
    result = run_script(FT_COLLECT, "--help")
    assert result.status == 0
    assert "ft-collect.py <run-dir>" in result.stdout


def test_exits_2_with_usage_when_given_nothing(ft_sandbox, run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_COLLECT)
    assert result.status == 2
    assert "ft-collect.py <run-dir>" in result.stderr


def test_rejects_an_unknown_argument(ft_sandbox, run_script):
    """rejects an unknown argument"""
    result = collect(ft_sandbox, run_script, "--verbose")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_refuses_a_directory_with_no_run_marker(ft_sandbox, run_script):
    """refuses a directory with no run marker"""
    result = run_script(FT_COLLECT, str(ft_sandbox.path))
    assert result.status == 1
    assert "no run marker" in result.stderr


def test_refuses_a_run_marker_that_is_not_json(ft_sandbox, run_script):
    """refuses a run marker that is not JSON"""
    ft_sandbox.marker.write_text("nope")
    result = collect(ft_sandbox, run_script)
    assert result.status == 1
    assert "not valid JSON" in result.stderr


def test_refuses_a_run_marker_that_is_json_but_not_an_object(ft_sandbox, run_script):
    """refuses a run marker that is JSON but not a marker

    New with the port: jq accepted any JSON here and failed later, inside the
    filter; the reader has to answer for the shape itself now.
    """
    ft_sandbox.marker.write_text("[]")
    result = collect(ft_sandbox, run_script)
    assert result.status == 1
    assert "not valid JSON" in result.stderr


def test_refuses_an_events_file_that_is_not_json_lines(ft_sandbox, run_script):
    """refuses an events file that is not JSON lines"""
    ft_sandbox.events.write_text("nope\n")
    result = collect(ft_sandbox, run_script)
    assert result.status == 1
    assert "not valid JSON lines" in result.stderr


@not_as_root
def test_refuses_an_events_file_it_cannot_read(ft_sandbox, run_script):
    """refuses an events file it cannot read

    New with the port, and the same reasoning as the unreadable transcript
    below: an empty findings array is what a clean run prints.
    """
    ft_sandbox.events.chmod(0o000)
    try:
        result = collect(ft_sandbox, run_script)
    finally:
        ft_sandbox.events.chmod(0o644)
    assert result.status == 1
    assert "not valid JSON lines" in result.stderr


def test_treats_a_missing_events_file_as_no_events(ft_sandbox, run_script):
    """treats a missing events file as no events"""
    ft_sandbox.events.unlink()
    ft_fixture_run(ft_sandbox.marker, "gh:shepherd", [])
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert result.stdout.strip() == "[]"


# --- each kind of finding ----------------------------------------------------


def test_finds_nothing_in_a_clean_run(ft_sandbox, run_script):
    """finds nothing in a run where every call succeeded"""
    prepare(ft_sandbox, "clean")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert result.stdout.strip() == "[]"


def test_raises_bash_nonzero(ft_sandbox, run_script):
    """raises bash_nonzero for a command that exited non-zero"""
    prepare(ft_sandbox, "nonzero")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["bash_nonzero"]
    assert findings(result)[0]["evidence"]["exit_code"] == 1
    assert "unstable status" in findings(result)[0]["evidence"]["stderr"]


def test_collapses_the_same_failure_on_two_numbers(ft_sandbox, run_script):
    """collapses the same failure on two PR numbers into one finding"""
    prepare(ft_sandbox, "nonzero")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert findings(result)[0]["count"] == 2
    assert findings(result)[0]["signature"] == "bash_nonzero:gh pr merge --auto --squash N"


def test_carries_the_calls_that_led_up_to_the_failure(ft_sandbox, run_script):
    """carries the calls that led up to the failure"""
    prepare(ft_sandbox, "nonzero")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert findings(result)[0]["evidence"]["preceding"] == ["git fetch origin"]


def test_raises_tool_failure(ft_sandbox, run_script):
    """raises tool_failure for a tool call that failed outright"""
    prepare(ft_sandbox, "failure")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["tool_failure"]


def test_raises_hook_error_at_the_highest_severity(ft_sandbox, run_script):
    """raises hook_error, at the highest severity, when a hook raised on a tool call"""
    prepare(ft_sandbox, "hook-error")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    record = findings(result)[0]
    assert kinds(result) == ["hook_error"]
    assert record["severity"] == "high"
    assert "PreToolUse hook raised" in record["evidence"]["reason"]
    assert "TypeError" in record["evidence"]["stderr"]


def test_carries_the_three_commands_before_a_failure(ft_sandbox, run_script):
    """carries the three commands before a failure, skipping one that ran none

    The trail stops at three, and an event with no command of its own is not one
    of them: both are what makes the evidence block in an issue readable. A
    `Stop` record sits right before the failure here, between real commands; a
    raw slice of the last three events would let it displace one.
    """
    prepare(ft_sandbox, "preceding")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert findings(result)[0]["evidence"]["preceding"] == [
        "git status --short",
        "gh pr list --state open",
        "gh pr checks 11",
    ]


def test_no_contradiction_without_a_subagent(ft_sandbox, run_script):
    """raises no contradiction when neither the claim nor the failure names a subagent

    Without the agent_id guard a claim made with no subagent id would be matched
    against every failure in the run that also has none, which is the main
    session.
    """
    prepare(ft_sandbox, "null-agent")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["bash_nonzero"]


def test_keeps_the_other_findings_when_a_command_is_missing(ft_sandbox, run_script):
    """keeps the other findings when a failed call has no command recorded"""
    prepare(ft_sandbox, "no-command")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["denied", "bash_nonzero", "tool_failure"]
    assert any(record["signature"].startswith("tool_failure:") for record in findings(result))


def test_raises_denied_at_the_highest_severity(ft_sandbox, run_script):
    """raises denied, at the highest severity, for a command the hook refused"""
    prepare(ft_sandbox, "denied")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["denied"]
    assert findings(result)[0]["severity"] == "high"
    assert "Force-pushing" in findings(result)[0]["evidence"]["reason"]


def test_raises_subagent_contradiction(ft_sandbox, run_script):
    """raises subagent_contradiction when a claim of success hides an unresolved failure"""
    prepare(ft_sandbox, "contradiction")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert "subagent_contradiction" in kinds(result)
    record = next(r for r in findings(result) if r["kind"] == "subagent_contradiction")
    assert "were merged" in record["evidence"]["claim"]


def test_no_contradiction_when_the_command_later_succeeded(ft_sandbox, run_script):
    """raises no contradiction when the same command later succeeded for that agent"""
    prepare(ft_sandbox, "retried")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert "subagent_contradiction" not in result.stdout


def test_raises_a_high_finding_for_a_rule_that_did_not_compile(ft_sandbox, run_script):
    """raises a high finding for a deny-list rule that did not compile"""
    prepare(ft_sandbox, "deny-error")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    record = findings(result)[0]
    assert record["kind"] == "deny_list_error"
    assert record["severity"] == "high"
    assert record["evidence"]["pattern"] == "[unclosed"
    assert "blocked nothing all run" in record["evidence"]["reason"]


def test_reads_a_structured_status_that_is_not_failed_as_success(ft_sandbox, run_script):
    """reads a structured status that is neither failed nor paused as a claim of success"""
    prepare(ft_sandbox, "status-ok")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert "subagent_contradiction" in kinds(result)


def test_no_contradiction_when_the_subagent_reported_the_failure(ft_sandbox, run_script):
    """raises no contradiction when the subagent reported the failure itself"""
    prepare(ft_sandbox, "honest")
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert "subagent_contradiction" not in result.stdout


def test_raises_args_dropped(ft_sandbox, run_script):
    """raises args_dropped for an option that never reached a command"""
    prepare(ft_sandbox, "clean", ["--dry-run"])
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == ["args_dropped"]
    assert findings(result)[0]["severity"] == "low"


def test_raises_nothing_when_the_option_reached_a_command(ft_sandbox, run_script):
    """raises nothing when the option did reach a command"""
    prepare(ft_sandbox, "args-used", ["--dry-run"])
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert result.stdout.strip() == "[]"


def test_ignores_a_positional_argument(ft_sandbox, run_script):
    """ignores a positional argument, which a skill may consume itself"""
    prepare(ft_sandbox, "clean", ["acme-org/widgets"])
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert result.stdout.strip() == "[]"


# --- ordering ----------------------------------------------------------------


def test_puts_the_high_severity_findings_first(ft_sandbox, run_script):
    """puts the high-severity findings first"""
    prepare(ft_sandbox, "mixed", ["--limit"])
    result = collect(ft_sandbox, run_script)
    assert result.status == 0
    assert kinds(result) == [
        "denied",
        "subagent_contradiction",
        "bash_nonzero",
        "tool_failure",
        "args_dropped",
    ]


# --- --report ----------------------------------------------------------------


def test_prints_the_targets_own_final_message(ft_sandbox, run_script):
    """prints the target own final message from the transcript"""
    with_transcript(ft_sandbox, "with-report")
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 0
    assert "| #11 | merged |" in result.stdout
    assert "Starting the round" not in result.stdout


def test_skips_a_line_the_transcript_was_cut_off_mid_write(ft_sandbox, run_script):
    """skips a line the transcript was cut off mid-write"""
    with_transcript(ft_sandbox, "truncated")
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 0
    assert result.stdout.strip() == "the whole line"


def test_prints_the_last_turn_that_said_something(ft_sandbox, run_script):
    """prints the last turn that said something, not the tool call after it"""
    with_transcript(ft_sandbox, "tool-tail")
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 0
    assert "| #11 | merged |" in result.stdout


def test_prints_nothing_when_the_transcript_holds_no_assistant_turn(ft_sandbox, run_script):
    """prints nothing when the transcript holds no assistant turn"""
    with_transcript(ft_sandbox, "no-assistant")
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_says_so_when_no_hook_recorded_a_transcript_path(ft_sandbox, run_script):
    """says so when no hook ever recorded a transcript path"""
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 1
    assert "no transcript_path" in result.stderr


@not_as_root
def test_refuses_a_transcript_it_cannot_read(ft_sandbox, run_script):
    """refuses a transcript it cannot read, rather than reporting silence

    Every way this can fail prints nothing, and so does a target that said
    nothing.
    """
    with_transcript(ft_sandbox, "with-report")
    transcript = ft_sandbox.path / "transcript.jsonl"
    transcript.chmod(0o000)
    try:
        result = collect(ft_sandbox, run_script, "--report")
    finally:
        transcript.chmod(0o644)
    assert result.status == 1
    assert "could not read the transcript" in result.stderr
    assert result.stdout == ""


def test_says_so_when_the_transcript_is_gone(ft_sandbox, run_script):
    """says so when the transcript is gone"""
    marker = ft_sandbox.read_marker()
    marker["transcript_path"] = "/nowhere/transcript.jsonl"
    ft_sandbox.marker.write_text(json.dumps(marker))
    result = collect(ft_sandbox, run_script, "--report")
    assert result.status == 1
    assert "no transcript at" in result.stderr
