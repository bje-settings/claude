"""Unit tests for `plugins/workstreams/scripts/lib/pr_status.py`.

One test per arm of the check-state fold. `.claude/rules/type-jq.md` records
three mutations of exactly this fold -- narrowing the fail set, dropping NEUTRAL
from the pass set, inverting the completed arm -- that each left the whole shell
suite green with coverage unmoved, because the jq was one line to kcov. Every
outcome below is named, and every one is reachable from these tests alone.
"""

from __future__ import annotations

import pytest
from conftest import WS_LIB, load_lib_module

pr_status = load_lib_module("ws_lib_pr_status", WS_LIB / "pr_status.py")


def check_run(name="test", status="COMPLETED", conclusion="SUCCESS"):
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


def status_context(context="ci", state="SUCCESS"):
    return {"__typename": "StatusContext", "context": context, "state": state}


# --- coalesce and present -----------------------------------------------------


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ((None, "UNKNOWN"), "UNKNOWN"),
        ((False, "UNKNOWN"), "UNKNOWN"),
        # "" is a value jq's `//` keeps, unlike Python's `or`, and the empty
        # reviewDecision the run loop reads depends on that.
        (("", "UNKNOWN"), ""),
        ((0, "UNKNOWN"), 0),
        (([], "UNKNOWN"), []),
        (("APPROVED", "UNKNOWN"), "APPROVED"),
        ((None, None), None),
    ],
)
def test_coalesce_skips_only_null_and_false(values, expected):
    assert pr_status.coalesce(*values) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("SUCCESS", "SUCCESS"), (False, False)],
)
def test_present_treats_the_empty_string_as_absent(value, expected):
    assert pr_status.present(value) == expected


# --- outcome ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (check_run(conclusion="SUCCESS"), "SUCCESS"),
        # A CheckRun reads its conclusion and never its state, so one still
        # running is pending however GitHub filled the other field in.
        (check_run(status="IN_PROGRESS", conclusion=None), "PENDING"),
        # The arm the rule file names: COMPLETED with no conclusion has not said
        # it passed, and reading it as success is the mistake this must not make.
        (check_run(status="COMPLETED", conclusion=None), "PENDING"),
        (check_run(conclusion=""), "PENDING"),
        (status_context(state="SUCCESS"), "SUCCESS"),
        (status_context(state="PENDING"), "PENDING"),
        (status_context(state=None), "PENDING"),
        # Lower case from a future API still folds, since the sets are upper case.
        (check_run(conclusion="failure"), "FAILURE"),
        # A row with no __typename falls back to whichever field it has, so a
        # rollup shape GitHub adds later folds rather than crashing.
        ({"conclusion": "SUCCESS"}, "SUCCESS"),
        ({"state": "FAILURE"}, "FAILURE"),
        ({"conclusion": None, "state": "SUCCESS"}, "SUCCESS"),
        ({}, "PENDING"),
    ],
)
def test_outcome_of_one_row(row, expected):
    assert pr_status.outcome(row) == expected


@pytest.mark.parametrize(
    "state",
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"],
)
def test_every_state_that_counts_as_a_failure(state):
    assert pr_status.failed(state) is True


@pytest.mark.parametrize("state", ["SUCCESS", "NEUTRAL", "SKIPPED", "PENDING", "QUEUED", ""])
def test_states_that_do_not_count_as_a_failure(state):
    assert pr_status.failed(state) is False


# --- check_name ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (check_run(name="lint"), "lint"),
        (status_context(context="coverage/kcov"), "coverage/kcov"),
        ({"context": "ci"}, "ci"),
        ({}, "unnamed"),
        ({"name": None, "context": None}, "unnamed"),
    ],
)
def test_check_name(row, expected):
    assert pr_status.check_name(row) == expected


# --- fold ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rows", "expected"),
    [
        ([], "none"),
        ([check_run(conclusion="SUCCESS"), check_run(conclusion="SKIPPED")], "pass"),
        ([check_run(conclusion="SUCCESS"), check_run(conclusion="NEUTRAL")], "pass"),
        ([status_context(state="SUCCESS")], "pass"),
        ([check_run(conclusion="SUCCESS"), check_run(conclusion="FAILURE")], "fail"),
        ([check_run(conclusion="CANCELLED")], "fail"),
        ([check_run(status="COMPLETED", conclusion="STALE")], "fail"),
        ([check_run(status="IN_PROGRESS", conclusion=None)], "pending"),
        ([check_run(status="COMPLETED", conclusion=None)], "pending"),
        ([status_context(state="PENDING")], "pending"),
        # fail beats pending: a run still going does not soften a failure that
        # has already happened.
        (
            [check_run(conclusion="FAILURE"), check_run(status="IN_PROGRESS", conclusion=None)],
            "fail",
        ),
        # pending beats pass: one unfinished check means the PR is not green.
        ([check_run(conclusion="SUCCESS"), status_context(state="PENDING")], "pending"),
    ],
)
def test_fold(rows, expected):
    assert pr_status.fold(rows) == expected


def test_failing_names_only_the_failed_checks_in_rollup_order():
    rows = [
        check_run(name="test", conclusion="SUCCESS"),
        check_run(name="lint", conclusion="FAILURE"),
        status_context(context="coverage/kcov", state="FAILURE"),
        check_run(name="docs", status="IN_PROGRESS", conclusion=None),
    ]
    assert pr_status.failing(rows) == ["lint", "coverage/kcov"]


def test_failing_is_empty_when_nothing_failed():
    assert pr_status.failing([check_run()]) == []


# --- reduce -------------------------------------------------------------------


def test_reduce_projects_the_fields_the_run_loop_decides_on():
    document = {
        "number": 11,
        "url": "https://example.invalid/p/11",
        "title": "chore: pin the linter",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-2-pin-linter",
        "headRefOid": "bbb222",
        "mergeable": "CONFLICTING",
        "reviewDecision": "CHANGES_REQUESTED",
        "statusCheckRollup": [check_run(name="lint", conclusion="FAILURE")],
    }
    assert pr_status.reduce(document) == {
        "number": 11,
        "url": "https://example.invalid/p/11",
        "title": "chore: pin the linter",
        "state": "OPEN",
        "draft": True,
        "base": "main",
        "head": "wktr-2-pin-linter",
        "headSha": "bbb222",
        "mergeable": "CONFLICTING",
        "checks": "fail",
        "failing": ["lint"],
        "reviewDecision": "CHANGES_REQUESTED",
    }


def test_reduce_defaults_a_null_mergeable_review_decision_and_rollup():
    reduced = pr_status.reduce({"number": 13, "mergeable": None, "reviewDecision": None})
    assert reduced["mergeable"] == "UNKNOWN"
    assert reduced["reviewDecision"] == ""
    assert reduced["checks"] == "none"
    assert reduced["failing"] == []


def test_reduce_keeps_the_key_order_the_jq_projection_produced():
    assert list(pr_status.reduce({"number": 1})) == [
        "number",
        "url",
        "title",
        "state",
        "draft",
        "base",
        "head",
        "headSha",
        "mergeable",
        "checks",
        "failing",
        "reviewDecision",
    ]
