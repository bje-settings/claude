"""Black-box tests for ft-resolve.py.

Ported from `spec/field-test/resolve_spec.sh`, one test per example. "requires
jq" did not come across; there is no jq to require.
"""

from __future__ import annotations

import json

import pytest
from conftest import (
    FT_RESOLVE,
    ft_fixture_git,
    ft_fixture_installed_plugins,
    ft_fixture_marketplaces,
    ft_fixture_repo,
)

pytestmark = pytest.mark.usefixtures("ft_sandbox")


def resolved(result):
    assert result.status == 0, result.stderr
    return json.loads(result.stdout)


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_RESOLVE, "--help")
    assert result.status == 0
    assert "ft-resolve.py <target>" in result.stdout


def test_exits_2_with_usage_when_given_nothing(run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_RESOLVE)
    assert result.status == 2
    assert "ft-resolve.py <target>" in result.stderr


def test_rejects_more_than_one_target(run_script):
    """rejects more than one target"""
    result = run_script(FT_RESOLVE, "gh:sync", "gh:shepherd")
    assert result.status == 2
    assert "expected one target" in result.stderr


def test_rejects_a_target_that_is_not_plugin_skill(run_script):
    """rejects a target that is not plugin:skill"""
    result = run_script(FT_RESOLVE, "gh:shepherd:extra")
    assert result.status == 2
    assert "must be plugin:skill" in result.stderr


# --- workflow targets --------------------------------------------------------


def test_refuses_a_workflow_target(run_script):
    """refuses a workflow target with exit 5 rather than guessing"""
    result = run_script(FT_RESOLVE, "workflow:nightly-release")
    assert result.status == 5
    assert "not supported yet" in result.stderr


def test_refuses_a_workflow_target_however_capitalised(run_script):
    """refuses it however it is capitalised"""
    result = run_script(FT_RESOLVE, "Workflow:NightlyRelease")
    assert result.status == 5
    assert "not supported yet" in result.stderr


# --- a plugin skill ----------------------------------------------------------


def test_resolves_a_plugin_skill(ft_sandbox, run_script):
    """resolves it through the installed plugin registry"""
    document = resolved(run_script(FT_RESOLVE, "gh:shepherd"))
    assert document["kind"] == "plugin-skill"
    assert document["plugin"] == "gh"
    assert document["skill"] == "shepherd"
    assert document["version"] == "0.2.0"
    assert document["path"] == str(ft_sandbox.install_dir / "skills" / "shepherd" / "SKILL.md")


def test_names_the_marketplace(run_script):
    """names the marketplace the copy came from"""
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["marketplace"] == "bje"


def test_reports_the_commit_and_repo_of_a_local_marketplace(ft_sandbox, run_script):
    """reports the commit and repo when the marketplace is a local checkout"""
    ft_fixture_repo(ft_sandbox.plugin_checkout, "acme-org/plugins")
    sha = ft_fixture_git(ft_sandbox.plugin_checkout, "rev-parse", "HEAD").strip()
    document = resolved(run_script(FT_RESOLVE, "gh:shepherd"))
    assert document["commit"] == sha
    assert document["repo"] == "acme-org/plugins"


def test_reads_an_https_remote(ft_sandbox, run_script):
    """reads an https remote as well as an ssh one"""
    ft_fixture_repo(ft_sandbox.plugin_checkout, "acme-org/plugins", "https")
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["repo"] == "acme-org/plugins"


def test_leaves_commit_and_repo_null_when_the_path_is_gone(run_script):
    """leaves the commit and repo null when the local marketplace path is gone"""
    document = resolved(run_script(FT_RESOLVE, "gh:shepherd"))
    assert document["commit"] is None
    assert document["repo"] is None


def test_leaves_commit_and_repo_null_for_a_github_marketplace(ft_sandbox, run_script):
    """leaves the commit and repo null when the marketplace came from github"""
    ft_fixture_marketplaces(ft_sandbox.marketplaces, ft_sandbox.plugin_checkout, "github")
    document = resolved(run_script(FT_RESOLVE, "gh:shepherd"))
    assert document["marketplace_path"] is None
    assert document["commit"] is None
    assert document["repo"] is None


def test_leaves_them_null_without_a_marketplace_file(ft_sandbox, run_script):
    """leaves them null when there is no marketplace file at all"""
    ft_sandbox.marketplaces.unlink()
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["commit"] is None


def test_leaves_them_null_when_the_marketplace_file_is_not_json(ft_sandbox, run_script):
    """leaves them null when the marketplace file is not JSON

    New with the port: jq's failure was swallowed with 2>/dev/null, and the
    reader has to swallow the same thing to keep resolving the target.
    """
    ft_sandbox.marketplaces.write_text("nope")
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["marketplace_path"] is None


def test_leaves_the_repo_null_without_an_origin(ft_sandbox, run_script):
    """leaves the repo null when the local checkout has no origin"""
    ft_fixture_repo(ft_sandbox.plugin_checkout, "acme-org/plugins", "none")
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["repo"] is None


def test_refuses_a_plugin_that_is_not_installed(run_script):
    """refuses a plugin that is not installed"""
    result = run_script(FT_RESOLVE, "nosuch:skill")
    assert result.status == 3
    assert "no installed plugin provides nosuch:skill" in result.stderr


