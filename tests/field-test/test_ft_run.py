"""Black-box tests for ft-run.py, the field-test run marker.

Ported from `spec/field-test/run_spec.sh`; each test carries the `It` description
it came from. The one example that is gone is "requires jq": the script has no
jq to require any more.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FT_RUN, ft_fixture_run

ROOT_USER = os.geteuid() == 0
not_as_root = pytest.mark.skipif(ROOT_USER, reason="running as root, permissions do not apply")


def fresh(ft):
    """A run directory with no marker and no events, as `start` expects one."""
    ft.marker.unlink(missing_ok=True)
    ft.events.unlink(missing_ok=True)


# --- location ----------------------------------------------------------------


def test_prints_the_run_directory(ft_sandbox, run_script):
    """prints the run directory under the state dir"""
    result = run_script(FT_RUN, "dir")
    assert result.status == 0
    assert result.stdout.strip() == str(ft_sandbox.run_dir)


def test_falls_back_to_claude_plugin_data(ft_sandbox, run_script):
    """falls back to CLAUDE_PLUGIN_DATA when FT_STATE_DIR is unset"""
    ft_sandbox.delenv("FT_STATE_DIR")
    ft_sandbox.setenv("CLAUDE_PLUGIN_DATA", ft_sandbox.path / "data")
    result = run_script(FT_RUN, "dir")
    assert result.status == 0
    assert result.stdout.strip() == str(ft_sandbox.path / "data" / "runs" / "ft-session")


def test_refuses_to_guess_a_location(ft_sandbox, run_script):
    """refuses to guess a location when neither is set"""
    ft_sandbox.delenv("FT_STATE_DIR")
    result = run_script(FT_RUN, "dir")
    assert result.status == 2
    assert "CLAUDE_PLUGIN_DATA" in result.stderr


def test_refuses_to_guess_a_session(ft_sandbox, run_script):
    """refuses to guess a session"""
    ft_sandbox.delenv("CLAUDE_CODE_SESSION_ID")
    result = run_script(FT_RUN, "dir")
    assert result.status == 2
    assert "no session id" in result.stderr


def test_session_flag_beats_the_environment(ft_sandbox, run_script):
    """takes the session from --session over the environment"""
    result = run_script(FT_RUN, "dir", "--session", "other-session")
    assert result.status == 0
    assert result.stdout.strip() == str(ft_sandbox.state_dir / "runs" / "other-session")


def test_rejects_session_with_no_value(ft_sandbox, run_script):
    """rejects --session with no value"""
    result = run_script(FT_RUN, "dir", "--session")
    assert result.status == 2
    assert "--session needs a value" in result.stderr


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(ft_sandbox, run_script):
    """prints usage for --help"""
    result = run_script(FT_RUN, "--help")
    assert result.status == 0
    assert "ft-run.py start" in result.stdout


def test_exits_2_with_usage_when_given_no_command(ft_sandbox, run_script):
    """exits 2 with usage when given no command"""
    result = run_script(FT_RUN)
    assert result.status == 2
    assert "ft-run.py start" in result.stderr


def test_rejects_an_unknown_command(ft_sandbox, run_script):
    """rejects an unknown command"""
    result = run_script(FT_RUN, "restart")
    assert result.status == 2
    assert "unknown command: restart" in result.stderr


# --- start -------------------------------------------------------------------


def test_writes_a_marker_naming_the_target(ft_sandbox, run_script):
    """writes a marker naming the target, the arguments, and the directory"""
    fresh(ft_sandbox)
    result = run_script(
        FT_RUN, "start", "gh:shepherd", "--cwd", "/checkout", "--", "--dry-run", "--limit", "2"
    )
    assert result.status == 0
    assert result.stdout.strip() == str(ft_sandbox.marker)
    marker = ft_sandbox.read_marker()
    assert marker["target"] == "gh:shepherd"
    assert marker["cwd"] == "/checkout"
    assert marker["args"] == ["--dry-run", "--limit", "2"]
    assert marker["session_id"] == "ft-session"
    assert marker["finished_at"] is None


def test_records_no_arguments_as_an_empty_list(ft_sandbox, run_script):
    """records no arguments as an empty list, not an empty string"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 0
    assert ft_sandbox.read_marker()["args"] == []


def test_creates_an_empty_events_file(ft_sandbox, run_script):
    """creates an empty events file for the hooks to append to"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 0
    assert ft_sandbox.events.is_file()


def test_folds_in_what_resolve_said(ft_sandbox, run_script):
    """folds in what ft-resolve.py said about the target"""
    fresh(ft_sandbox)
    resolved = ft_sandbox.path / "r.json"
    resolved.write_text(
        json.dumps(
            {"kind": "plugin-skill", "plugin": "gh", "version": "0.2.0", "commit": "deadbee"}
        )
    )
    result = run_script(FT_RUN, "start", "gh:shepherd", "--resolved", str(resolved))
    assert result.status == 0
    marker = ft_sandbox.read_marker()
    assert marker["resolved"]["plugin"] == "gh"
    assert marker["resolved"]["commit"] == "deadbee"


def test_leaves_resolved_null_when_not_told(ft_sandbox, run_script):
    """leaves resolved null when it was not told"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:shepherd")
    assert result.status == 0
    assert ft_sandbox.read_marker()["resolved"] is None


