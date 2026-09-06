#!/usr/bin/env python3
"""ft-resolve.py: work out what a field-test target actually is, before running it.

  ft-resolve.py <target>

Targets:
  plugin:skill   an installed plugin's skill, found through Claude's own registry
  name           a project or user command (.claude/commands/<name>.md), then a
                 project or user skill (.claude/skills/<name>/SKILL.md)
  workflow:name  refused: see below

Prints one JSON object on success:
  {kind, target, plugin, skill, marketplace, path, version, install_path,
   marketplace_path, commit, repo}
`path` is the file that defines the target. `commit` and `repo` are filled only
when the marketplace was added from a local directory, which is the case the
issues care about: a finding is worth filing against a checkout you can fix.

Workflow targets are unsupported in v1 and exit 5 rather than being guessed at.
Whether a background workflow agent's tool calls fire this plugin's hooks in the
parent session, and under which session_id, is unknown; a field test that
silently records nothing is worse than one that refuses.

Exit 0 resolved, 2 on usage, 3 unresolved, 5 workflow target.

Overridable for tests:
  FT_INSTALLED_PLUGINS   default $HOME/.claude/plugins/installed_plugins.json
  FT_MARKETPLACES        default $HOME/.claude/plugins/known_marketplaces.json
  FT_USER_DIR            default $HOME/.claude

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, gitinfo, registry  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-resolve.py"


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def home_path(*parts) -> str:
    return os.path.join(os.environ.get("HOME") or "", *parts)


def emit(kind, target, plugin, skill, marketplace, path, version, install, mpath, commit, repo):
    """One resolved target, with every field that was not filled in as null."""
    document = {
        "kind": kind,
        "target": target,
        "plugin": plugin or None,
        "skill": skill or None,
        "marketplace": marketplace or None,
        "path": path,
        "version": version or None,
        "install_path": install or None,
        "marketplace_path": mpath or None,
        "commit": commit or None,
        "repo": repo or None,
    }
    sys.stdout.write(json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n")


def read_json(path: str):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def resolve_plugin_skill(target: str, installed: str, markets: str):
    plugin, _, skill = target.partition(":")
    if not plugin or not skill or ":" in skill:
        die(f"a plugin target must be plugin:skill, got: {target}", 2)
    if not os.path.isfile(installed):
        die(f"no installed plugins file at {installed}", 3)
    try:
        document = read_json(installed)
    except (OSError, ValueError):
        die(f"installed plugins file is not valid JSON: {installed}", 3)

    # Read before the search so a registry whose shape has changed is told apart
    # from a plugin that is not installed: "install it and try again" cannot fix
    # the first one.
    try:
        rows = registry.installed_rows(document, plugin)
    except registry.RegistryError as error:
        die(f"could not read {installed}; its shape is not what this expects: {error}", 3)

    # A plugin can be installed from more than one marketplace and at more than
    # one scope; the first copy that actually carries the skill is the one under
    # test.
    found = None
    for marketplace, install, version in rows:
        if not install:
            continue
        if os.path.isfile(os.path.join(install, "skills", skill, "SKILL.md")):
            found = (marketplace, install, version)
            break
    if found is None:
        die(f"no installed plugin provides {target}; install it and try again", 3)
    marketplace, install, version = found

    mpath = ""
    if os.path.isfile(markets):
        try:
            mpath = registry.marketplace_path(read_json(markets), marketplace)
        except (OSError, ValueError):
            mpath = ""
    commit = repo = ""
    if mpath and os.path.isdir(mpath):
        commit = gitinfo.git(mpath, "rev-parse", "HEAD")
        repo = gitinfo.owner_repo_of(gitinfo.origin_url(mpath))
    emit(
        "plugin-skill",
        target,
        plugin,
        skill,
        marketplace,
        os.path.join(install, "skills", skill, "SKILL.md"),
        version,
        install,
        mpath,
        commit,
        repo,
    )


def resolve_bare_name(target: str, user_dir: str):
    project_dir = gitinfo.git(os.getcwd(), "rev-parse", "--show-toplevel") or os.getcwd()
    candidates = (
        ("command", os.path.join(project_dir, ".claude", "commands", target + ".md")),
        ("command", os.path.join(user_dir, "commands", target + ".md")),
        ("skill", os.path.join(project_dir, ".claude", "skills", target, "SKILL.md")),
        ("skill", os.path.join(user_dir, "skills", target, "SKILL.md")),
    )
    for kind, path in candidates:
        if os.path.isfile(path):
            emit(kind, target, "", target, "", path, "", "", "", "", "")
            return
    die(
        f"cannot resolve {target} as a plugin skill, a command, or a skill; "
        "give it as plugin:skill or install it",
        3,
    )


def run(argv):
    first = argv[1] if len(argv) > 1 else ""
    if first in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if first == "":
        sys.stderr.write(__doc__)
        return 2
    if len(argv) != 2:
        die(f"expected one target, got {len(argv) - 1}", 2)

    target = first
    if target.lower().startswith("workflow:") or target.lower().startswith("workflow "):
        die(
            f"workflow targets are not supported yet: {target} "
            "(hooks may not see a background workflow agent's tool calls)",
            5,
        )

    installed = os.environ.get("FT_INSTALLED_PLUGINS") or home_path(
        ".claude", "plugins", "installed_plugins.json"
    )
    markets = os.environ.get("FT_MARKETPLACES") or home_path(
        ".claude", "plugins", "known_marketplaces.json"
    )
    user_dir = os.environ.get("FT_USER_DIR") or home_path(".claude")

    if ":" in target:
        resolve_plugin_skill(target, installed, markets)
    else:
        resolve_bare_name(target, user_dir)
    return 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather than
        # in the interpreter's own shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The docstring promises this script's own message, not a traceback. An
        # arm nobody anticipated still reports one line and exit 1, the way every
        # anticipated one does. The class name is there so an exception with an
        # empty message still names what happened instead of printing a bare colon.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
