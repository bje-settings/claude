"""Ported from `spec/gh/discover_spec.sh`.

The nine examples there exercised the shell function directly; these exercise
`discover_repos` the same way, plus the script form the skills call.
"""

from __future__ import annotations

import os

import pytest
from conftest import DISCOVER
from lib import discover


def real(path):
    return os.path.realpath(str(path))


def test_yields_the_checkout_root_for_a_repository(gh):
    """yields the checkout root when the target is a repository"""
    assert discover.discover_repos(gh.repo) == [real(gh.repo)]


def test_yields_the_checkout_root_from_a_subdirectory(gh):
    """yields the checkout root when the target is a subdirectory of a repository"""
    (gh.repo / "src" / "deep").mkdir(parents=True)
    assert discover.discover_repos(gh.repo / "src" / "deep") == [real(gh.repo)]


def test_fans_out_over_immediate_subdirectories(gh):
    """fans out over immediate subdirectories that are checkout roots"""
    gh.create_at(gh.path / "fan", "bbb")
    gh.create_at(gh.path / "fan", "aaa")
    (gh.path / "fan" / "plain").mkdir()
    found = discover.discover_repos(gh.path / "fan")
    assert [os.path.basename(path) for path in found] == ["aaa", "bbb"]


def test_does_not_recurse_below_one_level(gh):
    """does not recurse below one level"""
    (gh.path / "fan" / "parent").mkdir(parents=True)
    gh.create_at(gh.path / "fan" / "parent", "nested")
    assert discover.discover_repos(gh.path / "fan") == []


def test_skips_a_subdirectory_that_is_not_a_checkout_root(gh):
    """skips a subdirectory that is inside a repository but not its root

    A checkout root next to an entry that resolves to a subdirectory of the
    sandbox repo: git reports that repo's root, which is not the entry itself, so
    it must not count as a checkout of its own.
    """
    gh.create_at(gh.path / "fan", "real")
    (gh.repo / "src").mkdir()
    os.symlink(str(gh.repo / "src"), str(gh.path / "fan" / "inner"))
    found = discover.discover_repos(gh.path / "fan")
    assert [os.path.basename(path) for path in found] == ["real"]


def test_resolves_symlinks(gh):
    """resolves symlinks so the comparison agrees with git

    git reports resolved paths; a logical path would never match and every repo
    under a symlinked parent (like /tmp on macOS) would be skipped.
    """
    gh.create_at(gh.path / "fan", "a")
    os.symlink(str(gh.path / "fan"), str(gh.path / "link"))
    found = discover.discover_repos(gh.path / "link")
    assert len(found) == 1
    assert found[0].endswith("/fan/a")


def test_yields_nothing_when_there_are_no_repositories(gh):
    """prints nothing and succeeds when there are no repositories"""
    (gh.path / "empty").mkdir()
    assert discover.discover_repos(gh.path / "empty") == []


def test_fails_when_the_target_is_not_a_directory(gh):
    """fails when the target is not a directory"""
    with pytest.raises(NotADirectoryError):
        discover.discover_repos(gh.path / "nope")


def test_defaults_to_the_current_directory(gh, monkeypatch):
    """defaults to the current directory"""
    monkeypatch.chdir(gh.repo)
    assert discover.discover_repos() == [real(gh.repo)]


# --- the script form ----------------------------------------------------------


def test_the_script_prints_one_root_per_line(gh, run_script):
    gh.create_at(gh.path / "fan", "bbb")
    gh.create_at(gh.path / "fan", "aaa")
    result = run_script(DISCOVER, gh.path / "fan")
    assert result.status == 0
    assert [os.path.basename(line) for line in result.stdout.split()] == ["aaa", "bbb"]


def test_the_script_exits_1_for_a_target_that_is_not_a_directory(gh, run_script):
    result = run_script(DISCOVER, gh.path / "nope")
    assert result.status == 1
    assert result.stdout == ""
    # The status alone leaves a caller running this over several targets with
    # nothing to report about which one was wrong.
    assert f"not a directory: {gh.path / 'nope'}" in result.stderr


def test_the_script_defaults_to_the_current_directory(gh, run_script, monkeypatch):
    monkeypatch.chdir(gh.repo)
    result = run_script(DISCOVER)
    assert result.status == 0
    assert result.stdout.strip() == real(gh.repo)


def test_skips_a_hidden_directory(gh):
    """A dotfile is not a repository the fan-out should find.

    The shell glob this replaces was "$target"/*/, which never matched one, and
    the fan-out fixtures park their bare origins in a hidden directory precisely
    because of that: finding them would make every fan-out scan report the
    origins too.
    """
    gh.create_at(gh.path / "fan", "visible")
    gh.create_at(gh.path / "fan", ".hidden")
    found = discover.discover_repos(gh.path / "fan")
    assert [os.path.basename(path) for path in found] == ["visible"]


def test_the_script_prints_under_a_single_byte_locale(gh, run_script):
    """A repository path can hold any byte, and a non-UTF-8 locale must not turn
    printing one into a UnicodeEncodeError that loses the whole listing.

    One name is deliberately outside ASCII: an ASCII-only path encodes fine under
    ISO-8859-1 and would pass with no reconfigure at all. What the name comes
    back as depends on the platform (macOS decodes file names as UTF-8 whatever
    the locale, Linux follows the locale), so the assertion is that the listing
    survives: the ASCII sibling is printed and nothing crashed.
    """
    gh.create_at(gh.path / "fan", "visible")
    gh.create_at(gh.path / "fan", "caf\u00e9-\u4ed3\u5e93")
    result = run_script(
        DISCOVER,
        gh.path / "fan",
        env={"LC_ALL": "en_US.ISO8859-1", "PYTHONIOENCODING": "ISO-8859-1", "PYTHONUTF8": "0"},
    )
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert "/visible" in result.stdout


def test_a_missing_git_is_no_repositories_rather_than_a_crash(gh, sandbox, monkeypatch):
    """git absent answers the same as a directory outside any checkout."""
    monkeypatch.setenv("PATH", sandbox.path_without("git"))
    assert discover.discover_repos(gh.repo) == []
