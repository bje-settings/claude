"""Black-box tests for ws-preflight.py.

Ported from the 16 examples in `spec/workstreams/ws_preflight_spec.sh`, whose
`It` description each ported test carries in its docstring. One did not come
across: "exits 4 in plain text when jq is missing, since it cannot build JSON".
The port builds JSON itself, so jq is no longer a dependency of any workstreams
script and the check and its exit-4 path are gone; the test below asserts the
opposite instead, that a preflight with jq absent from PATH still passes.

The "tool is not installed" cases use `sandbox.path_without`, which builds a
PATH of the real tools minus the named ones, in place of `ws_path_without` from
the deleted `spec/spec_helper.sh`.

Two examples that ran the script from a directory of their own making -- the
repo-local skill and the git fallback -- drive `check_gh_stack_skill` and
`repo_root` in this process instead. A Python child started from outside the
checkout resolves coverage.py's relative `omit` patterns against its own working
directory, which silently mis-reports every file in the run; `git` is not a
Python child, so calling it from a temporary repository is safe.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest
from conftest import (
    ROOT,
    STUB_BIN,
    WS_PREFLIGHT,
    load_lib_module,
    ws_fixture_extensions,
    ws_fixture_installed_plugins,
)

pytestmark = pytest.mark.usefixtures("ws_sandbox")


def ids(result):
    return [entry["id"] for entry in json.loads(result.stdout)["missing"]]


def hints(result):
    return [entry["hint"] for entry in json.loads(result.stdout)["missing"]]


def test_passes_when_everything_is_installed(ws_preflight):
    """passes when everything is installed"""
    result = ws_preflight()
    assert result.status == 0
    assert '"ok": true' in result.stdout
    assert '"missing": []' in result.stdout


def test_prints_usage_for_help(ws_preflight):
    """prints usage for --help"""
    for flag in ("-h", "--help"):
        result = ws_preflight(flag)
        assert result.status == 0
        assert "Usage:" in result.stdout


def test_rejects_stray_arguments(ws_preflight):
    """rejects stray arguments"""
    result = ws_preflight("--verbose")
    assert result.status == 2
    assert "unexpected argument" in result.stderr


def test_reports_a_missing_gh_login_with_the_login_command(ws_preflight):
    """reports a missing gh login with the login command"""
    result = ws_preflight(env={"WS_GH_FIXTURE_NOAUTH": "1"})
    assert result.status == 1
    assert ids(result) == ["gh-auth"]
    assert hints(result) == ["gh auth login"]


def test_reports_the_gh_stack_extension_when_gh_does_not_list_it(ws_preflight, ws_sandbox):
    """reports the gh-stack extension when gh does not list it, exactly by repo"""
    ws_fixture_extensions(ws_sandbox.gh_dir / "extensions.txt", "without-stack")
    result = ws_preflight()
    assert result.status == 1
    assert ids(result) == ["gh-stack-extension"]
    assert "gh extension install github/gh-stack" in result.stdout


def test_reports_a_broken_gh_apart_from_a_missing_extension(ws_preflight):
    """reports a broken gh apart from a missing extension, keeping the error"""
    result = ws_preflight(env={"WS_GH_FIXTURE_FAIL": "1"})
    assert result.status == 1
    assert "gh-broken" in ids(result)
    assert "gh extension list failed: gh: simulated failure" in result.stdout
    assert "gh-stack-extension" not in result.stdout


def test_reports_the_gh_stack_skill_when_neither_the_user_nor_the_repo_has_it(
    ws_preflight, ws_sandbox
):
    """reports the gh-stack skill when neither the user nor the repo has it

    "the repo" is this checkout, which the script is run from and which carries
    no `.claude/skills/gh-stack`; the shell spec depended on the same thing. The
    fixtures cannot move the script somewhere else to be sure of it: a child
    process started from outside the checkout resolves coverage.py's own
    relative `omit` patterns against that directory instead, and every later
    file in the report comes out wrong."""
    assert not (ROOT / ".claude" / "skills" / "gh-stack").exists()
    shutil.rmtree(ws_sandbox.home / ".claude" / "skills" / "gh-stack")
    result = ws_preflight()
    assert result.status == 1
    assert ids(result) == ["gh-stack-skill"]
    assert "gh skill install github/gh-stack" in result.stdout


def test_accepts_a_gh_stack_skill_delivered_by_an_installed_plugin(ws_preflight, ws_sandbox):
    """accepts a gh-stack skill delivered by an installed plugin"""
    shutil.rmtree(ws_sandbox.home / ".claude" / "skills" / "gh-stack")
    document = json.loads(ws_sandbox.installed_plugins.read_text(encoding="utf-8"))
    document["plugins"]["gh-stack@some-marketplace"] = [{"scope": "user"}]
    ws_sandbox.installed_plugins.write_text(json.dumps(document), encoding="utf-8")
    result = ws_preflight()
    assert result.status == 0
    assert '"ok": true' in result.stdout


def test_honours_ws_skills_dir(ws_preflight, ws_sandbox):
    """honours WS_SKILLS_DIR"""
    shutil.rmtree(ws_sandbox.home / ".claude" / "skills" / "gh-stack")
    elsewhere = ws_sandbox.path / "elsewhere" / "gh-stack"
    elsewhere.mkdir(parents=True)
    (elsewhere / "SKILL.md").write_text("", encoding="utf-8")
    result = ws_preflight(env={"WS_SKILLS_DIR": str(ws_sandbox.path / "elsewhere")})
    assert result.status == 0
    assert '"ok": true' in result.stdout


def test_reports_pr_review_toolkit_when_the_plugin_list_lacks_it(ws_preflight, ws_sandbox):
    """reports pr-review-toolkit when the plugin list lacks it"""
    ws_fixture_installed_plugins(ws_sandbox.installed_plugins, "without-review")
    result = ws_preflight()
    assert result.status == 1
    assert ids(result) == ["pr-review-toolkit"]
    assert "/plugin install pr-review-toolkit@claude-plugins-official" in result.stdout


def test_reports_pr_review_toolkit_when_the_plugin_list_does_not_exist(ws_preflight, ws_sandbox):
    """reports pr-review-toolkit when the plugin list does not exist"""
    ws_sandbox.installed_plugins.unlink()
    result = ws_preflight()
    assert result.status == 1
    assert "pr-review-toolkit" in ids(result)


def test_says_the_plugin_list_is_corrupt_rather_than_saying_to_install_again(
    ws_preflight, ws_sandbox
):
    """says the plugin list is corrupt rather than telling the user to install again"""
    ws_sandbox.installed_plugins.write_text("{bad", encoding="utf-8")
    result = ws_preflight()
    assert result.status == 1
    assert "installed plugins file is not valid JSON" in result.stdout
    assert "/plugin install" not in result.stdout


def test_says_the_plugin_list_is_corrupt_when_its_top_level_is_not_an_object(
    ws_preflight, ws_sandbox
):
    """Not in the shell spec, where `jq -e .` called a file holding a bare
    `null` valid and then reported the key lookup failure as "not installed".
    Nothing but a JSON object can be Claude's plugin registry."""
    ws_sandbox.installed_plugins.write_text("null", encoding="utf-8")
    result = ws_preflight()
    assert result.status == 1
    assert "installed plugins file is not valid JSON" in result.stdout
    assert "/plugin install" not in result.stdout


