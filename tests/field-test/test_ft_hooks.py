"""Black-box tests for the field-test hooks.

Ported from `spec/field-test/hook_spec.sh`, which drove `ft-hook.sh`; hooks.json
now runs `hook-io.py` itself, so every test here drives that file as its own
process the way Claude Code does. The hooks run on every Bash call in every
session, so the case that matters most is the one where nothing is happening: no
run marker, no work, no output.

Two examples did not come across. "a machine without python3" asserted the shell
wrapper's `command -v python3` guard; hooks.json names python3 itself now and
there is no wrapper left to absorb its absence. "exits 0 when its own JSON helper
is missing" becomes the test below for a copy of hook-io.py that cannot import
the plugin's library, which is the same guarantee at the file that now carries it.
"""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import sys

import pytest
from conftest import DENY_LIST, HOOK_IO, deny_patterns, ft_fixture_hook_input, sample_commands

pytestmark = pytest.mark.usefixtures("ft_sandbox")

MANIFEST = HOOK_IO.parent / "hooks.json"


def load_hook_io():
    """hook-io.py as a module, for the one arm no payload can reach."""
    spec = importlib.util.spec_from_file_location("ft_hook_io", HOOK_IO)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def payload_for(command, session="ft-session"):
    return json.dumps(
        {"session_id": session, "tool_name": "Bash", "tool_input": {"command": command}}
    )


def denies(result):
    return '"deny"' in result.stdout


def finish_run(ft):
    marker = ft.read_marker()
    marker["finished_at"] = "2026-01-02T04:00:00Z"
    ft.marker.write_text(json.dumps(marker))


# --- a session that is not a field test --------------------------------------


def test_records_nothing_without_a_run_marker(ft_sandbox, ft_hook):
    """records nothing and says nothing when there is no run marker"""
    ft_sandbox.marker.unlink()
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_records_nothing_once_the_run_has_finished(ft_sandbox, ft_hook):
    """records nothing once the run has finished"""
    finish_run(ft_sandbox)
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_records_nothing_for_a_different_session(ft_sandbox, ft_hook):
    """records nothing for a different session"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok", "other-session"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_records_nothing_without_a_state_directory(ft_sandbox, ft_hook):
    """records nothing when no state directory is configured"""
    ft_sandbox.delenv("FT_STATE_DIR")
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_survives_a_payload_that_is_not_json(ft_sandbox, ft_hook):
    """survives a payload that is not JSON"""
    result = ft_hook("PostToolUse", "this is not json")
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_survives_a_run_marker_that_is_not_json(ft_sandbox, ft_hook):
    """survives a run marker that is not JSON"""
    ft_sandbox.marker.write_text("nope")
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_exits_0_with_no_event_name_at_all(ft_sandbox, ft_hook):
    """exits 0 with no event name at all"""
    result = ft_hook(None, ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert result.stdout == ""


def test_exits_0_on_an_event_it_does_not_handle(ft_sandbox, ft_hook):
    """exits 0 on an event it does not handle"""
    result = ft_hook("PreCompact", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_says_nothing_at_all_for_an_event_it_does_not_know(ft_sandbox, ft_hook):
    """says nothing at all for an event it does not know

    Not usage text, which is what the port printed. hooks.json is the only caller,
    so nobody is at a prompt to read it, and a hook's stderr surfaces to the user
    as output from something they never ran.
    """
    result = ft_hook("Whatever", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_says_nothing_at_all_when_it_is_given_no_event(ft_sandbox, ft_hook):
    """says nothing at all when it is given no event either"""
    result = ft_hook(None, ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_exits_0_when_it_cannot_import_the_plugins_library(ft_sandbox, ft_hook):
    """exits 0 and records nothing when it cannot import the plugin's own library

    The guarantee the deleted shell wrapper used to hold: whatever is wrong with
    the plugin directory, a hook is never the reason a session stops.
    """
    lonely = ft_sandbox.path / "lonely" / "hook-io.py"
    lonely.parent.mkdir(parents=True)
    shutil.copy(HOOK_IO, lonely)
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"), script=lonely)
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_prints_the_traceback_when_it_cannot_import_the_plugins_library(ft_sandbox, ft_hook):
    """prints the traceback for a library it cannot import, and still exits 0

    Exiting 0 in silence is the same outcome as a session that was never a field
    test, and there is nowhere else this failure is written down: nothing was
    learned about which run directory to record it in. Claude Code keeps a hook's
    stderr in the debug log, so this is the one place it can be diagnosed.
    """
    broken = ft_sandbox.path / "broken"
    (broken / "scripts" / "lib").mkdir(parents=True)
    (broken / "hooks").mkdir()
    shutil.copy(HOOK_IO, broken / "hooks" / "hook-io.py")
    (broken / "scripts" / "lib" / "__init__.py").write_text("", encoding="utf-8")
    (broken / "scripts" / "lib" / "run.py").write_text("def (\n", encoding="utf-8")
    result = ft_hook(
        "PostToolUse", ft_fixture_hook_input("post-ok"), script=broken / "hooks" / "hook-io.py"
    )
    assert result.status == 0
    assert result.stdout == ""
    assert "Traceback" in result.stderr
    assert "SyntaxError" in result.stderr


def test_says_so_on_stderr_when_it_cannot_write_the_record(ft_sandbox, ft_hook):
    """says so on stderr when the record cannot be written, and still exits 0

    Every finding this plugin produces is computed from these records, so a write
    that failed is a finding that will never reach an issue. It cannot stop the
    session over a full disk, but going quiet would leave the run looking clean.
    """
    ft_sandbox.events.chmod(0o444)
    try:
        result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    finally:
        ft_sandbox.events.chmod(0o644)
    assert result.status == 0
    assert "field-test: could not record PostToolUse in " in result.stderr
    assert str(ft_sandbox.events) in result.stderr


# --- recording Bash calls ----------------------------------------------------


def test_records_a_successful_call(ft_sandbox, ft_hook):
    """records a successful call, so a failure can be read in sequence"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["command"] == "git fetch origin"
    assert event["exit_code"] == 0
    assert event["event"] == "PostToolUse"


