"""Unit tests for `plugins/field-test/scripts/lib/preflight.py`.

One per arm of the registry read the shell did with four jq invocations. The
distinction each arm draws is the point: telling someone to install two plugins
they already have, because the registry file is unreadable, sends them the wrong
way entirely.

`test_ft_preflight.py` reaches the same arms end to end; these are what name them.
"""

from __future__ import annotations

import json

from conftest import SCRIPTS, load_lib_module

preflight = load_lib_module("field_test_lib_preflight", SCRIPTS / "lib" / "preflight.py")

PATH = "/home/someone/.claude/plugins/installed_plugins.json"


def registry(*names):
    return json.dumps({"version": 2, "plugins": {name: [{"scope": "user"}] for name in names}})


def ids(entries):
    return [entry["id"] for entry in entries]


# --- excerpt and missing -----------------------------------------------------


def test_an_excerpt_is_one_line():
    assert preflight.excerpt("first\nsecond\n") == "first second "


def test_an_excerpt_is_cut_to_length():
    assert len(preflight.excerpt("x" * 400)) == preflight.EXCERPT


def test_an_entry_carries_a_detail_only_when_there_is_one():
    assert preflight.missing("gh", "brew install gh") == {"id": "gh", "hint": "brew install gh"}
    assert preflight.missing("gh", "hint", "why")["detail"] == "why"


# --- registry_findings, one test per arm -------------------------------------


def test_no_registry_at_all_reports_both_plugins():
    assert ids(preflight.registry_findings(PATH, None)) == ["workstreams", "pr-review-toolkit"]


def test_an_unreadable_registry_is_reported_as_itself():
    """Not as two missing plugins: the fix is a different one."""
    entries = preflight.registry_findings(PATH, "nope")
    assert ids(entries) == ["registry-unreadable"]
    assert entries[0]["hint"] == f"installed plugins file is not valid JSON: {PATH}"


def test_a_registry_holding_the_json_null_is_unreadable_too():
    """`jq -e .` reported false for it, and the shell named it invalid on that."""
    entries = preflight.registry_findings(PATH, "null")
    assert ids(entries) == ["registry-unreadable"]
    # The hint says which arm it came from, and null parsed: it is a document
    # with no plugins object as much as it is invalid JSON, so the assertion
    # names the one this arm actually prints.
    assert entries[0]["hint"] == f"installed plugins file is not valid JSON: {PATH}"


def test_a_registry_that_could_not_be_opened_carries_the_reason():
    """The id the skill branches on, with the operating system's own words on it."""
    entries = preflight.registry_findings(PATH, PermissionError(13, "Permission denied"))
    assert ids(entries) == ["registry-unreadable"]
    assert entries[0]["hint"] == f"installed plugins file: {PATH}"
    assert "Permission denied" in entries[0]["detail"]


def test_no_path_to_read_at_all_is_unreadable_not_two_missing_plugins():
    """HOME unset says nothing about what is installed, so it must not answer for it."""
    entries = preflight.registry_findings("", None)
    assert ids(entries) == ["registry-unreadable"]
    assert "HOME is not set" in entries[0]["hint"]


def test_a_registry_whose_plugins_is_not_an_object_is_unreadable():
    entries = preflight.registry_findings(PATH, '{"version": 2, "plugins": []}')
    assert ids(entries) == ["registry-unreadable"]
    assert "no plugins object" in entries[0]["hint"]


def test_a_registry_that_is_not_an_object_at_all_is_unreadable():
    assert ids(preflight.registry_findings(PATH, "[]")) == ["registry-unreadable"]


def test_a_registry_with_both_plugins_reports_nothing():
    assert (
        preflight.registry_findings(PATH, registry("workstreams@bje", "pr-review-toolkit@x")) == []
    )


def test_a_registry_missing_one_reports_only_that_one():
    entries = preflight.registry_findings(PATH, registry("workstreams@bje"))
    assert ids(entries) == ["pr-review-toolkit"]
    assert entries[0]["hint"] == "/plugin install pr-review-toolkit@claude-plugins-official"


def test_a_plugin_from_another_marketplace_still_counts():
    """A fork of workstreams under another name is still workstreams to the
    agents that dispatch it; which marketplace it came from is not this
    script's business."""
    assert preflight.has_plugin({"plugins": {"workstreams@fork": []}}, "workstreams")


def test_a_name_that_only_starts_the_same_does_not_count():
    assert not preflight.has_plugin({"plugins": {"workstreams-extra@bje": []}}, "workstreams")


# --- report ------------------------------------------------------------------


def test_an_empty_list_is_ok():
    assert preflight.report([]) == {"ok": True, "missing": []}


def test_anything_missing_is_not():
    entry = preflight.missing("gh", "brew install gh")
    assert preflight.report([entry]) == {"ok": False, "missing": [entry]}