def test_lists_every_missing_item_at_once_in_check_order(ws_preflight, ws_sandbox):
    """lists every missing item at once, in check order"""
    ws_fixture_extensions(ws_sandbox.gh_dir / "extensions.txt", "without-stack")
    shutil.rmtree(ws_sandbox.home / ".claude" / "skills" / "gh-stack")
    ws_fixture_installed_plugins(ws_sandbox.installed_plugins, "without-review")
    result = ws_preflight(env={"WS_GH_FIXTURE_NOAUTH": "1"})
    assert result.status == 1
    assert ids(result) == [
        "gh-auth",
        "gh-stack-extension",
        "gh-stack-skill",
        "pr-review-toolkit",
    ]


def test_reports_gh_itself_when_it_is_not_on_path(ws_preflight, sandbox):
    """reports gh itself when it is not on PATH, and skips the checks that need it"""
    result = ws_preflight(env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "gh" in ids(result)
    assert "brew install gh" in result.stdout
    assert "gh-auth" not in result.stdout
    assert "gh-stack-extension" not in result.stdout


def test_passes_with_jq_absent_from_path(ws_preflight, sandbox):
    """Replaces the shell spec's exit-4 example. No workstreams script runs jq
    any more, so a preflight without one reports nothing missing."""
    path = sandbox.path_without("jq")
    result = ws_preflight(env={"PATH": f"{STUB_BIN}{os.pathsep}{path}"})
    assert result.status == 0
    assert '"ok": true' in result.stdout


def test_prints_two_space_indented_json_with_one_trailing_newline(ws_preflight):
    """Not in the shell spec, where `jq` decided the shape. Both skills read
    this output, so the shape is the contract."""
    result = ws_preflight()
    assert result.status == 0
    assert result.stdout == '{\n  "ok": true,\n  "missing": []\n}\n'


# --- arms no fixture can provoke ----------------------------------------------


def load_ws_preflight_module():
    """ws-preflight.py loaded in-process, for the races no PATH can build."""
    return load_lib_module("workstreams_ws_preflight_module", WS_PREFLIGHT)


def test_reports_pr_review_toolkit_when_plugins_is_not_an_object(ws_preflight, ws_sandbox):
    """Not in the shell spec, where `.plugins | keys[]` on a list errored and
    the arm was reached only by accident. A registry whose `plugins` is not an
    object holds no plugin, so nothing is installed."""
    ws_sandbox.installed_plugins.write_text('{"plugins": []}', encoding="utf-8")
    result = ws_preflight()
    assert result.status == 1
    assert ids(result) == ["pr-review-toolkit"]
    assert "/plugin install pr-review-toolkit@claude-plugins-official" in result.stdout


@pytest.mark.parametrize(
    ("document", "expected"),
    [
        (None, False),
        ({}, False),
        ({"plugins": None}, False),
        ({"plugins": []}, False),
        ({"plugins": {"gh-stack-anything@m": []}}, False),
        ({"plugins": {"gh-stack@m": []}}, True),
    ],
)
def test_has_plugin(document, expected):
    assert load_ws_preflight_module().has_plugin(document, "gh-stack") is expected


def test_gh_extension_list_reports_a_gh_that_cannot_be_run(monkeypatch):
    """gh was on PATH a moment ago and is not now: an error to report, not a
    traceback. Unreachable from a fixture, which can only take gh away before
    the run starts, in which case the extension check never happens."""
    module = load_ws_preflight_module()
    monkeypatch.setattr(
        module.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("gone"))
    )
    assert module.gh_extension_list() == ("", "gone")


