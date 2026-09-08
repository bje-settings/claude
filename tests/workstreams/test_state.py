"""Unit tests for plugins/workstreams/scripts/lib/state.py, one per arm.

The module holds the jq programs the shell ws-state ran -- the add-stream filter, both
`set` filters, the list-streams selection, defer, meta and the shape check --
and the argument validation the shell did with regexes and substring tests. A
whole jq filter counted as a single covered line, and a narrowed `select` or an
inverted condition changed no number at all (`.claude/rules/type-py.md`). These
tests exist so each arm has an example that reaches it and a name that says
which one went red.

The black-box tests in `test_ws_state.py` drive the same code through the script;
these reach the arms that are awkward to provoke from the outside, and pin the
messages the script's exit codes are attached to.
"""

from __future__ import annotations

import pytest
from conftest import WS_SCRIPTS, load_lib_module

# By path under a plugin-unique name, not `sys.path` plus `from lib import
# state`: that is what the script does, and it is right there, but every
# plugin's tests share one pytest process and the next `scripts/lib/` would take
# the same `sys.modules["lib"]`.
state = load_lib_module("workstreams_lib_state", WS_SCRIPTS / "lib" / "state.py")


def a_state(**overrides):
    document = state.new_state("bje-settings/example", "2026-01-01T00:00:00Z")
    document.update(overrides)
    return document


def a_stream(stream_id="s1", **overrides):
    record = state.stream_record(stream_id, "1", "independent", "", "", "", "sonnet", "low", "")
    record.update(overrides)
    return record


# --- is_state -----------------------------------------------------------------


def test_is_state_accepts_a_document_with_a_streams_array():
    assert state.is_state(a_state()) is True


def test_is_state_rejects_a_document_that_is_not_an_object():
    """A JSON array at the top level is not workstreams state."""
    assert state.is_state([{"streams": []}]) is False


def test_is_state_rejects_an_object_with_no_streams():
    """Another tool's JSON sitting at the same path."""
    assert state.is_state({"plugins": {}}) is False


def test_is_state_rejects_streams_that_are_not_an_array():
    assert state.is_state({"streams": {"s1": {}}}) is False


def test_is_state_rejects_a_stream_that_is_not_an_object():
    """Everything downstream reads a stream with .get; a string has none."""
    assert state.is_state({"streams": ["s1"]}) is False


@pytest.mark.parametrize("deferred", [{"a": 1}, "abc", [7], None])
def test_is_state_rejects_a_deferred_that_is_not_a_list_of_objects(deferred):
    """`defer` iterates it and reads .issue off every entry."""
    assert state.is_state({"streams": [], "deferred": deferred}) is False


def test_is_state_accepts_a_document_with_no_deferred_or_meta():
    """A file written before either existed is still workstreams state."""
    assert state.is_state({"streams": []}) is True


@pytest.mark.parametrize("meta", [5, "abc", [], None])
def test_is_state_rejects_a_meta_that_is_not_an_object(meta):
    """`set_meta` assigns into it, which is a TypeError on anything else."""
    assert state.is_state({"streams": [], "meta": meta}) is False


def test_new_state_starts_empty():
    document = state.new_state("acme/widgets", "2026-01-01T00:00:00Z")
    assert document["version"] == state.VERSION
    assert document["repo"] == "acme/widgets"
    assert document["created"] == "2026-01-01T00:00:00Z"
    assert [document["meta"], document["streams"], document["deferred"]] == [{}, [], []]


# --- stream_record ------------------------------------------------------------


def test_stream_record_splits_the_issue_list_into_numbers():
    assert a_stream(stream_id="s1")["issues"] == [1]
    record = state.stream_record("s1", "1,3,12", "independent", "", "", "", "haiku", "low", "")
    assert record["issues"] == [1, 3, 12]


def test_stream_record_nulls_the_stack_fields_an_independent_stream_omits():
    record = a_stream()
    assert [record["stack"], record["order"], record["base"]] == [None, None, None]


def test_stream_record_keeps_the_stack_fields_of_a_layer():
    record = state.stream_record(
        "s1b", "3", "stack", "parser", "2", "wktr-1-parser", "sonnet", "low", "why"
    )
    assert [record["stack"], record["order"], record["base"]] == ["parser", 2, "wktr-1-parser"]


def test_stream_record_fills_in_the_defaults_a_new_stream_starts_with():
    record = a_stream()
    assert record["status"] == "planned"
    assert record["attempts"] == 0
    assert record["review_rounds"] == 0
    assert [record["branch"], record["worktree"], record["pr"], record["prs"]] == [None] * 4
    assert [record["agent"], record["question"]] == [None, None]


