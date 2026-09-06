"""Unit tests for plugins/field-test/scripts/lib/names.py, one per arm.

The module holds what `lib/names.jq` decided: which collected strings become
redaction table entries, which placeholder each takes, and the order they are
applied in. Ordering is the arm that matters most: `owner/name` replaced after
`owner` reads `<org>/name`, and the repository is still named.
"""

from __future__ import annotations

from conftest import SCRIPTS, load_lib_module

names = load_lib_module("field_test_lib_names", SCRIPTS / "lib" / "names.py")

FIELDS = {
    "remote": "git@github.com:acme-org/widgets.git",
    "repo": "acme-org/widgets",
    "owner": "acme-org",
    "name": "widgets",
    "branches": ["main", "wktr-9-widget-fix"],
    "paths": ["/checkout/widgets"],
    "refs": ["#12"],
    "subjects": ["fix: the widget drops its last field"],
}


def placeholder_for(table, value):
    return next(entry["placeholder"] for entry in table["placeholders"] if entry["value"] == value)


# --- refs_in -----------------------------------------------------------------


def test_refs_in_finds_every_reference():
    assert names.refs_in("closes #12 and #7") == ["#12", "#7"]


def test_refs_in_deduplicates():
    assert names.refs_in("#12 again #12") == ["#12"]


def test_refs_in_of_text_with_no_reference_is_empty():
    assert names.refs_in("nothing here") == []


def test_refs_in_of_nothing_at_all_is_empty():
    assert names.refs_in(None) == []


# --- lines -------------------------------------------------------------------


def test_lines_drops_the_empty_ones():
    assert names.lines("main\n\nwktr-9-fix\n") == ["main", "wktr-9-fix"]


def test_lines_of_nothing_is_empty():
    assert names.lines("") == []


# --- names_table -------------------------------------------------------------


def test_every_category_gets_its_placeholder():
    table = names.names_table(FIELDS)
    assert placeholder_for(table, FIELDS["remote"]) == "<remote-url>"
    assert placeholder_for(table, "acme-org/widgets") == "<org>/<repo>"
    assert placeholder_for(table, "/checkout/widgets") == "<path>"
    assert placeholder_for(table, FIELDS["subjects"][0]) == "<commit>"
    assert placeholder_for(table, "wktr-9-widget-fix") == "<branch>"
    assert placeholder_for(table, "#12") == "<pr>"
    assert placeholder_for(table, "acme-org") == "<org>"
    assert placeholder_for(table, "widgets") == "<repo>"


def test_the_table_is_ordered_longest_value_first():
    """owner/name has to be replaced before owner, or the repository is half-named."""
    table = names.names_table(FIELDS)
    lengths = [len(entry["value"]) for entry in table["placeholders"]]
    assert lengths == sorted(lengths, reverse=True)


def test_a_one_character_value_is_dropped():
    """It would match inside every other word."""
    table = names.names_table(dict(FIELDS, name="w"))
    assert "w" not in [entry["value"] for entry in table["placeholders"]]


def test_an_empty_value_is_dropped():
    table = names.names_table(dict(FIELDS, remote=""))
    assert "" not in [entry["value"] for entry in table["placeholders"]]


def test_a_two_character_value_is_kept():
    """A repository really can be called `cm`; redaction bounds it instead."""
    table = names.names_table(dict(FIELDS, name="cm"))
    assert placeholder_for(table, "cm") == "<repo>"


def test_a_value_collected_twice_keeps_the_first_placeholder():
    table = names.names_table(dict(FIELDS, branches=["acme-org"]))
    assert placeholder_for(table, "acme-org") == "<branch>"
    assert [entry["value"] for entry in table["placeholders"]].count("acme-org") == 1


def test_a_value_that_is_not_a_string_is_dropped():
    table = names.names_table(dict(FIELDS, branches=[12, "main"]))
    assert 12 not in [entry["value"] for entry in table["placeholders"]]


def test_the_repo_is_null_when_the_remote_named_none():
    assert names.names_table(dict(FIELDS, repo=""))["repo"] is None


def test_the_repo_is_reported_when_there_is_one():
    assert names.names_table(FIELDS)["repo"] == "acme-org/widgets"