def test_records_the_exit_code_however_it_is_spelled(ft_sandbox, ft_hook):
    """records the exit code however the payload spells it, plus the stderr tail"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-fail"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["exit_code"] == 1
    assert "unstable status" in event["stderr_tail"]


def test_does_not_read_a_boolean_as_an_exit_code(ft_sandbox, ft_hook):
    """does not read a boolean where an exit code belongs as a failure"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-bool-code"))
    assert result.status == 0
    assert ft_sandbox.read_events()[0]["exit_code"] is None


def test_records_which_subagent_made_the_call(ft_sandbox, ft_hook):
    """records which subagent made the call"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-fail"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["agent_id"] == "agent-1"
    assert event["agent_type"] == "shepherd-repo"


def test_records_a_call_that_failed_outright(ft_sandbox, ft_hook):
    """records a call that failed outright under its own event name"""
    result = ft_hook("PostToolUseFailure", ft_fixture_hook_input("post-failure"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["event"] == "PostToolUseFailure"
    assert event["command"] == "bash scripts/does-not-exist.sh"


def test_reads_the_exit_code_out_of_a_failure_error_string(ft_sandbox, ft_hook):
    """reads the exit code and the output out of a failure error string

    A PostToolUseFailure payload has no tool_response: the exit code is the first
    line of a top-level error string, and the output is the rest of it. Read only
    tool_response and every tool_failure issue says the exit code was not
    recorded and shows an empty output block.
    """
    result = ft_hook("PostToolUseFailure", ft_fixture_hook_input("post-failure"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["exit_code"] == 127
    assert "No such file or directory" in event["stderr_tail"]


def test_records_a_failure_whose_error_names_no_exit_code(ft_sandbox, ft_hook):
    """records a failure whose error text names no exit code"""
    result = ft_hook("PostToolUseFailure", ft_fixture_hook_input("post-failure-no-code"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert event["exit_code"] is None
    assert "interrupted" in event["stderr_tail"]


def test_keeps_the_tail_of_a_long_error(ft_sandbox, ft_hook):
    """keeps the tail of a long error, which is where the reason is"""
    payload = {
        "session_id": "ft-session",
        "tool_name": "Bash",
        "tool_input": {"command": "bash spec/run.sh"},
        "error": "HEAD" + "x" * 4000 + "TAIL",
    }
    result = ft_hook("PostToolUseFailure", payload)
    assert result.status == 0
    tail = ft_sandbox.read_events()[0]["stderr_tail"]
    assert len(tail) == 2000
    assert "TAIL" in tail
    assert "HEAD" not in tail


def test_ignores_a_tool_that_is_not_bash(ft_sandbox, ft_hook):
    """ignores a tool that is not Bash"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("pre-other"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_records_the_transcript_path_the_first_time(ft_sandbox, ft_hook):
    """records the transcript path on the marker the first time it sees one"""
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_marker()["transcript_path"] == "/transcripts/main.jsonl"