def test_refuses_a_plugin_installed_without_that_skill(run_script):
    """refuses a plugin that is installed without that skill"""
    result = run_script(FT_RESOLVE, "gh:nosuch")
    assert result.status == 3
    assert "no installed plugin provides gh:nosuch" in result.stderr


def test_says_the_registry_shape_is_wrong(ft_sandbox, run_script):
    """says the registry shape is wrong rather than blaming a missing plugin

    A registry whose shape has changed is not a plugin that is not installed, and
    "install it and try again" is advice that cannot fix it.
    """
    ft_sandbox.installed_plugins.write_text('{"plugins": [{"name": "gh"}]}')
    result = run_script(FT_RESOLVE, "gh:shepherd")
    assert result.status == 3
    assert "its shape is not what this expects" in result.stderr


def test_refuses_when_the_registry_is_missing(ft_sandbox, run_script):
    """refuses when the registry is missing"""
    ft_sandbox.installed_plugins.unlink()
    result = run_script(FT_RESOLVE, "gh:shepherd")
    assert result.status == 3
    assert "no installed plugins file" in result.stderr


def test_refuses_when_the_registry_is_not_json(ft_sandbox, run_script):
    """refuses when the registry is not JSON"""
    ft_sandbox.installed_plugins.write_text("nope")
    result = run_script(FT_RESOLVE, "gh:shepherd")
    assert result.status == 3
    assert "not valid JSON" in result.stderr


def test_skips_a_copy_that_does_not_carry_the_skill(ft_sandbox, run_script):
    """skips a copy that does not carry the skill and takes one that does"""
    ft_fixture_installed_plugins(ft_sandbox.installed_plugins, ft_sandbox.install_dir)
    registry = json.loads(ft_sandbox.installed_plugins.read_text())
    registry["plugins"]["gh@bje"] = [
        {"scope": "user", "installPath": str(ft_sandbox.path / "stale"), "version": "0.1.0"}
    ] + registry["plugins"]["gh@bje"]
    ft_sandbox.installed_plugins.write_text(json.dumps(registry))
    assert resolved(run_script(FT_RESOLVE, "gh:shepherd"))["version"] == "0.2.0"


# --- a command or skill by bare name -----------------------------------------


@pytest.fixture
def project(ft_sandbox):
    """A checkout to resolve a bare name from; the script is run inside it."""
    return ft_fixture_repo(ft_sandbox.path / "project", "acme-org/widgets")


def test_finds_a_project_command_first(project, run_script):
    """finds a project command first"""
    (project / ".claude" / "commands").mkdir(parents=True)
    (project / ".claude" / "commands" / "tidy.md").write_text("")
    document = resolved(run_script(FT_RESOLVE, "tidy", cwd=project))
    assert document["kind"] == "command"
    assert document["path"] == str(project / ".claude" / "commands" / "tidy.md")


def test_falls_back_to_a_user_command(ft_sandbox, project, run_script):
    """falls back to a user command"""
    (ft_sandbox.user_dir / "commands").mkdir(parents=True)
    (ft_sandbox.user_dir / "commands" / "tidy.md").write_text("")
    document = resolved(run_script(FT_RESOLVE, "tidy", cwd=project))
    assert document["path"] == str(ft_sandbox.user_dir / "commands" / "tidy.md")


def test_falls_back_to_a_project_skill(project, run_script):
    """falls back to a project skill"""
    (project / ".claude" / "skills" / "tidy").mkdir(parents=True)
    (project / ".claude" / "skills" / "tidy" / "SKILL.md").write_text("")
    document = resolved(run_script(FT_RESOLVE, "tidy", cwd=project))
    assert document["kind"] == "skill"
    assert document["path"] == str(project / ".claude" / "skills" / "tidy" / "SKILL.md")


def test_falls_back_to_a_user_skill(ft_sandbox, project, run_script):
    """falls back to a user skill"""
    (ft_sandbox.user_dir / "skills" / "tidy").mkdir(parents=True)
    (ft_sandbox.user_dir / "skills" / "tidy" / "SKILL.md").write_text("")
    document = resolved(run_script(FT_RESOLVE, "tidy", cwd=project))
    assert document["path"] == str(ft_sandbox.user_dir / "skills" / "tidy" / "SKILL.md")


def test_refuses_a_name_it_cannot_place(project, run_script):
    """refuses a name it cannot place, rather than guessing"""
    result = run_script(FT_RESOLVE, "tidy", cwd=project)
    assert result.status == 3
    assert "cannot resolve tidy" in result.stderr


def test_falls_back_to_home_for_the_registry(ft_sandbox, run_script):
    """looks under HOME when the test overrides are not set

    The defaults are what an installed plugin actually runs with; only a test
    ever sets FT_INSTALLED_PLUGINS.
    """
    for name in ("FT_INSTALLED_PLUGINS", "FT_MARKETPLACES", "FT_USER_DIR"):
        ft_sandbox.delenv(name)
    document = resolved(run_script(FT_RESOLVE, "gh:shepherd"))
    assert document["marketplace"] == "bje"
