"""Unit tests for `plugins/workstreams/scripts/lib/issues.py`.

One test per arm, which is the point of the module existing: what these cover
was a `case` statement and a jq program, where kcov counted the whole thing as
one line however many decisions it held. `test_ws_issues.py` drives the same
logic black-box through the script; these reach the arms that are awkward to
provoke from the outside and name each one.
"""

from __future__ import annotations

import pytest
from conftest import WS_LIB, load_lib_module

issues = load_lib_module("ws_lib_issues", WS_LIB / "issues.py")


# --- classify -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("selector", "expected"),
    [
        ("label:bug", ("list", ("--label", "bug"))),
        ("milestone:observe", ("list", ("--milestone", "observe"))),
        ("milestone:two words", ("list", ("--milestone", "two words"))),
        # The value keeps every colon after the first: a milestone may hold one.
        ("label:area:parser", ("list", ("--label", "area:parser"))),
    ],
)
def test_classifies_list_selectors(selector, expected):
    assert issues.classify(selector) == expected


@pytest.mark.parametrize(
    ("selector", "numbers"),
    [
        ("12", [12]),
        ("#12", [12]),
        ("10-14", [10, 11, 12, 13, 14]),
        ("#10-12", [10, 11, 12]),
        # A range whose ends are equal is one issue, not none.
        ("7-7", [7]),
    ],
)
def test_classifies_numbers_and_ranges(selector, numbers):
    assert issues.classify(selector) == ("numbers", numbers)


@pytest.mark.parametrize(
    "selector",
    [
        "parser",
        "fix the parser",
        # '#' with no digit after it is text, not a malformed number: only one
        # leading '#' is ever dropped.
        "#abc",
        "##5",
        "-x",
    ],
)
def test_classifies_everything_else_as_search(selector):
    assert issues.classify(selector) == ("search", selector)


@pytest.mark.parametrize(
    ("selector", "message"),
    [
        ("", "empty selector"),
        ("label:", "empty value in selector: label:"),
        ("milestone:", "empty value in selector: milestone:"),
        ("3-1", "bad range: 3-1"),
        ("#9-2", "bad range: #9-2"),
        ("1,3", "not a number, range, label:, or milestone: selector: 1,3"),
        ("1O", "not a number, range, label:, or milestone: selector: 1O"),
        ("1-2-3", "not a number, range, label:, or milestone: selector: 1-2-3"),
        ("#1x", "not a number, range, label:, or milestone: selector: #1x"),
    ],
)
def test_refuses_a_malformed_selector(selector, message):
    with pytest.raises(issues.Invalid) as excinfo:
        issues.classify(selector)
    assert excinfo.value.message == message
    assert excinfo.value.status == 2


def test_refuses_a_range_wider_than_the_limit():
    """The cap is the point: `1-9999999999` used to build the whole list first
    and die with an OverflowError, having asked gh for nothing."""
    with pytest.raises(issues.Invalid) as excinfo:
        issues.classify("1-9999999999")
    assert excinfo.value.message == "range wider than the 200-issue limit: 1-9999999999"
    assert excinfo.value.status == 2


@pytest.mark.parametrize(
    ("selector", "limit", "widest"),
    [
        # The widest range each limit allows, and the first one past it.
        ("1-3", 3, True),
        ("1-4", 3, False),
        ("10-12", 2, False),
    ],
)
def test_measures_a_range_against_the_limit_it_is_given(selector, limit, widest):
    if widest:
        kind, numbers = issues.classify(selector, limit)
        assert kind == "numbers"
        assert len(numbers) == limit
    else:
        with pytest.raises(issues.Invalid):
            issues.classify(selector, limit)


def test_a_non_ascii_digit_is_search_text_not_a_number():
    """Arabic-Indic digits are `str.isdigit`, but not `[0-9]` and not an issue number."""
    assert issues.classify("١٢") == ("search", "١٢")


# --- refs ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "number", "expected"),
    [
        ("Seen in #2 and #4", 1, [2, 4]),
        # Once each, and in numeric order rather than the order mentioned.
        ("See #4, then #2, then #4 again", 1, [2, 4]),
        ("tracked here as #3 and depends on #1", 3, [1]),
        # A #N after a letter, a digit, or a slash is not a reference.
        ("https://example.invalid/wiki/#7", 6, []),
        ("issue#7", 6, []),
        ("v1#7", 6, []),
        ("#7 at the very start", 6, [7]),
        ("(#7) in brackets", 6, [7]),
        ("nothing here", 1, []),
        (None, 1, []),
        ("", 1, []),
    ],
)
def test_extracts_references(body, number, expected):
    assert issues.refs(body, number) == expected


# --- project ------------------------------------------------------------------


def test_projects_one_issue_to_the_fields_the_plan_skill_reads():
    record = {
        "number": 1,
        "title": "fix: thing",
        "state": "OPEN",
        "url": "https://example.invalid/i/1",
        "body": "blocked on #2",
        "labels": [{"name": "bug"}, {"name": "p1"}],
        "milestone": {"title": "observe"},
    }
    assert issues.project(record) == {
        "number": 1,
        "title": "fix: thing",
        "state": "OPEN",
        "url": "https://example.invalid/i/1",
        "body": "blocked on #2",
        "labels": ["bug", "p1"],
        "refs": [2],
    }


def test_projects_a_null_body_to_an_empty_string():
    assert issues.project({"number": 2, "body": None})["body"] == ""


def test_projects_a_null_label_list_to_an_empty_list():
    assert issues.project({"number": 2, "labels": None})["labels"] == []


def test_keeps_the_key_order_the_jq_projection_produced():
    projected = issues.project({"number": 1})
    assert list(projected) == ["number", "title", "state", "url", "body", "labels", "refs"]


# --- merge --------------------------------------------------------------------


def test_merges_arrays_and_single_objects_into_one_sorted_array():
    answers = [
        [{"number": 3}, {"number": 1}],
        {"number": 2},
    ]
    assert [record["number"] for record in issues.merge(answers)] == [1, 2, 3]


def test_keeps_the_first_record_seen_for_a_repeated_number():
    answers = [[{"number": 1, "title": "from the list"}], {"number": 1, "title": "from the view"}]
    merged = issues.merge(answers)
    assert len(merged) == 1
    assert merged[0]["title"] == "from the list"


def test_merges_nothing_into_an_empty_array():
    assert issues.merge([]) == []
    assert issues.merge([[]]) == []