def test_does_not_overwrite_a_transcript_path_it_has(ft_sandbox, ft_hook):
    """does not overwrite a transcript path it already has"""
    marker = ft_sandbox.read_marker()
    marker["transcript_path"] = "/transcripts/first.jsonl"
    ft_sandbox.marker.write_text(json.dumps(marker))
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_marker()["transcript_path"] == "/transcripts/first.jsonl"


# --- subagents and turn boundaries -------------------------------------------


def test_records_a_subagent_last_message(ft_sandbox, ft_hook):
    """records a subagent last message, which is the claim worth checking"""
    result = ft_hook("SubagentStop", ft_fixture_hook_input("subagent-stop"))
    assert result.status == 0
    event = ft_sandbox.read_events()[0]
    assert "were merged" in event["last_assistant_message"]
    # The subagent's own transcript, not the main session's, which the payload
    # also carries and which every SubagentStop would otherwise point at.
    assert event["transcript_path"] == "/transcripts/agent-1.jsonl"


def test_stays_live_across_a_stop(ft_sandbox, ft_hook):
    """stays live across a Stop, so a target that pauses or schedules a wake keeps being recorded

    Two `Stop` payloads for the same session with a `PostToolUse` between them:
    the run is still live, both turn boundaries and the tool call were recorded,
    and the final `Stop` carries the target's own last message. See `handle_stop`
    in hook-io.py for why `Stop` does not finish the run.
    """
    assert ft_hook("Stop", ft_fixture_hook_input("stop")).status == 0
    assert ft_hook("PostToolUse", ft_fixture_hook_input("post-ok")).status == 0
    result = ft_hook("Stop", ft_fixture_hook_input("stop"))
    assert result.status == 0
    events = ft_sandbox.read_events()
    assert ft_sandbox.read_marker()["finished_at"] is None
    assert [event["event"] for event in events] == ["Stop", "PostToolUse", "Stop"]
    assert events[1]["command"] == "git fetch origin"
    assert "Rebased and pushed" in events[2]["last_assistant_message"]


# --- a payload or marker it cannot use ---------------------------------------


def test_records_nothing_when_the_payload_is_not_an_object(ft_sandbox, ft_hook):
    """records nothing when the payload is JSON but not an object"""
    result = ft_hook("PostToolUse", "[1, 2, 3]")
    assert result.status == 0
    assert ft_sandbox.read_events() == []


def test_records_nothing_when_the_marker_is_not_an_object(ft_sandbox, ft_hook):
    """records nothing when the run marker is JSON but not an object"""
    ft_sandbox.marker.write_text("[]")
    result = ft_hook("PostToolUse", ft_fixture_hook_input("post-ok"))
    assert result.status == 0
    assert ft_sandbox.read_events() == []


# --- the deny list -----------------------------------------------------------
#
# Every pattern in hooks/deny-list.txt has a denied sample in
# tests/field-test/commands/deny.txt, and allow.txt holds the near misses no
# pattern may match. Both files are walked one command at a time, so a pattern
# that stops matching, or starts matching too much, fails as its own named test.


@pytest.mark.parametrize("command", sample_commands("deny.txt"))
def test_refuses_every_command_the_list_names(ft_hook, command):
    """refuses every command the list names"""
    result = ft_hook("PreToolUse", payload_for(command))
    assert result.status == 0
    assert denies(result), f"not refused: {command}"


@pytest.mark.parametrize("command", sample_commands("allow.txt"))
def test_allows_every_command_the_list_is_careful_not_to_name(ft_hook, command):
    """allows every command the list is careful not to name"""
    result = ft_hook("PreToolUse", payload_for(command))
    assert result.status == 0
    assert not denies(result), f"wrongly refused: {command}"


@pytest.mark.parametrize("pattern", deny_patterns())
def test_every_pattern_has_a_denied_sample(pattern):
    """has a denied sample for every pattern in the list

    A pattern with no sample could be narrowed to nothing while the suite stays
    green, so each one is named here rather than counted.
    """
    import re

    compiled = re.compile(pattern)
    assert any(compiled.search(command) for command in sample_commands("deny.txt"))


