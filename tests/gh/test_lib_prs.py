"""Direct tests for `lib/prs.py`, the jq program that read merge proof.

Each arm gets its own test. The black-box tests reach these through the script,
but a filter that quietly stopped excluding forks would be a force delete of
somebody's branch, so the arms are asserted here too.
"""

from __future__ import annotations

from lib import prs

MINE = {"headRefName": "feature", "headRefOid": "abc", "isCrossRepository": False}
FORK = {"headRefName": "feature", "headRefOid": "abc", "isCrossRepository": True}


def test_own_rows_drops_forks():
    assert prs.own_rows([MINE, FORK]) == [MINE]


def test_own_rows_keeps_a_row_with_no_cross_repository_field():
    """A missing field is not a fork; treating it as one would keep every branch."""
    row = {"headRefName": "feature", "headRefOid": "abc"}
    assert prs.own_rows([row]) == [row]


def test_has_match_wants_the_name_and_the_commit():
    assert prs.has_match([MINE], "feature", "abc")


def test_has_match_rejects_a_moved_tip():
    """The regression the commit check exists for: same name, different commit."""
    assert not prs.has_match([MINE], "feature", "def")


def test_has_match_rejects_another_name():
    assert not prs.has_match([MINE], "other", "abc")


def test_names_branch_ignores_the_commit():
    assert prs.names_branch([MINE], "feature")
    assert not prs.names_branch([MINE], "other")


def test_the_fields_asked_for_include_the_fork_flag():
    """Without isCrossRepository every fork would look like a local branch."""
    assert "isCrossRepository" in prs.FIELDS.split(",")