def test_start_needs_a_target(ft_sandbox, run_script):
    """needs a target"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start")
    assert result.status == 2
    assert "start needs a target" in result.stderr


def test_start_rejects_an_unknown_option(ft_sandbox, run_script):
    """rejects an unknown option"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "--verbose")
    assert result.status == 2
    assert "unknown argument: --verbose" in result.stderr


def test_start_rejects_resolved_with_no_value(ft_sandbox, run_script):
    """rejects --resolved with no value"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "--resolved")
    assert result.status == 2
    assert "--resolved needs a value" in result.stderr


def test_start_rejects_cwd_with_no_value(ft_sandbox, run_script):
    """rejects --cwd with no value"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "--cwd")
    assert result.status == 2
    assert "--cwd needs a value" in result.stderr


def test_refuses_a_resolved_file_that_is_not_there(ft_sandbox, run_script):
    """refuses a resolved file that is not there"""
    fresh(ft_sandbox)
    result = run_script(
        FT_RUN, "start", "gh:sync", "--resolved", str(ft_sandbox.path / "nope.json")
    )
    assert result.status == 2
    assert "no such resolved file" in result.stderr


def test_refuses_a_resolved_file_that_is_not_json(ft_sandbox, run_script):
    """refuses a resolved file that is not JSON"""
    fresh(ft_sandbox)
    resolved = ft_sandbox.path / "r.json"
    resolved.write_text("not json")
    result = run_script(FT_RUN, "start", "gh:sync", "--resolved", str(resolved))
    assert result.status == 1
    assert "not valid JSON" in result.stderr


# `start` truncates events.jsonl, which is the one destructive thing this script
# does. The refusals below all happen before the truncation; only a test keeps
# them in that order, and reordering them would lose a live run's recorded events.


def test_refuses_to_start_over_a_live_run(ft_sandbox, run_script):
    """refuses to start a second run over a live one"""
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 3
    assert "already running" in result.stderr


def test_a_refused_start_leaves_the_recorded_events(ft_sandbox, run_script):
    """leaves a live run its recorded events when it refuses to start over it"""
    ft_sandbox.events.write_text('{"event":"PostToolUse"}\n{"event":"PostToolUse"}\n')
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 3
    assert "already running" in result.stderr
    assert len(ft_sandbox.read_events()) == 2


def test_a_refused_resolved_file_leaves_the_recorded_events(ft_sandbox, run_script):
    """keeps the recorded events when it refuses a resolved file it cannot read"""
    ft_sandbox.marker.unlink()
    ft_sandbox.events.write_text('{"event":"PostToolUse"}\n{"event":"PostToolUse"}\n')
    result = run_script(
        FT_RUN, "start", "gh:sync", "--resolved", str(ft_sandbox.path / "nowhere.json")
    )
    assert result.status == 2
    assert "no such resolved file" in result.stderr
    assert len(ft_sandbox.read_events()) == 2


def test_starts_again_once_the_previous_run_finished(ft_sandbox, run_script):
    """starts again once the previous run finished"""
    marker = ft_sandbox.read_marker()
    marker["finished_at"] = "2026-01-02T04:00:00Z"
    ft_sandbox.marker.write_text(json.dumps(marker))
    ft_sandbox.events.write_text('{"event":"PostToolUse"}\n{"event":"PostToolUse"}\n')
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 0
    fresh_marker = ft_sandbox.read_marker()
    assert fresh_marker["target"] == "gh:sync"
    assert fresh_marker["finished_at"] is None
    # The finished run's events belonged to that run; collecting them against this
    # marker would file the last run's failures as this one's.
    assert ft_sandbox.read_events() == []


def test_leaves_the_target_its_own_session_flag(ft_sandbox, run_script):
    """leaves the target its own --session, which it does not answer for"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "--", "--dry-run", "--session", "other-session")
    assert result.status == 0
    assert result.stdout.strip() == str(ft_sandbox.marker)
    marker = ft_sandbox.read_marker()
    assert marker["session_id"] == "ft-session"
    assert marker["args"] == ["--dry-run", "--session", "other-session"]
    assert not (ft_sandbox.state_dir / "runs" / "other-session" / "run.json").exists()


def test_records_an_empty_argument_and_one_holding_a_newline(ft_sandbox, run_script):
    """records an empty argument and one holding a newline as given"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "--", "", "a\nb", "--x")
    assert result.status == 0
    assert ft_sandbox.read_marker()["args"] == ["", "a\nb", "--x"]