def test_the_deny_list_has_more_than_one_pattern():
    """has more than one pattern to check, so the check is not vacuous"""
    assert len(deny_patterns()) == 5


def test_there_are_near_misses_to_check_against():
    """has near misses to check the patterns against

    An empty allow.txt would let the "allows every command" test pass without
    checking anything, which is the only guard against a pattern that matches
    too much.
    """
    assert len(sample_commands("allow.txt")) == 20


def test_refuses_a_command_wrapped_across_lines(ft_hook):
    """refuses a command the list names when it is wrapped across lines

    deny.txt is one command per line, so the only place the `(?s)` in every rule
    can be exercised is here. Drop it and a wrapped or chained command walks
    through.
    """
    result = ft_hook(
        "PreToolUse", payload_for("git push \\\n  --mirror git@github.com:acme/copy.git")
    )
    assert result.status == 0
    assert denies(result)
    assert "mirror push" in result.stdout


def test_refuses_a_command_after_a_newline_in_a_chain(ft_hook):
    """refuses a command the list names when it follows a newline in an && chain"""
    result = ft_hook(
        "PreToolUse", payload_for("git fetch origin &&\ngit push origin --delete wktr-9-old")
    )
    assert result.status == 0
    assert denies(result)
    assert "Deleting a remote branch" in result.stdout


def test_tells_the_target_why(ft_hook):
    """tells the target why, in the words of the list itself"""
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert '"permissionDecision": "deny"' in result.stdout
    assert "Force-pushing rewrites history" in result.stdout
    assert "Blocked by the field-test plugin" in result.stdout


def test_records_the_attempt(ft_sandbox, ft_hook):
    """records the attempt, which is the finding"""
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert denies(result)
    event = ft_sandbox.read_events()[0]
    assert event["event"] == "denied"
    assert event["command"] == "git push --force origin main"


def test_says_nothing_for_a_command_it_allows(ft_sandbox, ft_hook):
    """says nothing and records nothing for a command it allows"""
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-allow"))
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_pre_tool_use_ignores_a_tool_that_is_not_bash(ft_sandbox, ft_hook):
    """ignores a tool that is not Bash"""
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-other"))
    assert result.status == 0
    assert result.stdout == ""
    assert ft_sandbox.read_events() == []


def test_ignores_a_bash_call_with_no_command(ft_hook):
    """ignores a Bash call with no command"""
    result = ft_hook(
        "PreToolUse",
        json.dumps({"session_id": "ft-session", "tool_name": "Bash", "tool_input": {}}),
    )
    assert result.status == 0
    assert result.stdout == ""


def test_blocks_nothing_when_the_list_cannot_be_read(ft_sandbox, ft_hook):
    """blocks nothing when the list cannot be read, rather than blocking everything"""
    ft_sandbox.setenv("FT_DENY_LIST", ft_sandbox.path / "missing-list.txt")
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert result.stdout == ""


def test_records_a_list_it_could_not_read_at_all(ft_sandbox, ft_hook):
    """records a deny_list_error when the list cannot be read at all

    The whole guardrail was off for that call, which is strictly worse than the
    one dropped rule the test above it covers, and it was the one case that said
    nothing. A run that blocked nothing because it had no rules is otherwise
    indistinguishable from a run whose target never reached for anything.
    """
    missing = ft_sandbox.path / "missing-list.txt"
    ft_sandbox.setenv("FT_DENY_LIST", missing)
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    recorded = ft_sandbox.read_events()
    assert [event["event"] for event in recorded] == ["deny_list_error"]
    assert recorded[0]["pattern"] is None
    assert recorded[0]["line"] == 0
    assert str(missing) in recorded[0]["error"]
    assert recorded[0]["deny_list"] == str(missing)


def test_skips_a_line_that_is_not_a_valid_expression(ft_sandbox, ft_hook):
    """skips a line of the list that is not a valid expression"""
    listing = ft_sandbox.path / "list.txt"
    listing.write_text("# broken\n[unclosed\n# real\ngit push --force\n")
    ft_sandbox.setenv("FT_DENY_LIST", listing)
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert denies(result)
    assert "real" in result.stdout
    # Not just 'real': the comment above the rule that was dropped must not be
    # read as the reason for the rule that fired.
    assert "broken" not in result.stdout