def test_stream_record_orders_its_keys_the_way_the_filter_did():
    """The key order of a record, which is what `show` prints and a reader reads."""
    assert list(a_stream()) == [
        "id",
        "issues",
        "kind",
        "stack",
        "order",
        "base",
        "model",
        "effort",
        "reason",
        "status",
        "branch",
        "worktree",
        "pr",
        "prs",
        "agent",
        "question",
        "attempts",
        "review_rounds",
    ]


# --- find_stream, add_stream, set_stream_field --------------------------------


def test_find_stream_returns_the_matching_record():
    document = a_state(streams=[a_stream("s1"), a_stream("s2")])
    assert state.find_stream(document, "s2")["id"] == "s2"


def test_find_stream_returns_none_for_an_id_that_is_not_there():
    assert state.find_stream(a_state(streams=[a_stream("s1")]), "s9") is None


def test_add_stream_appends_to_the_end():
    document = state.add_stream(a_state(streams=[a_stream("s1")]), a_stream("s2"))
    assert [record["id"] for record in document["streams"]] == ["s1", "s2"]


def test_add_stream_refuses_a_duplicate_id_and_keeps_the_first():
    document = a_state(streams=[a_stream("s1", reason="first")])
    with pytest.raises(state.Invalid) as raised:
        state.add_stream(document, a_stream("s1", reason="second"))
    assert raised.value.status == 1
    assert "already exists: s1" in raised.value.message
    assert document["streams"][0]["reason"] == "first"


def test_set_stream_field_writes_only_the_named_stream():
    document = a_state(streams=[a_stream("s1"), a_stream("s2")])
    state.set_stream_field(document, "s2", "status", "draft")
    assert [record["status"] for record in document["streams"]] == ["planned", "draft"]


def test_set_stream_field_refuses_an_unknown_stream():
    with pytest.raises(state.Invalid) as raised:
        state.set_stream_field(a_state(), "nope", "status", "done")
    assert raised.value.status == 1
    assert "unknown stream: nope" in raised.value.message


# --- bump_stream_field --------------------------------------------------------


def test_bump_stream_field_adds_one_and_reports_what_the_field_now_holds():
    document = a_state(streams=[a_stream("s1")])
    assert state.bump_stream_field(document, "s1", "review_rounds") == 1
    assert state.bump_stream_field(document, "s1", "review_rounds") == 2
    assert document["streams"][0]["review_rounds"] == 2


def test_bump_stream_field_treats_a_null_count_as_zero():
    """A stream planned before the field existed carries no count at all."""
    document = a_state(streams=[a_stream("s1")])
    document["streams"][0]["attempts"] = None
    assert state.bump_stream_field(document, "s1", "attempts") == 1


def test_bump_stream_field_treats_an_absent_count_as_zero():
    document = a_state(streams=[a_stream("s1")])
    del document["streams"][0]["attempts"]
    assert state.bump_stream_field(document, "s1", "attempts") == 1


def test_bump_stream_field_writes_only_the_named_stream():
    document = a_state(streams=[a_stream("s1"), a_stream("s2")])
    state.bump_stream_field(document, "s2", "review_rounds")
    assert [record["review_rounds"] for record in document["streams"]] == [0, 1]


def test_bump_stream_field_refuses_an_unknown_stream():
    with pytest.raises(state.Invalid) as raised:
        state.bump_stream_field(a_state(), "nope", "review_rounds")
    assert raised.value.status == 1
    assert "unknown stream: nope" in raised.value.message


@pytest.mark.parametrize("value", ["two", True, 1.5, [1]])
def test_bump_stream_field_refuses_a_count_that_is_not_a_whole_number(value):
    """Refused rather than replaced: a field holding something else means the
    file was written by something other than this script, and overwriting it
    would lose whatever that was. `True` is an int in Python and is not a count."""
    document = a_state(streams=[a_stream("s1")])
    document["streams"][0]["review_rounds"] = value
    with pytest.raises(state.Invalid) as raised:
        state.bump_stream_field(document, "s1", "review_rounds")
    assert raised.value.status == 1
    assert "is not a number on stream s1" in raised.value.message


def test_check_numeric_field_accepts_every_field_that_holds_a_number():
    for field in state.NUMERIC_FIELDS:
        state.check_numeric_field(field)


