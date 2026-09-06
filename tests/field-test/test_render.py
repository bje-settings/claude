"""Unit tests for plugins/field-test/scripts/lib/render.py, one per arm.

The module holds what `lib/render.jq` decided: the words an issue uses for each
kind of finding, and what it says about everything the run did not record. Every
`if kind ==` arm gets a name here; the whole program was one covered line before
(`.claude/rules/type-jq.md`).
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

render = load_lib_module("field_test_lib_render", SCRIPTS / "lib" / "render.py")

KINDS = (
    "denied",
    "tool_failure",
    "bash_nonzero",
    "subagent_contradiction",
    "deny_list_error",
    "hook_error",
    "args_dropped",
)


def a_record(**overrides):
    record = {
        "kind": "bash_nonzero",
        "severity": "medium",
        "count": 1,
        "signature": "bash_nonzero:gh pr merge --auto --squash N",
        "evidence": {
            "command": "gh pr merge --auto --squash 11",
            "reason": None,
            "exit_code": 1,
            "stderr": "unstable",
            "claim": "All merged.",
            "preceding": ["git fetch origin"],
        },
    }
    record.update(overrides)
    return record


def a_run(**overrides):
    run = {
        "target": "gh:shepherd",
        "args": ["--dry-run"],
        "cwd": "/checkout",
        "claude_version": "2.1.263 (Claude Code)",
        "resolved": {"plugin": "gh", "version": "0.2.0", "commit": "deadbee"},
    }
    run.update(overrides)
    return run


def field(record, run, key):
    return dict(render.fields(record, run))[key]


# --- the title ---------------------------------------------------------------


def test_a_dropped_option_is_a_missing_test_not_a_fix():
    assert field(a_record(kind="args_dropped"), a_run(), "type") == "test"


def test_every_other_finding_is_a_fix():
    assert field(a_record(), a_run(), "type") == "fix"


def test_the_summary_drops_the_kind_prefix():
    assert field(a_record(), a_run(), "summary") == "gh pr merge --auto --squash N"


def test_the_summary_keeps_a_colon_inside_the_command():
    record = a_record(signature="denied:git push origin HEAD:main")
    assert field(record, a_run(), "summary") == "git push origin HEAD:main"


def test_the_summary_is_truncated():
    record = a_record(signature="denied:" + "x" * 200)
    assert len(field(record, a_run(), "summary")) == render.SUMMARY_CHARS


def test_a_signature_that_was_never_recorded_summarises_to_nothing():
    assert field(a_record(signature=""), a_run(), "summary") == ""


# --- one arm per kind --------------------------------------------------------


@pytest.mark.parametrize("kind", KINDS)
def test_every_kind_has_its_own_expected(kind):
    assert field(a_record(kind=kind), a_run(), "expected") == render.EXPECTED[kind]


def test_a_kind_it_has_no_words_for_still_says_something():
    assert field(a_record(kind="something_new"), a_run(), "expected") == render.EXPECTED_DEFAULT


@pytest.mark.parametrize("kind", [kind for kind in KINDS if kind != "subagent_contradiction"])
def test_every_kind_has_its_own_actual(kind):
    assert field(a_record(kind=kind), a_run(), "actual") == render.ACTUAL[kind]


def test_a_contradiction_quotes_the_claim_back():
    actual = field(a_record(kind="subagent_contradiction"), a_run(), "actual")
    assert actual.endswith("All merged.")


def test_a_contradiction_truncates_a_long_claim():
    record = a_record(kind="subagent_contradiction")
    record["evidence"]["claim"] = "x" * 1000
    actual = field(record, a_run(), "actual")
    assert actual.count("x") == render.CLAIM_CHARS


def test_a_kind_it_has_no_words_for_points_at_the_output():
    assert field(a_record(kind="something_new"), a_run(), "actual") == render.ACTUAL_DEFAULT


@pytest.mark.parametrize("kind", list(render.FIXTURE))
def test_every_kind_with_its_own_fixture_says_what_to_build(kind):
    assert field(a_record(kind=kind), a_run(), "fixture") == render.FIXTURE[kind]


def test_a_kind_with_no_fixture_of_its_own_falls_back():
    assert field(a_record(kind="tool_failure"), a_run(), "fixture") == render.FIXTURE_DEFAULT


# --- what the run did not record ---------------------------------------------


def test_a_finding_with_no_reason_of_its_own_gets_one():
    assert "A bash_nonzero finding recorded during the run." == field(a_record(), a_run(), "reason")


def test_a_recorded_reason_is_used_as_it_stands():
    record = a_record()
    record["evidence"]["reason"] = "the hook refused it"
    assert field(record, a_run(), "reason") == "the hook refused it"


def test_a_finding_about_the_run_as_a_whole_says_so():
    record = a_record()
    record["evidence"]["command"] = None
    assert "the finding is about the run as a whole" in field(record, a_run(), "command")


def test_no_output_recorded_is_said_rather_than_left_blank():
    record = a_record()
    record["evidence"]["stderr"] = ""
    assert field(record, a_run(), "stderr") == "(no output recorded)"


def test_an_exit_code_that_was_not_recorded_says_so():
    record = a_record()
    record["evidence"]["exit_code"] = None
    assert field(record, a_run(), "exit_code") == "not recorded"


def test_an_exit_code_of_zero_is_still_reported():
    record = a_record()
    record["evidence"]["exit_code"] = 0
    assert field(record, a_run(), "exit_code") == "0"


def test_nothing_before_it_is_said_rather_than_left_blank():
    record = a_record()
    record["evidence"]["preceding"] = []
    assert field(record, a_run(), "preceding") == "Nothing was recorded before it."


def test_the_trail_is_a_numbered_list_of_first_lines():
    record = a_record()
    record["evidence"]["preceding"] = ["git fetch origin", "gh pr list\n--state open"]
    assert field(record, a_run(), "preceding") == "1. `git fetch origin`\n1. `gh pr list`"


def test_a_run_with_no_arguments_says_none():
    assert field(a_record(), a_run(args=[]), "args") == "(none)"


def test_a_marker_with_no_resolved_target_says_what_it_can():
    run = a_run(resolved=None)
    assert field(a_record(), run, "plugin") == "gh:shepherd"
    assert field(a_record(), run, "version") == "version unknown"
    assert field(a_record(), run, "commit") == "not a local checkout"


def test_a_claude_version_that_was_not_recorded_says_so():
    assert field(a_record(), a_run(claude_version=""), "claude_version") == "not recorded"


def test_a_marker_with_no_target_at_all_still_renders():
    run = a_run(target=None, resolved=None, cwd=None)
    assert field(a_record(), run, "target") == "unknown"
    assert field(a_record(), run, "plugin") == "unknown"
    assert field(a_record(), run, "repo") == "unknown"


def test_a_finding_with_no_count_is_one():
    record = a_record()
    del record["count"]
    assert field(record, a_run(), "count") == "1"


def test_a_finding_with_no_severity_is_medium():
    record = a_record()
    del record["severity"]
    assert field(record, a_run(), "severity") == "medium"


# --- render ------------------------------------------------------------------


def test_render_fills_every_placeholder_it_is_given():
    template = "{{type}}: {{target}}: {{summary}}\n\n{{reason}}\n"
    filled = render.render(template, a_record(), a_run())
    assert filled.split("\n")[0] == "fix: gh:shepherd: gh pr merge --auto --squash N"
    assert "{{" not in filled


def test_render_leaves_a_placeholder_it_has_no_field_for():
    """The template and this module move together; a stray key must be visible."""
    assert render.render("{{nosuchkey}}", a_record(), a_run()) == "{{nosuchkey}}"


def test_a_marker_whose_resolved_is_not_an_object_still_renders():
    """A marker can be written by hand; a string where the object goes renders anyway."""
    run = a_run(resolved="gh 0.2.0")
    assert field(a_record(), run, "version") == "version unknown"
