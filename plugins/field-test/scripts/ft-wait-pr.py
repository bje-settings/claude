#!/usr/bin/env python3
"""ft-wait-pr.py: block until a pull request has an answer, or the wait runs out.

  ft-wait-pr.py <repo> <pr> [--timeout <seconds>] [--interval <seconds>]

Prints one word and exits:
  merged   the pull request merged                                  exit 0
  passed   still open, every check green, nothing left to wait for  exit 0
  failed   a check failed, or the pull request was closed unmerged  exit 1
  pending  the wait ran out with checks still running               exit 3
Usage errors exit 2; a gh that cannot answer at all, and an internal error,
exit 4; a pull request GitHub says does not exist exits 5, which no wait can
fix.

This blocks in the foreground on purpose. A worker that arms a wake and ends its
turn leaves the orchestrator looking at "waiting" and the work stopped; the
caller sets the Bash tool's own timeout above this one and gets an answer or a
`pending` it can act on. Default timeout is 540 seconds, under the 600 the
calling skill sets.

A pull request with no checks at all is not a pull request to wait on: it is
reported `passed` once seen twice, the same rule /workstreams:run uses, since
workflows may not have queued yet on the first look.

Overridable for tests: FT_GH (the gh command, default `gh`), and
FT_WAIT_CALL_FLOOR (the seconds one `gh pr view` is always allowed).
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

# What one `gh pr view` is always allowed, even when the wait has almost run out.
# The deadline is tested before each look, so reaching this floor means time
# genuinely remains and the only question is whether a real call fits in it: a
# budget of the last half second does not, and gh would be killed and reported as
# exit 4 -- a status the skill pauses the target on -- where the honest answer is
# `pending`. Tests lower it to keep the hang case from taking half a minute.
CALL_FLOOR = 30.0

# What gh says when the number is not a pull request in that repository. It gets
# its own status because it is the one failure waiting cannot cure: the caller
# has the wrong number or the wrong repository, and every retry costs a wake.
NO_SUCH_PR = "Could not resolve to a PullRequest"
MISSING_PR = 5

# The states this knows how to answer for. Anything else -- a state gh added, a
# document with no state at all, which `checks.fold` stands in for as "UNKNOWN"
# -- is an answer nobody here can read, and it must not fall through to the
# check arms below and be reported as `passed`.
STATES = ("OPEN", "MERGED", "CLOSED")

# What each answer costs the caller, as an exit status it can branch on without
# reading the word back.
STATUS = {"merged": 0, "passed": 0, "failed": 1, "pending": 3}

# An arm nobody anticipated is not a verdict. Exit 1 is `failed` here, and the
# harden skill reads it as a pull request that will not merge: it goes back to
# the fix step, or pauses the target on a failure that never happened. 4 is the
# status the skill retries once and then pauses on with the stderr text, which
# is what a bug in this script deserves.
INTERNAL_ERROR = 4


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def excerpt(text: str) -> str:
    return " ".join(text.rstrip("\n").split("\n"))[:EXCERPT]


def call_floor() -> float:
    """The floor on one call's budget, overridable so a test need not wait it out."""
    raw = os.environ.get("FT_WAIT_CALL_FLOOR") or ""
    try:
        floor = float(raw)
    except ValueError:
        return CALL_FLOOR
    return floor if floor > 0 else CALL_FLOOR


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


def look(command: str, repo: str, pr: str, budget: float):
    """One `gh pr view`, folded to {state, draft, checks, failing}.

    Both streams are folded together, as the shell's `2>&1` did: a gh that
    failed says why on stderr, and that text is what the message quotes. It
    means a warning on stderr can make a good answer unreadable, which is
    reported as exit 4 rather than guessed at either way.

    `budget` is what is left of the wall clock. A gh that hangs -- a proxy that
    accepts and never answers, a network that went away mid-call -- would
    otherwise hold the whole wait open past the timeout this script promises and
    past the Bash timeout the caller set on top of it, and the caller sees the
    tool killed rather than an answer it can act on.
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
            timeout=budget,
        )
    except subprocess.TimeoutExpired:
        die(
            f"gh did not answer within {int(budget)}s for pull request {pr} in {repo}",
            4,
        )
    except OSError as error:
        die(f"cannot read pull request {pr} in {repo}: {excerpt(str(error))}", 4)
    answer = finished.stdout.decode("utf-8", "replace")
    if finished.returncode != 0:
        if NO_SUCH_PR in answer:
            # Its own status: gh answered, and the answer is that there is
            # nothing to wait for. Retrying a missing pull request never helps.
            die(f"no pull request {pr} in {repo}: {excerpt(answer)}", MISSING_PR)
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
    """The one word this script prints, once there is one to print.

    Bounded on the clock rather than on a count of intervals. Counting assumed
    each look was free, and a slow gh -- or one that hangs, which is why every
    call carries what is left of the budget -- made a wait of 540 seconds take
    however long the calls took, past the Bash timeout the caller set on top of
    it. `monotonic` because this is a duration: a clock the system adjusts
    mid-wait would extend or end it by however far it jumped.
    """
    deadline = time.monotonic() + timeout
    floor = call_floor()
    seen_none = 0
    while True:
        # The deadline is tested here, before the look, because the sleep at the
        # bottom is what crosses it: testing after the look gave the next call
        # whatever was left, which was nothing, and a real gh was killed and
        # reported as exit 4 where the answer was `pending`.
        if time.monotonic() >= deadline:
            return "pending"
        # Past that test time genuinely remains, so the floor below is only
        # reached in the last seconds of a wait, where a call that would not fit
        # is still worth making rather than timing out on arrival.
        folded = look(command, repo, pr, max(floor, deadline - time.monotonic()))
        state = folded["state"]
        if state == "MERGED":
            return "merged"
        if state == "CLOSED":
            return "failed"
        if state not in STATES:
            die(f"gh reported a state this cannot read for pull request {pr}: {state}", 4)
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
        # Never sleep past the deadline: the caller sets its own Bash timeout
        # just above this one, and an interval that overshot would spend it.
        time.sleep(min(float(interval), max(0.0, deadline - time.monotonic())))


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
        return INTERNAL_ERROR
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