def test_check_numeric_field_refuses_a_field_that_holds_a_string():
    with pytest.raises(state.Invalid) as raised:
        state.check_numeric_field("status")
    assert "not a numeric field" in raised.value.message


# --- filter_streams -----------------------------------------------------------


def test_filter_streams_with_no_status_returns_every_stream():
    document = a_state(streams=[a_stream("s1"), a_stream("s2", status="draft")])
    assert [record["id"] for record in state.filter_streams(document, "")] == ["s1", "s2"]


def test_filter_streams_keeps_only_the_matching_status():
    document = a_state(streams=[a_stream("s1"), a_stream("s2", status="draft")])
    assert [record["id"] for record in state.filter_streams(document, "draft")] == ["s2"]


def test_filter_streams_returns_nothing_when_no_stream_matches():
    assert state.filter_streams(a_state(streams=[a_stream("s1")]), "done") == []


# --- is_finished --------------------------------------------------------------


def test_is_finished_is_true_when_every_stream_is_terminal():
    """done and failed together: both count, not only done."""
    document = a_state(streams=[a_stream("s1", status="done"), a_stream("s2", status="failed")])
    assert state.is_finished(document) is True


def test_is_finished_is_true_for_a_plan_with_no_streams():
    """A plan `init` wrote and nobody added a stream to is replaceable."""
    assert state.is_finished(a_state()) is True


@pytest.mark.parametrize("status", ["planned", "running", "draft", "reviewing"])
def test_is_finished_is_false_while_a_stream_is_still_working(status):
    document = a_state(streams=[a_stream("s1", status="done"), a_stream("s2", status=status)])
    assert state.is_finished(document) is False


def test_is_finished_is_false_for_a_paused_stream():
    """The user owes an answer, so the plan is not over.

    Its own test rather than a parameter of the one above: `paused` is the arm
    somebody reading TERMINAL as "not running" would get wrong, and archiving a
    plan over it would file the question away unanswered.
    """
    document = a_state(streams=[a_stream("s1", status="paused")])
    assert state.is_finished(document) is False


def test_is_finished_is_false_for_a_status_outside_the_vocabulary():
    """A hand-edited status is not terminal; it is a file needing a person."""
    document = a_state(streams=[a_stream("s1", status="nearly")])
    assert state.is_finished(document) is False


# --- reconcile ----------------------------------------------------------------


def test_reconcile_marks_a_stream_whose_pr_merged_done():
    document = a_state(streams=[a_stream("s1", status="reviewing", pr=10)])
    document, transitions = state.reconcile(document, {10: "MERGED"})
    assert document["streams"][0]["status"] == "done"
    assert transitions == [{"stream": "s1", "from": "reviewing", "to": "done"}]


def test_reconcile_marks_a_stream_whose_pr_closed_failed_with_the_question():
    document = a_state(streams=[a_stream("s1", status="draft", pr=11)])
    document, transitions = state.reconcile(document, {11: "CLOSED"})
    stream = document["streams"][0]
    assert stream["status"] == "failed"
    assert stream["question"] == "PR #11 was closed without merging"
    assert transitions == [{"stream": "s1", "from": "draft", "to": "failed"}]


def test_reconcile_leaves_a_stream_whose_pr_is_open_alone():
    document = a_state(streams=[a_stream("s1", status="reviewing", pr=12, question=None)])
    document, transitions = state.reconcile(document, {12: "OPEN"})
    assert document["streams"][0]["status"] == "reviewing"
    assert transitions == []


def test_reconcile_ignores_a_stream_with_no_pr():
    """A stream still working has nothing on GitHub to reconcile against."""
    document = a_state(streams=[a_stream("s1", status="running", pr=None)])
    document, transitions = state.reconcile(document, {10: "MERGED"})
    assert document["streams"][0]["status"] == "running"
    assert transitions == []


def test_reconcile_leaves_a_terminal_stream_alone():
    """A failed stream whose PR was merged later stays failed.

    The loop already reached a verdict on it, and reopening one from a merge
    somebody did afterwards would resurrect work the report has closed out.
    """
    document = a_state(streams=[a_stream("s1", status="failed", pr=10)])
    document, transitions = state.reconcile(document, {10: "MERGED"})
    assert document["streams"][0]["status"] == "failed"
    assert transitions == []


def test_reconcile_leaves_a_stream_whose_pr_was_not_asked_about():
    document = a_state(streams=[a_stream("s1", status="draft", pr=99)])
    document, transitions = state.reconcile(document, {10: "MERGED"})
    assert document["streams"][0]["status"] == "draft"
    assert transitions == []


