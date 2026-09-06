#!/usr/bin/env python3
"""ft-wait-pr.py: block until a pull request has an answer, or the wait runs out.

  ft-wait-pr.py <repo> <pr> [--timeout <seconds>] [--interval <seconds>]

Prints one word and exits:
  merged   the pull request merged                                  exit 0
  passed   still open, every check green, nothing left to wait for  exit 0
  failed   a check failed, or the pull request was closed unmerged  exit 1
  pending  the wait ran out with checks still running               exit 3
Usage errors exit 2; a gh that cannot answer at all exits 4.

This blocks in the foreground on purpose. A worker that arms a wake and ends its
turn leaves the orchestrator looking at "waiting" and the work stopped; the
caller sets the Bash tool's own timeout above this one and gets an answer or a
`pending` it can act on. Default timeout is 540 seconds, under the 600 the
calling skill sets.

A pull request with no checks at all is not a pull request to wait on: it is
reported `passed` once seen twice, the same rule /workstreams:run uses, since
workflows may not have queued yet on the first look.

Overridable for tests: FT_GH (the gh command, default `gh`).
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import checks as checks_lib  # noqa: E402  (needs HERE on sys.path first)
from lib import cli  # noqa: E402

PROG = "ft-wait-pr.py"

DIGITS = re.compile(r"^[0-9]+$")
POSITIVE = re.compile(r"^[1-9][0-9]*$")
EXCERPT = 160

DEFAULT_TIMEOUT = 540
DEFAULT_INTERVAL = 30

# What each answer costs the caller, as an exit status it can branch on without
# reading the word back.
STATUS = {"merged": 0, "passed": 0, "failed": 1, "pending": 3}


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def excerpt(text: str) -> str:
    return " ".join(text.rstrip("\n").split("\n"))[:EXCERPT]


def parse_options(argv):
    """(timeout, interval) from what follows the repository and the number."""
    timeout = DEFAULT_TIMEOUT
    interval = DEFAULT_INTERVAL
    index = 0
    while index < len(argv):
        argument = argv[index]
        value = argv[index + 1] if index + 1 < len(argv) else ""
        if argument == "--timeout":
            if not DIGITS.match(value):
                die("--timeout needs a number of seconds", 2)
            timeout = int(value)
        elif argument == "--interval":
            # Zero would spin without the elapsed time ever reaching the timeout.
            if not POSITIVE.match(value):
                die("--interval needs a number of seconds from 1", 2)
            interval = int(value)
        else:
            die(f"unknown argument: {argument}", 2)
        index += 2
    return timeout, interval


def look(command: str, repo: str, pr: str):
    """One `gh pr view`, folded to {state, draft, checks, failing}.

    Both streams are folded together, as the shell's `2>&1` did: a gh that
    failed says why on stderr, and that text is what the message quotes. It
    means a warning on stderr can make a good answer unreadable, which is
    reported as exit 4 rather than guessed at either way.
    """
    try:
        finished = subprocess.run(
            [
                command,
                "pr",
                "view",
                pr,
                "--repo",
                repo,
                "--json",
                "state,isDraft,statusCheckRollup",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as error:
        die(f"cannot read pull request {pr} in {repo}: {excerpt(str(error))}", 4)
    answer = finished.stdout.decode("utf-8", "replace")
    if finished.returncode != 0:
        die(f"cannot read pull request {pr} in {repo}: {excerpt(answer)}", 4)
    try:
        return checks_lib.fold(json.loads(answer))
    except ValueError:
        die(
            f"gh answered with something this cannot read for pull request {pr}: "
            + excerpt(answer),
            4,
        )


def wait(command: str, repo: str, pr: str, timeout: int, interval: int) -> str:
    """The one word this script prints, once there is one to print."""
    waited = 0
    seen_none = 0
    while True:
        folded = look(command, repo, pr)
        if folded["state"] == "MERGED":
            return "merged"
        if folded["state"] == "CLOSED":
            return "failed"
        if folded["checks"] == "fail":
            return "failed"
        if folded["checks"] == "pass":
            return "passed"
        if folded["checks"] == "none":
            # Twice in a row with nothing queued means there is nothing coming.
            seen_none += 1
            if seen_none >= 2:
                return "passed"
        else:
            seen_none = 0
        if waited >= timeout:
            return "pending"
        time.sleep(interval)
        waited += interval


def run(argv):
    if argv[1:2] and argv[1] in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    repo = argv[1] if len(argv) > 1 else ""
    pr = argv[2] if len(argv) > 2 else ""
    if not repo or not pr:
        sys.stderr.write(__doc__)
        return 2
    if "/" not in repo:
        die(f"repo must be owner/name, got: {repo}", 2)
    if not DIGITS.match(pr):
        die(f"pull request must be a number, got: {pr}", 2)
    timeout, interval = parse_options(argv[3:])

    answer = wait(os.environ.get("FT_GH") or "gh", repo, pr, timeout, interval)
    sys.stdout.write(answer + "\n")
    return STATUS[answer]


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather
        # than in the interpreter's own shutdown flush, which prints its trace.
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
