"""Unit tests for `plugins/field-test/scripts/lib/checks.py`.

One per arm of the fold `checks.jq` used to hold. The arms matter more than they
look: a cancelled run reported as pending is a loop that waits forever for a run
that already ended, and a completed run with no conclusion reported as passed is
a merge on an answer that never arrived. Under kcov the whole program was one
covered line however many decisions it held; here each arm is its own branch in
the report and its own test, which is what `.claude/rules/type-py.md` asks for.

`test_ft_wait_pr.py` reaches the same arms end to end through the fixture pull
requests; these are what name them.
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

checks = load_lib_module("field_test_lib_checks", SCRIPTS / "lib" / "checks.py")


def check(status, conclusion, name="bash-5"):
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


def context(state, name="coverage"):
    return {"__typename": "StatusContext", "context": name, "state": state}


# --- default -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, "fallback"), (False, "fallback"), ("", ""), (0, 0), ("OPEN", "OPEN")],
)
def test_default_replaces_only_null_and_false(value, expected):
    """jq's `//`, not Python's `or`: an empty state must not become "UNKNOWN"."""
    assert checks.default(value, "fallback") == expected


# --- verdict, one test per arm -----------------------------------------------


@pytest.mark.parametrize("state", ["SUCCESS", "EXPECTED"])
def test_a_commit_status_in_a_pass_state_passes(state):
    assert checks.verdict(context(state)) == "pass"


@pytest.mark.parametrize("state", ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"])
def test_a_commit_status_still_running_is_pending(state):
    assert checks.verdict(context(state)) == "pending"


@pytest.mark.parametrize("state", ["FAILURE", "ERROR", "anything else"])
def test_any_other_commit_status_fails(state):
    """External CI reports its verdict in `state`, and anything not in the two
    lists above is a verdict, not a wait."""
    assert checks.verdict(context(state)) == "fail"


def test_a_run_that_has_not_completed_is_pending():
    assert checks.verdict(check("IN_PROGRESS", None)) == "pending"


def test_a_completed_run_with_no_conclusion_is_pending_not_a_pass():
    """The arm that decides whether the loop merges on an answer that never came."""
    assert checks.verdict(check("COMPLETED", None)) == "pending"


@pytest.mark.parametrize("conclusion", ["SUCCESS", "SKIPPED", "NEUTRAL"])
def test_a_completed_run_in_the_pass_list_passes(conclusion):
    assert checks.verdict(check("COMPLETED", conclusion)) == "pass"


@pytest.mark.parametrize("conclusion", ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"])
def test_a_completed_run_outside_the_pass_list_fails(conclusion):
    """Cancelled and timed out ended, and none of them ended well. Calling any of
    them pending waits for a run that is already over."""
    assert checks.verdict(check("COMPLETED", conclusion)) == "fail"


def test_a_check_that_is_not_an_object_is_refused():
    with pytest.raises(ValueError):
        checks.verdict("bash-5")


# --- name_of -----------------------------------------------------------------


def test_a_check_run_is_named_by_its_name():
    assert checks.name_of(check("COMPLETED", "SUCCESS", "bash-3.2")) == "bash-3.2"


def test_a_commit_status_is_named_by_its_context():
    assert checks.name_of(context("FAILURE", "coverage")) == "coverage"


def test_a_check_with_neither_is_called_check():
    assert checks.name_of({}) == "check"


# --- fold --------------------------------------------------------------------


def test_no_checks_at_all_folds_to_none():
    assert checks.fold({"state": "OPEN", "statusCheckRollup": []})["checks"] == "none"


def test_a_missing_rollup_folds_to_none():
    """gh omits the field for a pull request it has no rollup for at all."""
    assert checks.fold({"state": "OPEN"})["checks"] == "none"


def test_every_check_green_folds_to_pass():
    folded = checks.fold(
        {
            "state": "OPEN",
            "isDraft": False,
            "statusCheckRollup": [check("COMPLETED", "SUCCESS"), context("SUCCESS")],
        }
    )
    assert folded == {"state": "OPEN", "draft": False, "checks": "pass", "failing": []}


def test_one_failure_outranks_a_run_still_going():
    """There is nothing left to wait for once one check has failed."""
    folded = checks.fold(
        {
            "state": "OPEN",
            "statusCheckRollup": [check("COMPLETED", "FAILURE"), check("IN_PROGRESS", None)],
        }
    )
    assert folded["checks"] == "fail"
    assert folded["failing"] == ["bash-5"]


def test_a_run_still_going_beside_a_green_one_is_pending():
    folded = checks.fold(
        {
            "state": "OPEN",
            "statusCheckRollup": [check("COMPLETED", "SUCCESS"), check("IN_PROGRESS", None)],
        }
    )
    assert folded["checks"] == "pending"


def test_the_state_and_the_draft_flag_come_back_with_defaults():
    assert checks.fold({})["state"] == "UNKNOWN"
    assert checks.fold({})["draft"] is False


def test_a_draft_pull_request_says_so():
    assert checks.fold({"state": "OPEN", "isDraft": True})["draft"] is True


def test_an_answer_that_is_not_an_object_is_refused():
    """The script reports exit 4 rather than a state it does not have."""
    with pytest.raises(ValueError):
        checks.fold(["not", "an", "object"])


def test_a_rollup_that_is_not_an_array_is_refused():
    with pytest.raises(ValueError):
        checks.fold({"state": "OPEN", "statusCheckRollup": "none"})