def test_reconcile_reports_every_transition_in_order():
    document = a_state(
        streams=[
            a_stream("s1", status="reviewing", pr=10),
            a_stream("s2", status="draft", pr=11),
            a_stream("s3", status="running", pr=12),
        ]
    )
    document, transitions = state.reconcile(document, {10: "MERGED", 11: "CLOSED", 12: "OPEN"})
    assert [entry["stream"] for entry in transitions] == ["s1", "s2"]
    assert [stream["status"] for stream in document["streams"]] == [
        "done",
        "failed",
        "running",
    ]


# --- archive_name -------------------------------------------------------------


def test_file_stem_is_the_state_file_name_without_json():
    assert state.file_stem("bje-settings/example") == "bje-settings__example"


def test_archive_name_carries_the_repo_and_the_moment_it_was_created():
    assert state.archive_name(a_state()) == "bje-settings__example.2026-01-01T00-00-00Z.json"


@pytest.mark.parametrize("created", ["2026-01-01T00:00:00Z", "2026/01/01", "a\\b"])
def test_archive_name_replaces_what_a_path_would_read_as_structure(created):
    """A colon is a separator on some filesystems; a slash is one everywhere."""
    name = state.archive_name(a_state(created=created))
    assert ":" not in name and "/" not in name and "\\" not in name


@pytest.mark.parametrize("document", [{"created": "2026-01-01T00:00:00Z"}, {"repo": None}])
def test_archive_name_falls_back_to_unknown_for_a_field_it_cannot_read(document):
    """Only something other than this script writes such a file, and it is still
    worth keeping."""
    assert "unknown" in state.archive_name(document)


# --- meta and deferred --------------------------------------------------------


def test_set_meta_writes_the_field():
    document = state.set_meta(a_state(), "plan_path", "/tmp/plan.md")
    assert document["meta"] == {"plan_path": "/tmp/plan.md"}


def test_set_meta_creates_the_meta_object_when_it_is_missing():
    document = a_state()
    del document["meta"]
    assert state.set_meta(document, "loop_delay", 600)["meta"] == {"loop_delay": 600}


def test_defer_records_the_issue_and_its_reason():
    assert state.defer(a_state(), 4, "needs hardware")["deferred"] == [
        {"issue": 4, "reason": "needs hardware"}
    ]


def test_defer_replaces_an_earlier_entry_for_the_same_issue():
    document = state.defer(state.defer(a_state(), 4, "first"), 4, "second")
    assert document["deferred"] == [{"issue": 4, "reason": "second"}]


def test_defer_keeps_the_other_issues_in_place():
    document = state.defer(state.defer(a_state(), 4, "hardware"), 5, "closed")
    assert [entry["issue"] for entry in document["deferred"]] == [4, 5]


# --- validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("issues", "expected"), [("1", [1]), ("1,3", [1, 3]), ("10,2,300", [10, 2, 300])]
)
def test_parse_issues_accepts_comma_separated_numbers(issues, expected):
    assert state.parse_issues(issues) == expected


@pytest.mark.parametrize("issues", ["", "2, 3", "one", "1,", ",1", "1;2", "-1"])
def test_parse_issues_refuses_anything_else(issues):
    with pytest.raises(state.Invalid) as raised:
        state.parse_issues(issues)
    assert "comma-separated numbers" in raised.value.message
    assert raised.value.status == 2


@pytest.mark.parametrize("order", ["", "1", "12"])
def test_check_order_accepts_a_position_from_one(order):
    assert state.check_order(order) is None


@pytest.mark.parametrize("order", ["0", "01", "-1", "two", "1.5"])
def test_check_order_refuses_zero_and_non_numbers(order):
    with pytest.raises(state.Invalid) as raised:
        state.check_order(order)
    assert "--order must be a number from 1" in raised.value.message


def test_check_layer_accepts_a_stack_layer_with_stack_and_order():
    assert state.check_layer("stack", "parser", "1", "") is None
    assert state.check_layer("stack", "parser", "2", "wktr-1-parser") is None


@pytest.mark.parametrize(("stack", "order"), [("", "1"), ("parser", ""), ("", "")])
def test_check_layer_refuses_a_stack_layer_missing_either(stack, order):
    with pytest.raises(state.Invalid) as raised:
        state.check_layer("stack", stack, order, "")
    assert "needs --stack and --order" in raised.value.message


