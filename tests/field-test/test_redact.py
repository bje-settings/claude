"""Unit tests for plugins/field-test/scripts/lib/redact.py, one per arm.

The module holds what the `REDACT_JQ` program in ft-redact.sh decided: which
values are replaced everywhere, which only where they stand as a word, and what
a names file has to look like before a redaction can be claimed at all. Each arm
gets a name here, because the whole program counted as one covered line and a
narrowed condition moved no number (`.claude/rules/type-jq.md`).
"""

from __future__ import annotations

import pytest
from conftest import SCRIPTS, load_lib_module

redact = load_lib_module("field_test_lib_redact", SCRIPTS / "lib" / "redact.py")

TABLE = [{"value": "acme-org/widgets", "placeholder": "<org>/<repo>"}]


def table_file(tmp_path, document):
    import json

    path = tmp_path / "names.json"
    path.write_text(json.dumps(document))
    return str(path)


# --- replace_bounded ---------------------------------------------------------


def test_a_short_value_is_replaced_where_it_stands_alone():
    assert redact.replace_bounded("in the run directory", "run", "<repo>") == (
        "in the <repo> directory"
    )


def test_a_short_value_is_left_alone_inside_a_longer_word():
    assert redact.replace_bounded("a runner is running", "run", "<repo>") == ("a runner is running")


def test_a_short_value_at_the_start_of_the_text_is_replaced():
    assert redact.replace_bounded("run it", "run", "<repo>") == "<repo> it"


def test_a_short_value_at_the_end_of_the_text_is_replaced():
    assert redact.replace_bounded("do a run", "run", "<repo>") == "do a <repo>"


def test_a_value_that_does_not_appear_leaves_the_text_alone():
    assert redact.replace_bounded("nothing here", "run", "<repo>") == "nothing here"


def test_a_short_value_is_replaced_at_every_place_it_stands_alone():
    assert redact.replace_bounded("run and run", "run", "<r>") == "<r> and <r>"


# --- apply_table -------------------------------------------------------------


def test_a_long_value_is_replaced_wherever_it_appears():
    assert redact.apply_table("see acme-org/widgets/pulls", TABLE) == "see <org>/<repo>/pulls"


def test_a_short_value_in_the_table_is_replaced_only_as_a_word():
    table = [{"value": "cm", "placeholder": "<repo>"}]
    assert redact.apply_table("the cm and cmake", table) == "the <repo> and cmake"


def test_the_table_is_applied_in_order_so_the_longest_wins():
    table = [
        {"value": "acme-org/widgets", "placeholder": "<org>/<repo>"},
        {"value": "acme-org", "placeholder": "<org>"},
    ]
    assert redact.apply_table("acme-org/widgets", table) == "<org>/<repo>"


def test_an_entry_with_no_value_is_skipped():
    """A table written by hand can hold anything; an empty value matches everywhere."""
    assert redact.apply_table("text", [{"value": "", "placeholder": "<x>"}]) == "text"


def test_an_entry_whose_value_is_not_a_string_is_skipped():
    assert redact.apply_table("text", [{"value": 12, "placeholder": "<x>"}]) == "text"


# --- load_table --------------------------------------------------------------


def test_load_table_returns_the_placeholders(tmp_path):
    path = table_file(tmp_path, {"repo": "acme-org/widgets", "placeholders": TABLE})
    assert redact.load_table(path) == TABLE


def test_load_table_refuses_a_file_that_is_not_there(tmp_path):
    with pytest.raises(redact.RedactError) as error:
        redact.load_table(str(tmp_path / "nope.json"))
    assert error.value.status == 2


def test_load_table_refuses_a_file_that_is_not_json(tmp_path):
    path = tmp_path / "names.json"
    path.write_text("nope")
    with pytest.raises(redact.RedactError) as error:
        redact.load_table(str(path))
    assert "not valid JSON" in error.value.message


def test_load_table_refuses_json_that_is_not_a_table(tmp_path):
    """The one failure that publishes a real name under a line saying it was removed."""
    path = table_file(tmp_path, {"target": "gh:shepherd"})
    with pytest.raises(redact.RedactError) as error:
        redact.load_table(path)
    assert "not a names table" in error.value.message


def test_load_table_refuses_json_that_is_not_an_object(tmp_path):
    path = table_file(tmp_path, [])
    with pytest.raises(redact.RedactError):
        redact.load_table(path)


def test_check_present_accepts_a_file_that_is_there(tmp_path):
    path = table_file(tmp_path, {"placeholders": []})
    assert redact.check_present(path) is None


# --- redact ------------------------------------------------------------------


def test_redact_appends_the_note(tmp_path):
    path = table_file(tmp_path, {"placeholders": TABLE})
    assert redact.redact("acme-org/widgets\n", path, False) == (
        "<org>/<repo>\n\n> " + redact.NOTE + "\n"
    )


def test_redact_inside_the_enterprise_is_the_identity(tmp_path):
    path = table_file(tmp_path, {"placeholders": TABLE})
    assert redact.redact("acme-org/widgets\n", path, True) == "acme-org/widgets\n"