@not_as_root
def test_refuses_when_it_cannot_create_the_events_file(ft_sandbox, run_script):
    """refuses when it cannot create the events file in an existing run directory"""
    fresh(ft_sandbox)
    ft_sandbox.run_dir.chmod(0o555)
    try:
        result = run_script(FT_RUN, "start", "gh:sync")
    finally:
        ft_sandbox.run_dir.chmod(0o755)
    assert result.status == 1
    assert "cannot create" in result.stderr


def test_stops_reading_its_own_options_at_the_first_bare_argument(ft_sandbox, run_script):
    """stops reading its own options at the first bare argument"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "start", "gh:sync", "sub-target", "--cwd", "/elsewhere")
    assert result.status == 0
    marker = ft_sandbox.read_marker()
    assert marker["cwd"] == os.getcwd()
    assert marker["args"] == ["sub-target", "--cwd", "/elsewhere"]


def test_names_a_corrupt_marker_rather_than_calling_it_a_live_run(ft_sandbox, run_script):
    """names a corrupt marker rather than calling it a live run"""
    ft_sandbox.marker.write_text("not json")
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 1
    assert "not valid JSON" in result.stderr
    assert "delete it" in result.stderr


def test_reports_a_state_directory_it_cannot_create(ft_sandbox, run_script):
    """reports a state directory it cannot create"""
    blocked = ft_sandbox.path / "blocked"
    blocked.write_text("")
    ft_sandbox.setenv("FT_STATE_DIR", blocked)
    result = run_script(FT_RUN, "start", "gh:sync")
    assert result.status == 1
    assert "cannot create" in result.stderr


# --- finish and show ---------------------------------------------------------


def test_stamps_the_finish_time(ft_sandbox, run_script):
    """stamps the finish time"""
    result = run_script(FT_RUN, "finish")
    assert result.status == 0
    assert ft_sandbox.read_marker()["finished_at"]


def test_keeps_the_first_finish_time(ft_sandbox, run_script):
    """keeps the first finish time when finish runs twice"""
    run_script(FT_RUN, "finish")
    first = ft_sandbox.read_marker()["finished_at"]
    result = run_script(FT_RUN, "finish")
    assert result.status == 0
    assert ft_sandbox.read_marker()["finished_at"] == first


def test_refuses_to_finish_a_session_with_no_run(ft_sandbox, run_script):
    """refuses to finish a session with no run"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "finish")
    assert result.status == 1
    assert "no field test is running" in result.stderr


def test_prints_the_marker(ft_sandbox, run_script):
    """prints the marker"""
    result = run_script(FT_RUN, "show")
    assert result.status == 0
    assert '"target": "gh:shepherd"' in result.stdout


def test_refuses_to_finish_a_corrupt_marker(ft_sandbox, run_script):
    """refuses to finish a corrupt marker rather than failing inside jq"""
    ft_sandbox.marker.write_text("not json")
    result = run_script(FT_RUN, "finish")
    assert result.status == 1
    assert "not valid JSON" in result.stderr


def test_refuses_to_show_a_session_with_no_run(ft_sandbox, run_script):
    """refuses to show a session with no run"""
    fresh(ft_sandbox)
    result = run_script(FT_RUN, "show")
    assert result.status == 1
    assert "no field test is running" in result.stderr


@not_as_root
def test_reports_a_marker_it_cannot_write(ft_sandbox, run_script):
    """reports a marker it cannot write, rather than reporting a finish that did not happen

    New with the port: the atomic write is the plugin's own code now rather than
    jq's, so the branch where it fails is this script's to answer for.
    """
    ft_fixture_run(ft_sandbox.marker)
    ft_sandbox.run_dir.chmod(0o555)
    try:
        result = run_script(FT_RUN, "finish")
    finally:
        ft_sandbox.run_dir.chmod(0o755)
    assert result.status == 1
    assert "cannot write" in result.stderr


def test_records_no_claude_version_when_claude_is_not_installed(ft_sandbox, run_script, tmp_path):
    """records an empty claude version rather than failing the run

    An issue body says which build produced the behaviour, but a missing claude
    is not worth failing a run over.
    """
    fresh(ft_sandbox)
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    result = run_script(FT_RUN, "start", "gh:sync", env={"PATH": str(empty)})
    assert result.status == 0
    assert ft_sandbox.read_marker()["claude_version"] == ""


def test_records_no_claude_version_when_claude_fails(ft_sandbox, run_script, tmp_path):
    """records an empty claude version when claude itself exits non-zero"""
    fresh(ft_sandbox)
    bin_dir = tmp_path / "failing-bin"
    bin_dir.mkdir()
    claude = bin_dir / "claude"
    claude.write_text("#!/bin/sh\nexit 1\n")
    claude.chmod(0o755)
    result = run_script(FT_RUN, "start", "gh:sync", env={"PATH": str(bin_dir)})
    assert result.status == 0
    assert ft_sandbox.read_marker()["claude_version"] == ""