def test_check_layer_accepts_an_independent_stream_with_none_of_them():
    assert state.check_layer("independent", "", "", "") is None


@pytest.mark.parametrize(
    ("stack", "order", "base"), [("parser", "", ""), ("", "1", ""), ("", "", "main")]
)
def test_check_layer_refuses_stack_flags_on_an_independent_stream(stack, order, base):
    with pytest.raises(state.Invalid) as raised:
        state.check_layer("independent", stack, order, base)
    assert "are for --kind stack" in raised.value.message


def test_check_choice_accepts_the_documented_vocabularies():
    assert state.check_choice("stack", "high", "opus") is None


def test_check_choice_refuses_an_unknown_kind():
    with pytest.raises(state.Invalid) as raised:
        state.check_choice("chain", "low", "haiku")
    assert "kind must be independent or stack, got: chain" in raised.value.message


def test_check_choice_refuses_an_effort_with_no_stream_agent():
    with pytest.raises(state.Invalid) as raised:
        state.check_choice("independent", "max", "haiku")
    assert "effort must be low, medium, or high, got: max" in raised.value.message


def test_check_choice_refuses_an_unknown_model_alias():
    with pytest.raises(state.Invalid) as raised:
        state.check_choice("independent", "low", "gpt")
    assert "model must be one of" in raised.value.message
    assert "got: gpt" in raised.value.message


@pytest.mark.parametrize("field", state.FIELDS)
def test_check_field_accepts_every_documented_field(field):
    assert state.check_field(field) is None


@pytest.mark.parametrize("field", ["id", "statu", "issues", "kind", ""])
def test_check_field_refuses_anything_else(field):
    """Including id, issues and kind: they are set at add-stream time, not after."""
    with pytest.raises(state.Invalid) as raised:
        state.check_field(field)
    assert f"unknown field: {field}" in raised.value.message


@pytest.mark.parametrize("status", state.STATUSES)
def test_check_status_accepts_every_documented_status(status):
    assert state.check_status(status, "set") is None


def test_check_status_names_the_command_that_refused():
    with pytest.raises(state.Invalid) as raised:
        state.check_status("runing", "list-streams")
    assert raised.value.message.startswith("list-streams: invalid status: runing")


def test_numeric_field_value_reads_a_number():
    assert state.numeric_field_value("pr", "10") == 10


def test_numeric_field_value_reads_null_as_a_cleared_field():
    assert state.numeric_field_value("pr", "null") is None


@pytest.mark.parametrize("value", ["twelve", "", "1.5", "-1", "10a"])
def test_numeric_field_value_refuses_anything_else(value):
    with pytest.raises(state.Invalid) as raised:
        state.numeric_field_value("pr", value)
    assert "pr takes a number or null" in raised.value.message


@pytest.mark.parametrize(
    ("text", "expected"),
    [("[10, 12]", [10, 12]), ("null", None), ("false", False), ('"s"', "s"), ("{}", {})],
)
def test_json_value_parses_valid_json(text, expected):
    assert state.json_value(text) == expected


@pytest.mark.parametrize("text", ["", "{oops", "[10,", "'s'"])
def test_json_value_refuses_invalid_json(text):
    with pytest.raises(state.Invalid) as raised:
        state.json_value(text)
    assert "not valid JSON" in raised.value.message


@pytest.mark.parametrize("text", ["NaN", "Infinity", "-Infinity", "[1, NaN]"])
def test_json_value_refuses_the_constants_that_are_not_json(text):
    """Python's parser accepts all three; no other reader of the file would."""
    with pytest.raises(state.Invalid) as raised:
        state.json_value(text)
    assert "not valid JSON" in raised.value.message


def test_meta_value_keeps_an_ordinary_field_a_string():
    assert state.meta_value("plan_path", "/tmp/plan.md") == "/tmp/plan.md"
    assert state.meta_value("plan_path", "600") == "600"


@pytest.mark.parametrize(("value", "expected"), [("60", 60), ("0600", 600), ("3600", 3600)])
def test_meta_value_stores_loop_delay_as_a_number_in_range(value, expected):
    assert state.meta_value("loop_delay", value) == expected


@pytest.mark.parametrize("value", ["5m", "thirty", "59", "3601", "-1", ""])
def test_meta_value_refuses_a_loop_delay_outside_the_range(value):
    with pytest.raises(state.Invalid) as raised:
        state.meta_value("loop_delay", value)
    assert "integer from 60 to 3600" in raised.value.message
