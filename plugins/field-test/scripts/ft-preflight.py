#!/usr/bin/env python3
"""ft-preflight.py: check that everything /field-test:harden depends on is present.

  ft-preflight.py

Prints one JSON object: {"ok": true|false, "missing": [{"id": ..., "hint": ...}]}
and exits 0 when everything is present, 1 when anything is missing, 2 on usage.
The skill prints each hint verbatim and stops, so hints are commands to run,
except registry-unreadable, whose hint names the file it could not read (or
says HOME is unset, when there is no file to name). A `detail` field carries
the tool's own message when there is one, so a network error is not reported
as a missing login.

`harden` reuses the workstreams worker agents and invokes /workstreams:review for
its review round rather than growing one of its own, so both plugins have to be
installed: workstreams for stream-low, stream-medium, stream-high, applier, and
the review skill, and pr-review-toolkit because that round runs review-pr. The
dependency is checked here instead of failing halfway through a target, when a
fix is already in flight.

Checks gh, gh auth, the workstreams plugin, and pr-review-toolkit. jq is not
among them: nothing in this plugin shells out to jq any more, and the harden
skill's own steps use gh's built-in --jq, which is not the jq binary.

Overridable for tests:
  FT_INSTALLED_PLUGINS   Claude's installed plugins
                         (default: $HOME/.claude/plugins/installed_plugins.json)
  FT_GH                  the gh command (default: gh)

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, preflight  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-preflight.py"

USAGE = (
    "Usage: ft-preflight.py\n\nChecks gh, gh auth, the workstreams plugin, and pr-review-toolkit.\n"
)


def installed_path() -> str:
    """Where Claude's registry is, or "" when there is nowhere to look.

    HOME unset would otherwise build a relative path, miss, and report both
    plugins as missing: an answer about the session that ran this rather than
    about what is installed.
    """
    override = os.environ.get("FT_INSTALLED_PLUGINS")
    if override:
        return override
    home = os.environ.get("HOME")
    if not home:
        return ""
    return os.path.join(home, ".claude", "plugins", "installed_plugins.json")


def gh_findings():
    """gh itself, then the login it holds.

    `gh auth status` fails for a missing login and also for a network error or a
    broken config dir; the message says which, so it travels with the hint. The
    two streams are folded together deliberately: it is one message to a human,
    and gh splits it across both.
    """
    command = os.environ.get("FT_GH") or "gh"
    try:
        finished = subprocess.run(
            [command, "auth", "status"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError:
        # No gh on PATH at all, which is `command -v gh` failing in the shell.
        return [preflight.missing("gh", "brew install gh")]
    if finished.returncode == 0:
        return []
    # rstrip because the shell captured this in a command substitution, which
    # eats the trailing newline; without it every detail ends in a stray space.
    message = finished.stdout.decode("utf-8", "replace").rstrip("\n")
    return [preflight.missing("gh-auth", "gh auth login", preflight.excerpt(message))]


def read_registry(path: str):
    """The registry's text, None when there is no file, or the OSError instead.

    Opened rather than tested first: `isfile` said no for a directory sitting at
    the path and for a file the user cannot stat, and both then read as "no
    registry", which reports the two plugins as missing. The error itself comes
    back so the finding can carry what the operating system said, since a
    permission and a directory need different fixes and neither is JSON.
    """
    if not path:
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except OSError as error:
        return error


def run(argv):
    argument = argv[1] if len(argv) > 1 else ""
    if argument in ("-h", "--help"):
        sys.stdout.write(USAGE)
        return 0
    if argument:
        sys.stderr.write(f"{PROG}: unexpected argument: {argument}\n")
        sys.stderr.write(USAGE)
        return 2

    path = installed_path()
    entries = gh_findings() + preflight.registry_findings(path, read_registry(path))
    # Plain write, not cli.write_out: this script changes nothing, so a reader
    # that walked away can stop it where it stands.
    sys.stdout.write(json.dumps(preflight.report(entries), indent=2, ensure_ascii=False) + "\n")
    return 1 if entries else 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather
        # than in the interpreter's own shutdown flush, which prints its trace.
        sys.stdout.flush()
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # One line and exit 1 for an arm nobody anticipated, the way every
        # anticipated one reports. The class name is there so an exception with
        # an empty message still names what happened.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
