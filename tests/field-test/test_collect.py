"""Unit tests for plugins/field-test/scripts/lib/collect.py, one per arm.

The module holds what `lib/collect.jq` decided: which recorded events are
candidate problems, what makes two of them the same problem, and which claim
contradicts which failure. A whole jq filter counted as a single covered line,
and a narrowed `select` or an inverted condition changed no number at all
(`.claude/rules/type-py.md`). These tests exist so each arm has an example that
reaches it and a name that says which one went red.

`test_ft_collect.py` drives the same code through the script; these reach the
arms that are awkward to provoke from the outside.
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

collect = load_lib_module("field_test_lib_collect", SCRIPTS / "lib" / "collect.py")


def post(command="git fetch origin", exit_code=0, **extra):
    record = {
        "event": "PostToolUse",
        "command": command,
        "exit_code": exit_code,
        "agent_id": None,
        "agent_type": None,
    }
    record.update(extra)
    return record


# --- norm --------------------------------------------------------------------


def test_norm_takes_the_first_line_only():
    assert collect.norm("git push\ngit status") == "git push"


def test_norm_collapses_whitespace():
    assert collect.norm("gh   pr\tlist") == "gh pr list"


def test_norm_replaces_every_run_of_digits():
    assert collect.norm("gh pr merge 1234 --repo a/b2") == "gh pr merge N --repo a/bN"


def test_norm_truncates_to_the_signature_length():
    assert len(collect.norm("x" * 200)) == collect.SIGNATURE_CHARS


def test_norm_of_a_command_that_was_never_recorded_is_empty():
    """A missing command normalises to the empty string rather than raising.

    Raising here would lose every other finding in the run.
    """
    assert collect.norm(None) == ""


# --- rank --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("severity", "expected"), [("high", 0), ("medium", 1), ("low", 2), ("unheard-of", 3)]
)
def test_rank_orders_the_severities(severity, expected):
    assert collect.rank(severity) == expected


# --- preceding ---------------------------------------------------------------


def test_preceding_takes_the_last_three_commands():
    events = [post(f"command {n}") for n in range(6)]
    assert collect.preceding(events, 5) == ["command 2", "command 3", "command 4"]


def test_preceding_skips_an_event_that_ran_no_command():
    events = [
        post("git fetch origin"),
        {"event": "Stop"},
        post(""),
        post("gh pr list"),
    ]
    assert collect.preceding(events, 4) == ["git fetch origin", "gh pr list"]


def test_preceding_of_the_first_event_is_empty():
    assert collect.preceding([post()], 0) == []


# --- failed_event ------------------------------------------------------------


def test_a_tool_failure_is_a_failed_event():
    assert collect.failed_event({"event": "PostToolUseFailure"})


def test_a_denied_command_is_a_failed_event():
    assert collect.failed_event({"event": "denied"})


def test_a_non_zero_exit_is_a_failed_event():
    assert collect.failed_event(post(exit_code=2))


def test_a_zero_exit_is_not_a_failed_event():
    assert not collect.failed_event(post(exit_code=0))


def test_an_event_with_no_exit_code_is_not_a_failed_event():
    assert not collect.failed_event({"event": "Stop"})


# --- unresolved --------------------------------------------------------------


def test_unresolved_keeps_a_failure_that_was_never_retried():
    events = [post("bash spec/run.sh", 1, agent_id="a1")]
    assert [event["command"] for event in collect.unresolved(events, "a1")] == ["bash spec/run.sh"]


def test_unresolved_drops_a_failure_the_same_command_later_fixed():
    events = [
        post("bash spec/run.sh", 1, agent_id="a1"),
        post("bash spec/run.sh", 0, agent_id="a1"),
    ]
    assert collect.unresolved(events, "a1") == []


def test_unresolved_ignores_a_success_from_another_agent():
    events = [
        post("bash spec/run.sh", 1, agent_id="a1"),
        post("bash spec/run.sh", 0, agent_id="a2"),
    ]
    assert len(collect.unresolved(events, "a1")) == 1


def test_unresolved_ignores_events_with_no_agent():
    """The main session's failures are not a subagent's to contradict."""
    assert collect.unresolved([post("bash spec/run.sh", 1)], None) == []


# --- claims_success ----------------------------------------------------------


def test_a_structured_failed_status_is_not_a_claim_of_success():
    assert not collect.claims_success('{"status": "failed"}')


def test_a_structured_paused_status_is_not_a_claim_of_success():
    assert not collect.claims_success('{"status": "paused", "question": "which branch?"}')


def test_any_other_structured_status_reports_an_outcome():
    assert collect.claims_success('{"status": "draft"}')


def test_a_success_word_in_prose_is_a_claim_of_success():
    assert collect.claims_success("Everything is Merged and the branch is clean.")


def test_prose_reporting_nothing_is_not_a_claim():
    assert not collect.claims_success("I stopped to ask about the base branch.")


def test_no_message_at_all_is_not_a_claim():
    assert not collect.claims_success(None)


# --- one function per kind of finding ----------------------------------------


def test_denied_findings_carry_the_reason_and_the_trail():
    events = [
        post("git fetch origin"),
        {"event": "denied", "command": "git push --force", "reason": "no"},
    ]
    finding = collect.denied_findings(events)[0]
    assert finding["kind"] == "denied"
    assert finding["severity"] == "high"
    assert finding["signature"] == "denied:git push --force"
    assert finding["evidence"]["reason"] == "no"
    assert finding["evidence"]["preceding"] == ["git fetch origin"]


def test_denied_findings_leave_a_reason_that_was_never_recorded_null():
    finding = collect.denied_findings([{"event": "denied", "command": "git push --force"}])[0]
    assert finding["evidence"]["reason"] is None


def test_deny_list_error_findings_name_the_rule_that_was_lost():
    events = [{"event": "deny_list_error", "pattern": "[unclosed", "line": 2, "error": "bad set"}]
    finding = collect.deny_list_error_findings(events)[0]
    assert finding["signature"] == "deny_list_error:[unclosed"
    assert finding["evidence"]["pattern"] == "[unclosed"
    assert finding["evidence"]["line"] == 2
    assert "bad set" in finding["evidence"]["reason"]


def test_deny_list_error_findings_say_so_when_no_reason_was_recorded():
    finding = collect.deny_list_error_findings([{"event": "deny_list_error", "pattern": "x"}])[0]
    assert "no reason recorded" in finding["evidence"]["reason"]


def test_hook_error_findings_take_the_last_line_of_the_traceback():
    events = [{"event": "hook_error", "hook": "PreToolUse", "error": "Traceback\nTypeError: x"}]
    finding = collect.hook_error_findings(events)[0]
    assert finding["signature"] == "hook_error:PreToolUse:TypeError: x"
    assert "PreToolUse hook raised" in finding["evidence"]["reason"]


def test_hook_error_findings_say_unknown_when_the_hook_was_not_named():
    finding = collect.hook_error_findings([{"event": "hook_error"}])[0]
    assert "unknown hook raised" in finding["evidence"]["reason"]


def test_tool_failure_findings_carry_the_exit_code_and_output():
    events = [
        {
            "event": "PostToolUseFailure",
            "command": "bash x.sh",
            "exit_code": 127,
            "stderr_tail": "not found",
        }
    ]
    finding = collect.tool_failure_findings(events)[0]
    assert finding["kind"] == "tool_failure"
    assert finding["severity"] == "medium"
    assert finding["evidence"]["exit_code"] == 127
    assert finding["evidence"]["stderr"] == "not found"


def test_nonzero_findings_ignore_a_call_that_succeeded():
    assert collect.nonzero_findings([post(exit_code=0)]) == []


def test_nonzero_findings_ignore_a_call_with_no_exit_code():
    assert collect.nonzero_findings([post(exit_code=None)]) == []


def test_nonzero_findings_ignore_an_event_of_another_kind():
    assert collect.nonzero_findings([{"event": "denied", "exit_code": 1}]) == []


def test_contradiction_findings_pair_the_claim_with_the_failure():
    events = [
        post("bash spec/run.sh", 1, agent_id="a1", agent_type="worker"),
        {
            "event": "SubagentStop",
            "agent_id": "a1",
            "agent_type": "worker",
            "last_assistant_message": "All merged.",
        },
    ]
    finding = collect.contradiction_findings(events)[0]
    assert finding["signature"] == "subagent_contradiction:worker:bash spec/run.sh"
    assert finding["evidence"]["unresolved"] == ["bash spec/run.sh"]
    assert finding["evidence"]["claim"] == "All merged."


def test_contradiction_findings_name_the_agent_type_when_there_is_none():
    events = [
        post("bash spec/run.sh", 1, agent_id="a1"),
        {"event": "SubagentStop", "agent_id": "a1", "last_assistant_message": "All merged."},
    ]
    finding = collect.contradiction_findings(events)[0]
    assert finding["signature"] == "subagent_contradiction:subagent:bash spec/run.sh"


def test_contradiction_findings_ignore_a_claim_with_nothing_unresolved():
    events = [
        post("bash spec/run.sh", 0, agent_id="a1"),
        {"event": "SubagentStop", "agent_id": "a1", "last_assistant_message": "All merged."},
    ]
    assert collect.contradiction_findings(events) == []


def test_args_dropped_findings_ignore_a_bare_word():
    assert collect.args_dropped_findings({"args": ["acme/widgets"]}, []) == []


def test_args_dropped_findings_ignore_an_option_that_reached_a_command():
    events = [post("gh pr list --dry-run")]
    assert collect.args_dropped_findings({"args": ["--dry-run"]}, events) == []


def test_args_dropped_findings_raise_an_option_that_reached_nothing():
    finding = collect.args_dropped_findings({"args": ["--dry-run"]}, [post()])[0]
    assert finding["severity"] == "low"
    assert finding["evidence"]["argument"] == "--dry-run"


def test_args_dropped_findings_ignore_an_argument_that_is_not_a_string():
    """A marker written by hand can hold anything; a number is not an option."""
    assert collect.args_dropped_findings({"args": [12]}, []) == []


def test_args_dropped_findings_read_a_marker_with_no_arguments():
    assert collect.args_dropped_findings({}, []) == []


# --- findings: dedupe and ordering -------------------------------------------


def test_findings_collapse_one_signature_into_one_record_with_a_count():
    events = [
        post("gh pr merge 11", 1),
        post("gh pr merge 12", 1),
    ]
    records = collect.findings({}, events)
    assert len(records) == 1
    assert records[0]["count"] == 2


def test_findings_put_the_worst_severity_first():
    events = [
        post("gh pr merge 11", 1),
        {"event": "denied", "command": "git push --force"},
    ]
    records = collect.findings({"args": ["--gone"]}, events)
    assert [record["severity"] for record in records] == ["high", "medium", "low"]


def test_findings_order_one_severity_by_signature():
    events = [post("zz last", 1), post("aa first", 1)]
    records = collect.findings({}, events)
    assert [record["signature"] for record in records] == [
        "bash_nonzero:aa first",
        "bash_nonzero:zz last",
    ]


def test_findings_of_a_clean_run_are_empty():
    assert collect.findings({}, [post(), post("gh pr list")]) == []


# --- last_assistant_text -----------------------------------------------------


def test_last_assistant_text_takes_the_last_turn_that_said_something():
    transcript = (
        '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}\n'
    )
    assert collect.last_assistant_text(transcript) == "second"


def test_last_assistant_text_joins_several_text_blocks():
    transcript = (
        '{"type":"assistant","message":{"content":'
        '[{"type":"text","text":"one"},{"type":"text","text":"two"}]}}\n'
    )
    assert collect.last_assistant_text(transcript) == "one\ntwo"


def test_last_assistant_text_ignores_a_turn_with_no_text_of_its_own():
    transcript = (
        '{"type":"assistant","message":{"content":[{"type":"text","text":"said"}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n'
    )
    assert collect.last_assistant_text(transcript) == "said"


def test_last_assistant_text_ignores_a_user_turn():
    assert (
        collect.last_assistant_text(
            '{"type":"user","message":{"content":[{"type":"text","text":"run it"}]}}\n'
        )
        == ""
    )


def test_last_assistant_text_skips_a_line_that_does_not_parse():
    transcript = (
        '{"type":"assistant","message":{"content":[{"type":"text","text":"whole"}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","tex\n'
    )
    assert collect.last_assistant_text(transcript) == "whole"


def test_last_assistant_text_skips_a_line_that_is_not_an_object():
    assert collect.last_assistant_text("[1, 2, 3]\n") == ""


def test_last_assistant_text_reads_a_turn_with_no_message():
    assert collect.last_assistant_text('{"type":"assistant"}\n') == ""
