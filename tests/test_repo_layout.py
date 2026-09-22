"""Repo-wide conventions that only a test can hold.

Each of these is a rule written down somewhere in prose -- CLAUDE.md or a file
under .claude/rules/ -- whose failure mode is silent. Prose does not survive a
refactor by someone who has not read it, and none of these would show up as a
broken test anywhere else.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
SCRIPTS = ROOT / "scripts"


def plugin_dirs():
    return sorted(path for path in PLUGINS.iterdir() if (path / ".claude-plugin").is_dir())


def test_finds_plugins_to_check():
    """finds plugins to check

    The same guard tests/test_skills.py carries, for the same reason: a glob that
    matches nothing makes every check below pass while enforcing nothing.
    """
    assert plugin_dirs()


def test_every_plugin_carries_the_same_license_as_the_root():
    """keeps one LICENSE, copied identically into every plugin

    Each plugin directory carries its own so it is self-describing when it is
    distributed on its own. Four copies that must agree is a drift shape worth
    asserting rather than trusting.
    """
    canonical = (ROOT / "LICENSE").read_bytes()
    assert b"MIT License" in canonical

    wrong = []
    for plugin in plugin_dirs():
        license_file = plugin / "LICENSE"
        if not license_file.is_file():
            wrong.append(f"{plugin.name}: no LICENSE")
        elif license_file.read_bytes() != canonical:
            wrong.append(f"{plugin.name}: LICENSE differs from the root copy")
    assert wrong == []


def test_every_plugin_manifest_declares_its_license():
    """declares the licence in the manifest as well as beside it

    `claude plugin validate --strict` accepts the field; a reader looking at the
    manifest alone should not have to go hunting for the file.
    """
    missing = []
    for plugin in plugin_dirs():
        manifest = json.loads(
            (plugin / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        if manifest.get("license") != "MIT":
            missing.append(f"{plugin.name}: license is {manifest.get('license')!r}")
    assert missing == []


def test_repo_tooling_never_touches_sys_path():
    """keeps root scripts/ off sys.path

    A plugin script reaches its shared code with sys.path.insert, and the root
    conftest cleans up after it -- but only for entries whose parent parts
    contain "plugins". A root `scripts` entry would survive that sweep and could
    shadow a plugin's own `lib` in a later test, which fails somewhere else
    entirely and looks like anything but its cause.

    So repo tooling is self-contained. See .claude/rules/type-py.md.
    """
    if not SCRIPTS.is_dir():
        return
    hits = []
    for script in sorted(SCRIPTS.rglob("*.py")):
        # Parsed, not grepped. These scripts are required to explain in a comment
        # why they do not do this, and a text search would flag the explanation.
        tree = ast.parse(script.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in ("insert", "append"):
                continue
            target = node.func.value
            if (
                isinstance(target, ast.Attribute)
                and target.attr == "path"
                and isinstance(target.value, ast.Name)
                and target.value.id == "sys"
            ):
                hits.append(f"{script.relative_to(ROOT)}:{node.lineno}")
    assert hits == []