def test_gh_authenticated_is_false_when_gh_cannot_be_run(monkeypatch):
    """The same race, on the auth check."""
    module = load_ws_preflight_module()
    monkeypatch.setattr(
        module.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("gone"))
    )
    assert module.gh_authenticated() is False


def test_accepts_a_repo_local_gh_stack_skill_from_any_directory(ws_sandbox, monkeypatch):
    """accepts a repo-local gh-stack skill from any directory in the repo"""
    module = load_ws_preflight_module()
    shutil.rmtree(ws_sandbox.home / ".claude" / "skills" / "gh-stack")
    repo = ws_sandbox.path / "repo"
    (repo / ".claude" / "skills" / "gh-stack").mkdir(parents=True)
    (repo / ".claude" / "skills" / "gh-stack" / "SKILL.md").write_text("", encoding="utf-8")
    deep = repo / "deep" / "er"
    deep.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(deep)
    missing = []
    module.check_gh_stack_skill(missing, None)
    assert missing == []


def test_repo_root_falls_back_to_the_working_directory_outside_a_repository(
    ws_sandbox, monkeypatch
):
    """Not in the shell spec. Outside a checkout `git rev-parse` fails, and the
    check has to answer from the working directory rather than from nothing."""
    module = load_ws_preflight_module()
    outside = ws_sandbox.path / "outside"
    outside.mkdir()
    monkeypatch.chdir(outside)
    assert module.repo_root() == os.getcwd()


def test_repo_root_falls_back_to_the_working_directory_when_git_is_not_installed(monkeypatch):
    """Not in the shell spec. `git rev-parse` is how the repo-local skill is
    found; without git at all the check must still answer, not raise."""
    module = load_ws_preflight_module()
    monkeypatch.setattr(
        module.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no git"))
    )
    assert module.repo_root() == os.getcwd()
