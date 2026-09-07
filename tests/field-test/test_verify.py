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


def a_failure(number, error):
    """One failing call, as `ask_gh` records it: the flag, then the message."""
    return {"number": number, "failed": True, "error": error}


def test_gh_answered_when_every_claim_came_back():
    assert verify.answered([{"number": 50, "state": "OPEN"}]) is True


def test_gh_answered_when_one_claim_failed_among_answers():
    """The one it could not read is a mismatch the report owns; the rest were checked."""
    assert verify.answered([{"number": 50, "state": "OPEN"}, a_failure(999, "boom")])


def test_gh_did_not_answer_when_every_claim_failed_the_same_way():
    """A token that expired, a gh that is not there: nothing was checked."""
    assert verify.answered([a_failure(50, "gh: not logged in")]) is False


def test_a_pull_request_that_is_not_there_is_gh_answering():
    """ "Could not resolve" is an answer: the pull request the report named is gone."""
    answers = [a_failure(999, "GraphQL: Could not resolve to a PullRequest")]
    assert verify.answered(answers) is True


def test_one_failure_that_is_not_a_missing_pull_request_is_not_an_answer():
    """Mixed and all failing: the run checked nothing it can report on."""
    answers = [
        a_failure(999, "GraphQL: Could not resolve to a PullRequest"),
        a_failure(50, "gh: not logged in"),
    ]
    assert verify.answered(answers) is False


def test_gh_stopped_answering_part_way_through_a_round():
    """One claim came back and the rest failed alike: an outage, not nine findings.

    The rule used to be "any answer at all means gh is healthy", and a round
    where the token expired after the first call filed one issue against the
    target per remaining pull request.
    """
    answers = [{"number": 54, "state": "MERGED"}] + [
        a_failure(number, "gh: API rate limit exceeded") for number in (50, 51, 52)
    ]
    assert verify.answered(answers) is False


def test_two_different_failures_among_answers_stay_the_reports_to_own():
    """A one-off per pull request is what a moved or deleted one looks like."""
    answers = [
        {"number": 54, "state": "MERGED"},
        a_failure(50, "gh: no commits between branches"),
        a_failure(51, "gh: not found"),
    ]
    assert verify.answered(answers) is True


def test_one_failure_among_answers_is_still_the_reports_to_own():
    """Twice is an outage; once is a pull request the report has to account for."""
    answers = [{"number": 54, "state": "MERGED"}, a_failure(50, "gh: not found")]
    assert verify.answered(answers) is True


def test_a_repeated_missing_pull_request_is_still_gh_answering():
    """Every failure being "not there" is an answer, however many times it repeats."""
    answers = [
        {"number": 54, "state": "MERGED"},
        a_failure(998, "GraphQL: Could not resolve to a PullRequest"),
        a_failure(999, "GraphQL: Could not resolve to a PullRequest"),
    ]
    assert verify.answered(answers) is True


# --- failed ------------------------------------------------------------------


def test_a_call_that_failed_says_so_on_the_record():
    assert verify.failed(a_failure(50, "boom")) is True


def test_a_gh_that_failed_with_nothing_to_say_is_still_a_failure():
    """gh can exit non-zero with an empty stderr; the flag is what says so.

    Read from the message alone this was an answer carrying no state, which
    `compare` then reported as a mismatch the target was blamed for.
    """
    assert verify.failed({"number": 50, "failed": True, "error": ""}) is True
    assert verify.answered([{"number": 50, "failed": True, "error": ""}]) is False


def test_an_answer_is_not_a_failure():
    assert verify.failed({"number": 50, "state": "OPEN"}) is False


# --- reason ------------------------------------------------------------------


def test_an_unreadable_pull_request_says_so_first():
    """gh's own words come first: a claim nobody could check is not a wrong claim."""
    assert verify.reason("merged", "unknown", "no such PR", True) == (
        "could not be read on GitHub: no such PR"
    )


def test_a_failure_with_nothing_to_say_still_reads_as_unreadable():
    """A gh that exits non-zero in silence must not read as a wrong claim."""
    assert verify.reason("merged", "unknown", "", True) == (
        "could not be read on GitHub: gh failed without a message"
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
    assert verify.answer_for([], 50) == {
        "failed": True,
        "error": "no answer from gh pr view",
    }


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
        [a_failure(999, "Could not resolve to a PullRequest")],
    )
    assert result["ok"] is False
    assert result["results"][0]["actual"] == "unknown"
    assert "could not be read on GitHub" in result["results"][0]["reason"]


def test_a_call_that_failed_in_silence_is_not_blamed_on_the_report():
    """The mismatch says gh could not read it, not that the report was wrong.

    The reason text is what the harden skill branches on: one that reads as a
    disagreement gets filed as an issue against the target.
    """
    result = verify.compare(
        [{"number": 50, "claimed": "merged"}],
        [{"number": 50, "failed": True, "error": ""}],
    )
    assert result["ok"] is False
    assert result["results"][0]["actual"] == "unknown"
    assert result["results"][0]["reason"] == (
        "could not be read on GitHub: gh failed without a message"
    )
