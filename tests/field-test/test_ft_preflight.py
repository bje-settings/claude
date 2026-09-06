"""Black-box tests for ft-preflight.py.

Ported from `spec/field-test/preflight_spec.sh`. The answer here is what the
harden skill stops on, so every arm that can produce a hint keeps its own test:
gh absent, a login that failed, a registry that is not there, one that cannot be
read, and each plugin missing on its own.

Two examples did not come across. "exits 4 in plain text when jq is missing" is
gone with the check itself: nothing in this plugin shells out to jq any more.
The registry arms are covered here once each and per-arm in `test_preflight.py`.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FT_PREFLIGHT

pytestmark = pytest.mark.usefixtures("ft_sandbox")


@pytest.fixture
def registry(ft_sandbox):
    """Readers and writers for the installed-plugins file the preflight reads."""

    class Registry:
        path = ft_sandbox.installed_plugins

        def document(self):
            return json.loads(self.path.read_text(encoding="utf-8"))

        def write(self, document):
            self.path.write_text(json.dumps(document), encoding="utf-8")

        def with_workstreams(self, key="workstreams@bje"):
            document = self.document()
            document["plugins"][key] = [
                {"scope": "user", "installPath": str(ft_sandbox.install_dir), "version": "0.1.0"}
            ]
            self.write(document)

        def without(self, key):
            document = self.document()
            del document["plugins"][key]
            self.write(document)

    return Registry()


def answer(result):
    return json.loads(result.stdout)


def ids(result):
    return [entry["id"] for entry in answer(result)["missing"]]


def test_passes_when_everything_is_installed(registry, run_script):
    """passes when everything is installed"""
    registry.with_workstreams()
    result = run_script(FT_PREFLIGHT)
    assert result.status == 0
    assert answer(result) == {"ok": True, "missing": []}


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_PREFLIGHT, "--help")
    assert result.status == 0
    assert "Usage:" in result.stdout


def test_rejects_stray_arguments(run_script):
    """rejects stray arguments"""
    result = run_script(FT_PREFLIGHT, "--verbose")
    assert result.status == 2
    assert "unexpected argument" in result.stderr


def test_reports_the_workstreams_plugin(run_script):
    """reports the workstreams plugin, which harden dispatches its worker from"""
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    assert ids(result) == ["workstreams"]
    assert "/plugin install workstreams@bje" in result.stdout


def test_reports_pr_review_toolkit(registry, run_script):
    """reports pr-review-toolkit, which the review pass runs"""
    registry.with_workstreams()
    registry.without("pr-review-toolkit@official")
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    assert ids(result) == ["pr-review-toolkit"]


def test_reports_both_plugins_when_there_is_no_registry_at_all(registry, run_script):
    """reports both plugins when there is no registry at all"""
    registry.path.unlink()
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    assert ids(result) == ["workstreams", "pr-review-toolkit"]


def test_reports_an_unreadable_registry_as_itself(registry, run_script):
    """reports an unreadable registry as itself, not as two missing plugins"""
    registry.path.write_text("nope", encoding="utf-8")
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    assert ids(result) == ["registry-unreadable"]


def test_reports_a_failed_gh_login_check_with_what_gh_said(registry, ft_sandbox, run_script):
    """reports a failed gh login check with the login command and what gh said"""
    registry.with_workstreams()
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    entry = answer(result)["missing"][0]
    assert entry["id"] == "gh-auth"
    assert entry["hint"] == "gh auth login"
    assert entry["detail"] == "gh: simulated failure"


def test_reports_a_registry_whose_plugins_is_not_an_object(registry, run_script):
    """reports a registry whose plugins is not an object as unreadable, not as two missing"""
    registry.write({"version": 2, "plugins": []})
    result = run_script(FT_PREFLIGHT)
    assert result.status == 1
    assert ids(result) == ["registry-unreadable"]
    assert "no plugins object" in result.stdout


def test_accepts_workstreams_installed_from_another_marketplace(registry, run_script):
    """accepts workstreams installed from another marketplace"""
    registry.with_workstreams("workstreams@fork")
    result = run_script(FT_PREFLIGHT)
    assert result.status == 0
    assert answer(result)["ok"] is True


def test_reports_gh_itself_when_it_is_not_installed(registry, ft_sandbox, run_script):
    """reports gh itself when it is not installed"""
    registry.with_workstreams()
    result = run_script(FT_PREFLIGHT, env={"PATH": ft_sandbox.sandbox.path_without("gh")})
    assert result.status == 1
    assert ids(result) == ["gh"]
    assert "brew install gh" in result.stdout


def test_falls_back_to_the_registry_under_home(registry, ft_sandbox, run_script):
    """finds Claude's registry under HOME when FT_INSTALLED_PLUGINS is unset

    The override exists for the tests; the path the plugin actually reads in a
    real session is the one built from HOME, and nothing else exercises it.
    """
    registry.with_workstreams()
    ft_sandbox.delenv("FT_INSTALLED_PLUGINS")
    result = run_script(FT_PREFLIGHT)
    assert result.status == 0
    assert answer(result)["ok"] is True


def test_a_registry_it_cannot_open_reads_as_unreadable(registry, run_script):
    """a file that is there but unreadable is the unreadable arm, not the absent one

    The shell tested `-f` and handed the path to jq, which failed the same way.
    Reporting it as two missing plugins would send someone to install what they
    already have.
    """
    os.chmod(registry.path, 0o000)
    try:
        result = run_script(FT_PREFLIGHT)
    finally:
        os.chmod(registry.path, 0o600)
    assert result.status == 1
    assert ids(result) == ["registry-unreadable"]


def test_a_reader_that_closed_early_is_not_a_failure(run_with_no_reader):
    """`ft-preflight.py | head` is the caller's business, not a failure here."""
    completed = run_with_no_reader(FT_PREFLIGHT)
    assert completed.returncode == 0
    assert completed.stderr == b""
