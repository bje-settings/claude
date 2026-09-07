"""Unit tests for `plugins/field-test/scripts/lib/harden.py`.

The jq the shell ran and the validation it did with padded-string tests, one
test per arm. `test_ft_harden_state.py` drives the same logic black-box through
the script; these name the arms the coverage report can now see.
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

harden = load_lib_module("field_test_lib_harden", SCRIPTS / "lib" / "harden.py")


def run_state(*paths):
    document = harden.new_state("gh:shepherd", "2026-01-02T03:04:05Z", "opus", "high")
    for path in paths:
        harden.add_target(document, path, "")
    return document


# --- naming ------------------------------------------------------------------


def test_the_skill_is_the_target_every_command_takes():
    assert harden.check_skill("path", "gh:shepherd") == "gh:shepherd"


@pytest.mark.parametrize("skill", ["", "--force"])
def test_a_missing_skill_names_the_command_that_wanted_it(skill):
    with pytest.raises(harden.Invalid) as caught:
        harden.check_skill("add-target", skill)
    assert caught.value.message == "add-target needs a <plugin:skill> target"
    assert caught.value.status == 2


def test_a_target_that_is_not_plugin_skill_is_refused():
    with pytest.raises(harden.Invalid) as caught:
        harden.check_skill("path", "shepherd")
    assert "must be plugin:skill" in caught.value.message


def test_the_file_name_folds_the_colon_and_any_slash():
    assert harden.file_name("gh:shepherd") == "gh__shepherd.json"
    assert harden.file_name("gh/fork:shepherd") == "gh_fork__shepherd.json"


# --- shape -------------------------------------------------------------------


@pytest.mark.parametrize(
    "document",
    [
        {"targets": []},
        {"targets": [{"path": "/repos/widgets"}]},
    ],
)
def test_a_document_with_a_targets_array_is_a_run(document):
    assert harden.is_state(document) is True


@pytest.mark.parametrize(
    ("document", "why"),
    [
        ([], "another tool's JSON that happens to sit at the same path"),
        ({"nope": True}, "no targets at all"),
        ({"targets": {}}, "targets that is not an array"),
        ({"targets": ["/repos/widgets"]}, "a target that is not an object to index"),
    ],
)
def test_anything_else_is_not(document, why):
    assert harden.is_state(document) is False, why


def test_a_new_run_starts_empty_at_the_size_it_was_given():
    document = harden.new_state("gh:shepherd", "2026-01-02T03:04:05Z", "sonnet", "medium")
    assert document == {
        "version": 1,
        "skill": "gh:shepherd",
        "created": "2026-01-02T03:04:05Z",
        "model": "sonnet",
        "effort": "medium",
        "targets": [],
    }


# --- init validation ---------------------------------------------------------


@pytest.mark.parametrize("model", ["haiku", "sonnet", "opus", "fable", "inherit"])
def test_every_model_alias_is_accepted(model):
    assert harden.check_model(model) == model


def test_a_model_outside_the_list_is_refused():
    with pytest.raises(harden.Invalid) as caught:
        harden.check_model("gpt")
    assert caught.value.message == (
        "init: model must be one of haiku sonnet opus fable inherit got: gpt"
    )


@pytest.mark.parametrize("effort", ["low", "medium", "high"])
def test_every_effort_is_accepted(effort):
    assert harden.check_effort(effort) == effort


def test_an_effort_outside_the_list_is_refused():
    with pytest.raises(harden.Invalid) as caught:
        harden.check_effort("extreme")
    assert "effort must be low, medium, or high, got: extreme" in caught.value.message


# --- add-target --------------------------------------------------------------


def test_a_target_starts_pending_in_its_first_phase():
    document = harden.add_target(run_state(), "/repos/widgets", "acme-org/widgets")
    assert document["targets"] == [
        {
            "path": "/repos/widgets",
            "repo": "acme-org/widgets",
            "status": "pending",
            "phase": "field-test",
            "issues": [],
            "pr": None,
            "review_rounds": None,
            "merge_sha": None,
            "question": None,
            "summary": None,
        }
    ]


def test_a_target_with_no_repo_gets_a_null_one():
    document = harden.add_target(run_state(), "/repos/widgets", "")
    assert document["targets"][0]["repo"] is None


def test_the_order_targets_were_given_is_the_plan():
    document = run_state("/repos/widgets", "/repos/gadgets")
    assert [target["path"] for target in document["targets"]] == [
        "/repos/widgets",
        "/repos/gadgets",
    ]


def test_a_path_already_listed_is_a_no_op_rather_than_a_duplicate():
    """A re-run of the same setup must not double the work."""
    document = run_state("/repos/widgets")
    harden.set_field(document, "/repos/widgets", "status", "done")
    harden.add_target(document, "/repos/widgets", "")
    assert len(document["targets"]) == 1
    assert document["targets"][0]["status"] == "done"


# --- set validation ----------------------------------------------------------


@pytest.mark.parametrize("field", harden.FIELDS)
def test_every_field_in_the_schema_is_accepted(field):
    assert harden.check_field(field) == field


def test_a_field_outside_the_schema_is_refused_so_a_typo_cannot_create_one():
    with pytest.raises(harden.Invalid) as caught:
        harden.check_field("stauts")
    assert caught.value.message == (
        "set: unknown field: stauts (one of: status phase issues pr review_rounds merge_sha"
        " question summary repo )"
    )


@pytest.mark.parametrize("status", harden.STATUSES)
def test_every_status_is_accepted(status):
    assert harden.check_status(status) == status


@pytest.mark.parametrize("value", ["finished", "pending done"])
def test_a_status_outside_the_list_is_refused(value):
    """ "pending done" would match a padded substring test and then be a status
    `next` skips without a word for it."""
    with pytest.raises(harden.Invalid) as caught:
        harden.check_status(value)
    assert f"set: invalid status: {value}" in caught.value.message


@pytest.mark.parametrize("phase", harden.PHASES)
def test_every_phase_is_accepted(phase):
    assert harden.check_phase(phase) == phase


@pytest.mark.parametrize("value", ["merging", "fix review"])
def test_a_phase_outside_the_list_is_refused(value):
    with pytest.raises(harden.Invalid) as caught:
        harden.check_phase(value)
    assert f"set: invalid phase: {value}" in caught.value.message


@pytest.mark.parametrize("field", harden.NUMERIC_FIELDS)
@pytest.mark.parametrize(("raw", "expected"), [("44", 44), ("0", 0), ("null", None)])
def test_a_number_field_is_stored_as_a_number_or_cleared(field, raw, expected):
    assert harden.numeric_value(field, raw) == expected


@pytest.mark.parametrize("field", harden.NUMERIC_FIELDS)
@pytest.mark.parametrize("raw", ["forty-four", "44.0", "-1", ""])
def test_anything_else_is_not_a_number(field, raw):
    """A count written as a word compares against a number and starts the loop over."""
    with pytest.raises(harden.Invalid) as caught:
        harden.numeric_value(field, raw)
    assert f"{field} takes a number or null" in caught.value.message


def test_the_issues_are_stored_as_the_array_they_are():
    assert harden.issues_value("[25,32]") == [25, 32]


def test_valid_json_that_is_not_an_array_is_named_as_that():
    with pytest.raises(harden.Invalid) as caught:
        harden.issues_value('{"a": 1}')
    assert caught.value.message == 'set: issues takes a JSON array, got: {"a": 1}'


def test_the_json_null_is_refused_for_issues_too():
    """The shell stored it, because jq -e reports false for null and its array
    check never saw it. An issues field holding null is a list the loop cannot
    read back."""
    with pytest.raises(harden.Invalid):
        harden.issues_value("null")


def test_invalid_json_for_issues_is_named_as_invalid_json():
    with pytest.raises(harden.Invalid) as caught:
        harden.issues_value("[25,")
    assert "not valid JSON" in caught.value.message


@pytest.mark.parametrize("raw", ["", "{", "not json"])
def test_a_json_value_that_does_not_parse_is_refused(raw):
    with pytest.raises(harden.Invalid) as caught:
        harden.json_value(raw)
    assert caught.value.message == f"set: --json value is not valid JSON: {raw}"


def test_a_json_value_that_parses_comes_back_parsed():
    assert harden.json_value('{"a": 1}') == {"a": 1}


@pytest.mark.parametrize(
    ("field", "raw", "mode", "expected"),
    [
        ("status", "done", "", "done"),
        ("phase", "fix", "", "fix"),
        ("pr", "44", "", 44),
        ("review_rounds", "1", "", 1),
        ("review_rounds", "null", "", None),
        ("issues", "[25]", "", [25]),
        ("summary", "all clean", "", "all clean"),
        ("summary", '"quoted"', "--json", "quoted"),
        ("question", "", "", ""),
    ],
)
def test_the_value_stored_for_each_field(field, raw, mode, expected):
    assert harden.field_value(field, raw, mode) == expected


# --- set and next ------------------------------------------------------------


def test_setting_a_field_replaces_only_that_targets_copy():
    document = run_state("/repos/widgets", "/repos/gadgets")
    harden.set_field(document, "/repos/gadgets", "status", "done")
    assert document["targets"][0]["status"] == "pending"
    assert document["targets"][1]["status"] == "done"


def test_a_target_that_was_never_added_fails_rather_than_being_created():
    with pytest.raises(harden.Invalid) as caught:
        harden.set_field(run_state("/repos/widgets"), "/repos/gadgets", "status", "done")
    assert caught.value.message == "set: unknown target: /repos/gadgets"
    assert caught.value.status == 1


# --- bump --------------------------------------------------------------------


def test_bump_adds_one_and_reports_what_the_field_now_holds():
    document = run_state("/repos/widgets")
    assert harden.bump_field(document, "/repos/widgets", "review_rounds") == 1
    assert harden.bump_field(document, "/repos/widgets", "review_rounds") == 2
    assert document["targets"][0]["review_rounds"] == 2


def test_bump_treats_a_null_count_as_zero():
    """Every target is added with review_rounds null; the first bump is 1."""
    document = run_state("/repos/widgets")
    assert document["targets"][0]["review_rounds"] is None
    assert harden.bump_field(document, "/repos/widgets", "review_rounds") == 1


def test_bump_treats_an_absent_count_as_zero():
    """A target added before the field existed carries no count at all."""
    document = run_state("/repos/widgets")
    del document["targets"][0]["review_rounds"]
    assert harden.bump_field(document, "/repos/widgets", "review_rounds") == 1


def test_bump_writes_only_the_named_target():
    document = run_state("/repos/widgets", "/repos/gadgets")
    harden.bump_field(document, "/repos/gadgets", "review_rounds")
    assert [target["review_rounds"] for target in document["targets"]] == [None, 1]


def test_bump_refuses_a_target_that_was_never_added():
    with pytest.raises(harden.Invalid) as caught:
        harden.bump_field(run_state("/repos/widgets"), "/repos/gadgets", "review_rounds")
    assert caught.value.message == "bump: unknown target: /repos/gadgets"
    assert caught.value.status == 1


@pytest.mark.parametrize("value", ["two", True, 1.5, [1]])
def test_bump_refuses_a_count_that_is_not_a_whole_number(value):
    """Refused rather than replaced: a field holding something else means the
    file was written by something other than this script, and overwriting it
    would lose whatever that was. `True` is an int in Python and is not a count."""
    document = run_state("/repos/widgets")
    document["targets"][0]["review_rounds"] = value
    with pytest.raises(harden.Invalid) as caught:
        harden.bump_field(document, "/repos/widgets", "review_rounds")
    assert caught.value.status == 1
    assert "review_rounds is not a number on /repos/widgets" in caught.value.message


def test_every_field_that_holds_a_number_can_be_bumped():
    for field in harden.NUMERIC_FIELDS:
        assert harden.check_numeric_field(field) is None


@pytest.mark.parametrize("field", ["status", "summary", "issues"])
def test_bump_refuses_a_field_that_does_not_hold_a_number(field):
    with pytest.raises(harden.Invalid) as caught:
        harden.check_numeric_field(field)
    assert caught.value.message == (
        f"bump: {field} is not a numeric field (one of: pr review_rounds )"
    )
    assert caught.value.status == 2


@pytest.mark.parametrize("status", ["pending", "running", "paused"])
def test_next_returns_a_target_that_is_not_finished(status):
    """A paused target comes back on purpose: it is waiting on a decision, and
    stepping over it buries the question under the next round."""
    document = run_state("/repos/widgets", "/repos/gadgets")
    harden.set_field(document, "/repos/widgets", "status", status)
    assert harden.next_target(document) == "/repos/widgets"


@pytest.mark.parametrize("status", ["done", "failed"])
def test_next_steps_over_a_target_that_is_finished(status):
    document = run_state("/repos/widgets", "/repos/gadgets")
    harden.set_field(document, "/repos/widgets", "status", status)
    assert harden.next_target(document) == "/repos/gadgets"


def test_next_has_nothing_to_say_once_every_target_is_finished():
    document = run_state("/repos/widgets", "/repos/gadgets")
    for path in ("/repos/widgets", "/repos/gadgets"):
        harden.set_field(document, path, "status", "done")
    assert harden.next_target(document) == ""


def test_next_has_nothing_to_say_for_a_run_with_no_targets():
    assert harden.next_target(run_state()) == ""


@pytest.mark.parametrize(
    ("status", "why"),
    [
        ("pending done", "two statuses in one value, which `set` refuses and a hand edit does not"),
        (None, "a target written without a status at all"),
        ("skipped", "a word from another vocabulary"),
    ],
)
def test_next_refuses_a_status_it_cannot_read_rather_than_stepping_over_it(status, why):
    """A status outside the vocabulary is neither finished nor unfinished, and
    `next` printing nothing is what the skill reads as "every target is done"."""
    document = {"targets": [{"path": "/repos/widgets", "status": status}]}
    with pytest.raises(harden.Invalid) as caught:
        harden.next_target(document)
    assert "/repos/widgets: status is not one of" in caught.value.message, why
    assert caught.value.status == 1


def test_next_refuses_a_path_that_is_not_a_string():
    document = {"targets": [{"path": None, "status": "pending"}]}
    with pytest.raises(harden.Invalid) as caught:
        harden.next_target(document)
    assert caught.value.message == "next: target 1: path is not a string, got: null"
    assert caught.value.status == 1


def test_next_refuses_a_corrupt_target_it_has_not_reached_yet():
    """A target later in the list is one the loop would step over next round."""
    document = {
        "targets": [
            {"path": "/repos/widgets", "status": "pending"},
            {"path": "/repos/gadgets", "status": "nope"},
        ]
    }
    with pytest.raises(harden.Invalid) as caught:
        harden.next_target(document)
    assert "/repos/gadgets: status is not one of" in caught.value.message