def test_records_the_rule_it_had_to_drop(ft_sandbox, ft_hook):
    """records the rule it had to drop, so a hole in the guardrail is not silent"""
    listing = ft_sandbox.path / "list.txt"
    listing.write_text("# broken\n[unclosed\n\n# real\ngit push --force\n")
    ft_sandbox.setenv("FT_DENY_LIST", listing)
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert denies(result)
    dropped = next(
        event for event in ft_sandbox.read_events() if event["event"] == "deny_list_error"
    )
    assert dropped["pattern"] == "[unclosed"
    assert dropped["line"] == 2
    assert dropped["error"]


def test_records_a_command_that_is_not_a_string(ft_sandbox, ft_hook):
    """records a hook_error, and denies nothing, when the command is not a string

    Nothing was matched against, so nothing can be said about whether the deny
    list would have refused it. Staying silent would put that call in the run as
    one the guardrail cleared, which is the one thing it must not read as.
    """
    result = ft_hook(
        "PreToolUse",
        json.dumps(
            {
                "session_id": "ft-session",
                "tool_name": "Bash",
                "tool_input": {"command": ["rm", "-rf", "/"]},
            }
        ),
    )
    assert result.status == 0
    assert result.stdout == ""
    recorded = ft_sandbox.read_events()
    assert [event["event"] for event in recorded] == ["hook_error"]
    assert recorded[0]["error"] == ("tool_input.command is list, not a string; nothing was matched")


def test_costs_one_rule_not_the_list(ft_sandbox, ft_hook):
    """costs one rule, not the list, when a pattern breaks the engine outright

    An OverflowError, not an re.error: caught only as a syntax error, one rule
    written this way takes the whole list down for that call.
    """
    listing = ft_sandbox.path / "list.txt"
    listing.write_text("# too big\na{4294967296}\n\n# real\ngit push --force\n")
    ft_sandbox.setenv("FT_DENY_LIST", listing)
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert denies(result)
    dropped = next(
        event for event in ft_sandbox.read_events() if event["event"] == "deny_list_error"
    )
    assert dropped["pattern"] == "a{4294967296}"


def test_falls_back_to_the_pattern_itself(ft_sandbox, ft_hook):
    """falls back to the pattern itself when a rule has no comment"""
    listing = ft_sandbox.path / "list.txt"
    listing.write_text("git push --force\n")
    ft_sandbox.setenv("FT_DENY_LIST", listing)
    result = ft_hook("PreToolUse", ft_fixture_hook_input("pre-deny"))
    assert result.status == 0
    assert "git push --force" in result.stdout


def test_records_a_hook_that_raised(ft_sandbox, monkeypatch):
    """records a hook_error and still exits 0 when the hook itself raises

    Driven in process rather than black-box: everything reachable from a payload
    is guarded, so the only way to reach this arm is to make the dispatch raise.
    The recorded event is what tells collection the guardrail was off for that
    call; nothing else in the run would say so.
    """
    module = load_hook_io()

    def explode(*_args):
        raise RuntimeError("the hook could not handle this call")

    monkeypatch.setattr(module, "dispatch", explode)
    monkeypatch.setattr(sys, "stdin", io.StringIO(ft_fixture_hook_input("post-ok")))
    assert module.main(["hook-io.py", "PostToolUse"]) == 0
    event = ft_sandbox.read_events()[0]
    assert event["event"] == "hook_error"
    assert event["hook"] == "PostToolUse"
    assert "the hook could not handle this call" in event["error"]


# --- the hooks.json manifest -------------------------------------------------
#
# Every test above calls hook-io.py directly, so nothing there would notice a
# manifest that names the wrong event, points at a file that is not there, or
# drops an event entirely. Installed, that is a plugin that records nothing, with
# a green suite.


def manifest():
    return json.loads(MANIFEST.read_text())


COMMAND = (
    'command -v python3 >/dev/null 2>&1 && python3 "${{CLAUDE_PLUGIN_ROOT}}/hooks/hook-io.py" '
    "{event}; exit 0"
)


def hook_commands():
    for event, matchers in manifest()["hooks"].items():
        for matcher in matchers:
            for hook in matcher["hooks"]:
                yield event, hook


def test_passes_each_hook_the_event_name_it_is_registered_under():
    """passes each hook the event name it is registered under"""
    for event, hook in hook_commands():
        assert hook["command"] == COMMAND.format(event=event), event


