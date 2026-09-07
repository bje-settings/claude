#!/usr/bin/env python3
"""ws-preflight.py: check that everything the workstreams skills depend on is present.

Usage: ws-preflight.py

Checks gh, gh auth, the gh-stack extension and skill, and pr-review-toolkit.

Prints one JSON object: {"ok": true|false, "missing": [{"id": ..., "hint": ...}]}
and exits 0 when everything is present, 1 when anything is missing, 2 on usage.
The skills print each hint verbatim and stop, so hints are commands to run.

The gh-stack skill is accepted from the user's skills directory, from
.claude/skills/gh-stack at the root of the current repository, or from an installed plugin
named gh-stack.

Overridable for tests:
  WS_SKILLS_DIR          where user skills live     (default: $HOME/.claude/skills)
  WS_INSTALLED_PLUGINS   Claude's installed plugins
                         (default: $HOME/.claude/plugins/installed_plugins.json)
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli  # noqa: E402  (needs HERE on sys.path first)

PROG = "ws-preflight.py"

GH_STACK_REPO = "github/gh-stack"
INSTALL_REVIEW_TOOLKIT = "/plugin install pr-review-toolkit@claude-plugins-official"
# What gh says when the user simply has not logged in. Anything else it fails
# with is a different problem and gets a different hint.
NOT_LOGGED_IN = "not logged in"


def skills_dir() -> str:
    return os.environ.get("WS_SKILLS_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude", "skills"
    )


def installed_plugins_path() -> str:
    return os.environ.get("WS_INSTALLED_PLUGINS") or os.path.join(
        os.path.expanduser("~"), ".claude", "plugins", "installed_plugins.json"
    )


def repo_root() -> str:
    """The current repository's root, or the working directory outside one.

    So a repo-local `.claude/skills/gh-stack` is found from any directory
    inside the checkout, not only from its top.
    """
    try:
        finished = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return os.getcwd()
    if finished.returncode != 0:
        return os.getcwd()
    return finished.stdout.decode("utf-8", "replace").strip() or os.getcwd()


def read_installed_plugins():
    """(document, trouble) for the installed-plugins file.

    `trouble` is a sentence when the file is there but unusable, so the caller
    can say that instead of telling the user to install something they already
    have. A missing file is neither: (None, None), since "not installed yet" is
    the ordinary case.

    Wider than the jq test it replaces, deliberately: `jq -e .` exits 1 on the
    bare literals `null` and `false`, but called a file holding an array, a
    number, a string or `true` valid and then failed the key lookup on it with
    the install hint. Anything whose top level is not a JSON object cannot be
    Claude's plugin registry, and saying so is the more useful answer.

    Only a file that is not there is "not installed yet". Any other OSError --
    a directory in its place, a mode that cannot be read -- is a file the user
    has to go and look at, so the reason names itself rather than being read as
    an absent registry.
    """
    path = installed_plugins_path()
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except FileNotFoundError:
        return None, None
    except OSError as error:
        return None, f"installed plugins file cannot be read: {path}: {error.strerror}"
    except ValueError:
        return None, f"installed plugins file is not valid JSON: {path}"
    if not isinstance(document, dict):
        return None, f"installed plugins file is not a JSON object: {path}"
    return document, None


def has_plugin(document, prefix: str) -> bool:
    """Whether any installed plugin is `<prefix>@<marketplace>`.

    The marketplace a plugin came from is not this script's business, so the
    key is matched by its name and the `@` only.
    """
    if not isinstance(document, dict):
        return False
    plugins = document.get("plugins")
    if not isinstance(plugins, dict):
        return False
    return any(name.startswith(prefix + "@") for name in plugins)


def gh_extension_list():
    """(text, error) from `gh extension list`, both streams together.

    Combined the way the shell combined them: a failure here is a broken gh,
    and its message is the only useful thing to report, so it must not be
    thrown away in favour of "the extension is missing".
    """
    try:
        finished = subprocess.run(
            ["gh", "extension", "list"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as error:
        return "", str(error)
    text = finished.stdout.decode("utf-8", "replace")
    if finished.returncode != 0:
        return "", " ".join(text.rstrip("\n").split("\n"))
    return text, None


def lists_gh_stack(text: str) -> bool:
    """Whether `gh extension list` names the gh-stack extension, by repository.

    By repository, not by the command name: a third-party `gh-stack-anything`
    installs a `gh stacker` command whose row would otherwise pass a looser test.
    """
    for line in text.splitlines():
        columns = line.split("\t")
        if len(columns) > 1 and columns[1] == GH_STACK_REPO:
            return True
    return False


def gh_auth_status():
    """(authenticated, complaint) from `gh auth status`.

    `complaint` is None when the answer was "not logged in", which is the case
    the login hint is for. Anything else gh failed with -- offline, a request
    that timed out, a broken config, gh gone from under us -- is kept and
    reported instead: telling a user who is logged in to log in again sends
    them after the wrong problem. gh writes both answers to stderr, so that is
    the stream to read.
    """
    try:
        finished = subprocess.run(
            ["gh", "auth", "status"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        return False, str(error)
    if finished.returncode == 0:
        return True, None
    text = finished.stderr.decode("utf-8", "replace")
    if NOT_LOGGED_IN in text.lower():
        return False, None
    # gh puts the reason first and its remedies after; for an invalid token the
    # last line is "To forget about this account, run: gh auth logout", which is
    # the one remedy not to suggest. Keep the reason and the first remedy.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return False, "; ".join(lines[:2]) if lines else None


def check_gh(missing) -> None:
    """gh itself, then the two checks that need a working gh.

    Skipped wholesale when gh is not installed: reporting "not logged in" and
    "extension missing" as well would be three problems where there is one.
    """
    if shutil.which("gh") is None:
        missing.append(("gh", "brew install gh"))
        return
    authenticated, complaint = gh_auth_status()
    if not authenticated:
        hint = "gh auth login" if complaint is None else f"gh auth status failed: {complaint}"
        missing.append(("gh-auth", hint))
    text, error = gh_extension_list()
    if error is not None:
        # A failing `gh extension list` is a broken gh, not a missing extension,
        # so the two are reported apart and the real error is kept.
        missing.append(("gh-broken", f"gh extension list failed: {error}"))
    elif not lists_gh_stack(text):
        missing.append(("gh-stack-extension", f"gh extension install {GH_STACK_REPO}"))


def check_gh_stack_skill(missing, plugins) -> None:
    """The skill may be installed by `gh skill install` (user or repo) or by a plugin."""
    candidates = (
        os.path.join(skills_dir(), "gh-stack", "SKILL.md"),
        os.path.join(repo_root(), ".claude", "skills", "gh-stack", "SKILL.md"),
    )
    if any(os.path.isfile(path) for path in candidates):
        return
    if has_plugin(plugins, "gh-stack"):
        return
    missing.append(("gh-stack-skill", "gh skill install github/gh-stack --agent claude-code"))


def check_review_toolkit(missing, plugins, trouble) -> None:
    if trouble is not None:
        missing.append(("pr-review-toolkit", trouble))
    elif not has_plugin(plugins, "pr-review-toolkit"):
        missing.append(("pr-review-toolkit", INSTALL_REVIEW_TOOLKIT))


def body(argv) -> int:
    first = argv[1] if len(argv) > 1 else ""
    if first in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if first:
        sys.stderr.write(f"{PROG}: unexpected argument: {first}\n")
        sys.stderr.write(__doc__)
        return 2
    plugins, trouble = read_installed_plugins()
    missing = []
    check_gh(missing)
    check_gh_stack_skill(missing, plugins)
    check_review_toolkit(missing, plugins, trouble)
    sys.stdout.write(
        cli.dumps(
            {
                "ok": not missing,
                "missing": [{"id": name, "hint": hint} for name, hint in missing],
            }
        )
    )
    return 1 if missing else 0


def main(argv) -> int:
    return cli.run(PROG, lambda: body(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
