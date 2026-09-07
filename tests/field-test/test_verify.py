"""Unit tests for `plugins/field-test/scripts/lib/verify.py`.

One per arm of the comparison `verify.jq` held. A report is a claim, and the
arms that matter are the ones where the claim is wrong or unverifiable: those
are the cases the by-hand hardening loop had to catch by reading every pull
request, and twice the report was wrong.

`test_ft_verify_report.py` reaches the same arms end to end against the stub gh;
these are what name them.
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

verify = load_lib_module("field_test_lib_verify", SCRIPTS / "lib" / "verify.py")


# --- actual_of ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("state", "expected"),
    [("MERGED", "merged"), ("CLOSED", "closed"), ("OPEN", "open"), ("", "unknown")],
)
def test_github_state_in_the_reports_vocabulary(state, expected):
    assert verify.actual_of(state) == expected


# --- satisfies ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("claimed", "actual"),
    [("merged", "merged"), ("closed", "closed"), ("open", "open"), ("skipped", "open")],
)
def test_a_claim_that_holds(claimed, actual):
    """skipped and open are the same outcome seen from two sides."""
    assert verify.satisfies(claimed, actual) is True


@pytest.mark.parametrize(
    ("claimed", "actual"),
    [
        ("merged", "open"),
        ("merged", "closed"),
        ("closed", "open"),
        ("closed", "merged"),
        ("open", "merged"),
        ("open", "closed"),
        ("skipped", "merged"),
        ("skipped", "closed"),
        ("shepherded", "open"),
    ],
)
def test_a_claim_that_does_not(claimed, actual):
    """Both sides of every arm. One `actual` per claim leaves each arm's test
    passing if it answered for the other outcome too, which is what a merged
    pull request reported as closed looks like."""
    assert verify.satisfies(claimed, actual) is False


# --- answered ----------------------------------------------------------------


def test_gh_answered_when_every_claim_came_back():
    assert verify.answered([{"number": 50, "state": "OPEN"}]) is True


def test_gh_answered_when_one_claim_failed_among_answers():
    """The one it could not read is a mismatch the report owns; the rest were checked."""
    assert verify.answered([{"number": 50, "state": "OPEN"}, {"number": 999, "error": "boom"}])


def test_gh_did_not_answer_when_every_claim_failed_the_same_way():
    """A token that expired, a gh that is not there: nothing was checked."""
    assert verify.answered([{"number": 50, "error": "gh: not logged in"}]) is False


def test_a_pull_request_that_is_not_there_is_gh_answering():
    """ "Could not resolve" is an answer: the pull request the report named is gone."""
    answers = [{"number": 999, "error": "GraphQL: Could not resolve to a PullRequest"}]
    assert verify.answered(answers) is True


def test_one_failure_that_is_not_a_missing_pull_request_is_not_an_answer():
    """Mixed and all failing: the run checked nothing it can report on."""
    answers = [
        {"number": 999, "error": "GraphQL: Could not resolve to a PullRequest"},
        {"number": 50, "error": "gh: not logged in"},
    ]
    assert verify.answered(answers) is False


# --- reason ------------------------------------------------------------------


def test_an_unreadable_pull_request_says_so_first():
    """gh's own words come first: a claim nobody could check is not a wrong claim."""
    assert verify.reason("merged", "unknown", "no such PR") == (
        "could not be read on GitHub: no such PR"
    )


def test_a_word_outside_the_vocabulary_is_named_as_one():
    assert verify.reason("shepherded", "open", "") == (
        "the report used a word this cannot check: shepherded"
    )


def test_a_plain_disagreement_quotes_both_sides():
    assert verify.reason("merged", "open", "") == "the report said merged; GitHub says open"


# --- answer_for --------------------------------------------------------------


def test_the_answer_for_a_number_is_the_record_carrying_it():
    assert verify.answer_for([{"number": 50, "state": "OPEN"}], 50)["state"] == "OPEN"


def test_a_number_with_no_answer_gets_one_saying_so():
    """A pull request gh never answered for is a mismatch, not a pass."""
    assert verify.answer_for([], 50) == {"error": "no answer from gh pr view"}


# --- compare -----------------------------------------------------------------


def test_a_report_whose_every_claim_holds():
    result = verify.compare(
        [{"number": 54, "claimed": "merged"}, {"number": 50, "claimed": "skipped"}],
        [{"number": 54, "state": "MERGED"}, {"number": 50, "state": "OPEN"}],
    )
    assert result["ok"] is True
    assert (result["checked"], result["matched"]) == (2, 2)
    assert result["mismatches"] == []
    assert [entry["reason"] for entry in result["results"]] == [None, None]


def test_the_counts_separate_the_claims_that_held_from_the_ones_that_did_not():
    result = verify.compare(
        [{"number": 54, "claimed": "merged"}, {"number": 50, "claimed": "merged"}],
        [{"number": 54, "state": "MERGED"}, {"number": 50, "state": "OPEN"}],
    )
    assert (result["ok"], result["checked"], result["matched"]) == (False, 2, 1)
    assert result["mismatches"][0]["number"] == 50


def test_a_claim_with_no_word_at_all_is_a_mismatch():
    """An empty `claimed` is a row of the table nobody filled in."""
    result = verify.compare([{"number": 50}], [{"number": 50, "state": "OPEN"}])
    assert result["ok"] is False
    assert result["results"][0]["claimed"] == ""


def test_a_pull_request_gh_could_not_answer_for_is_a_mismatch():
    result = verify.compare(
        [{"number": 999, "claimed": "merged"}],
        [{"number": 999, "error": "Could not resolve to a PullRequest"}],
    )
    assert result["ok"] is False
    assert result["results"][0]["actual"] == "unknown"
    assert "could not be read on GitHub" in result["results"][0]["reason"]