def test_every_hook_command_exits_0_whatever_the_helper_does():
    """ends every hook command in `; exit 0`, whatever python3 did

    The guarantee the deleted `ft-hook.sh` held and hook-io.py cannot hold for
    itself: a hook that exits non-zero can stop the session, and the cases left
    are the ones the helper is never reached in at all. A `&&` that short-circuits
    because python3 is missing would otherwise be the hook's exit status.
    """
    for _event, hook in hook_commands():
        assert hook["command"].endswith("; exit 0")


def test_every_hook_checks_for_python3_before_running_it():
    """checks python3 is there before running it, rather than letting the shell fail"""
    for _event, hook in hook_commands():
        assert hook["command"].startswith("command -v python3 >/dev/null 2>&1 && python3 ")


def test_every_hook_keeps_its_timeout():
    """keeps the 10 second timeout on every hook"""
    for _event, hook in hook_commands():
        assert hook["timeout"] == 10


def test_only_the_bash_events_are_matched_on_bash():
    """matches on Bash for the tool events and on nothing for the session ones"""
    matchers = {
        event: [group.get("matcher") for group in groups]
        for event, groups in manifest()["hooks"].items()
    }
    assert matchers["PreToolUse"] == ["Bash"]
    assert matchers["PostToolUse"] == ["Bash"]
    assert matchers["PostToolUseFailure"] == ["Bash"]
    assert matchers["SubagentStop"] == [None]
    assert matchers["Stop"] == [None]


def test_points_every_hook_at_a_file_that_is_there():
    """points every hook at a script that is there"""
    for _event, hook in hook_commands():
        relative = hook["command"].split("${CLAUDE_PLUGIN_ROOT}/")[1].split('"')[0]
        assert (HOOK_IO.parent.parent / relative).is_file(), relative


def test_registers_exactly_the_events_the_helper_handles():
    """registers exactly the events the JSON helper handles

    The tuple itself, imported, rather than the line of source it is written on:
    a reformat that wrapped it would have made this pass against an empty list.
    """
    assert sorted(manifest()["hooks"]) == sorted(load_hook_io().EVENTS)


def test_the_deny_list_is_beside_the_hook():
    """keeps the deny list beside the hook, which is where it looks for it by default"""
    assert DENY_LIST.is_file()


def test_records_a_stderr_that_is_not_a_string(ft_sandbox, ft_hook):
    """records a tool_response whose stderr is not a string, rather than raising"""
    payload = {
        "session_id": "ft-session",
        "tool_name": "Bash",
        "tool_input": {"command": "git fetch origin"},
        "tool_response": {"stderr": ["one", "two"], "exit_code": 1},
    }
    result = ft_hook("PostToolUse", payload)
    assert result.status == 0
    assert "one" in ft_sandbox.read_events()[0]["stderr_tail"]


def test_a_reader_that_closed_early_is_not_a_failure(ft_sandbox, run_with_no_reader):
    """exits 0, with no traceback, when Claude Code stopped reading the decision

    A hook writes its PreToolUse decision to stdout. If nobody is reading it any
    more that is not this hook's failure, and the interpreter must not print its
    own trace on the way out either: exiting non-zero, or writing anything to
    stderr, is how a hook becomes the reason a session stops.
    """
    completed = run_with_no_reader(HOOK_IO, "PreToolUse", stdin=ft_fixture_hook_input("pre-deny"))
    assert completed.returncode == 0
    assert completed.stderr == b""


def test_a_failure_before_the_run_directory_is_known_reaches_the_outer_guard(monkeypatch):
    """lets a failure before the run directory is known reach the outermost guard

    Nothing is known yet about where this run records anything, so there is no
    events file to write a hook_error into. Swallowing it here would leave the
    failure written down nowhere at all; the guard around `main` prints the
    traceback and still exits 0.
    """
    module = load_hook_io()

    def explode():
        raise RuntimeError("the plugin directory is not importable")

    monkeypatch.setattr(module, "load_run_lib", explode)
    monkeypatch.setattr(sys, "stdin", io.StringIO(ft_fixture_hook_input("post-ok")))
    with pytest.raises(RuntimeError):
        module.main(["hook-io.py", "PostToolUse"])


def test_reconfigure_leaves_a_stream_that_cannot_be_reconfigured():
    """leaves a stream with no reconfigure alone, rather than raising on it

    The hook keeps its own copy of this rather than importing the one in
    scripts/lib/cli.py: it runs on every tool call in every session, and must not
    need an import to succeed before it can speak.
    """
    assert load_hook_io().reconfigure(io.StringIO()) is None
