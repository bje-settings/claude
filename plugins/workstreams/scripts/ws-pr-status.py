#!/usr/bin/env python3
"""ws-pr-status.py: reduce one pull request to the fields the run loop decides on.

  ws-pr-status.py <number | #number | url>

Prints one JSON object:
  {
    "number": 12, "url": "...", "title": "...",
    "state": "OPEN|MERGED|CLOSED", "draft": true|false,
    "base": "main", "head": "wktr-12-thing", "headSha": "...",
    "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN",
    "checks": "pass|fail|pending|none",
    "failing": ["lint"],
    "reviewDecision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|"
  }

checks folds the status rollup (see lib/pr_status.py): fail if any check failed,
failed to start, errored, timed out, was cancelled, went stale, or needs action;
pending if none failed but any is still running or has no conclusion; pass if
every check succeeded, was neutral, or skipped; none if there are none. failing
names the checks that failed (a CheckRun's name or a StatusContext's context).

Exit 0 on success, 1 when the pull request does not exist, 2 on usage, 4 when
gh itself failed, answered with something this cannot read, or failed in a way
nobody anticipated.

1 and 4 are separated because the run loop decides differently on them: a pull
request that does not exist is a permanent failure of the stream that reported
it, while a rate limit, an expired token, or a network blip is worth another
tick. gh's own stderr is what tells them apart, and it is forwarded unchanged
either way.
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, pr_status  # noqa: E402  (needs HERE on sys.path first)

PROG = "ws-pr-status.py"

FIELDS = (
    "number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,"
    "mergeable,reviewDecision,statusCheckRollup"
)


def die(message: str, status: int = 1):
    raise cli.Failure(message, status)


# What gh says when the reference names no pull request, rather than when gh
# could not do its job. "could not resolve to a pullrequest" is the GraphQL
# error for a number or url that is not one; "no pull requests found" is what
# `gh pr view` answers when it was given a branch with no open PR. Anything
# else -- a rate limit, an expired token, a DNS failure, a 5xx -- is gh
# failing, and matching it as "does not exist" is the mistake this list exists
# to avoid. Matched case-insensitively against gh's stderr.
MISSING = ("could not resolve to a pullrequest", "no pull requests found")


def missing(stderr: str) -> bool:
    """Whether gh's message says the pull request could not be resolved."""
    lowered = stderr.lower()
    return any(phrase in lowered for phrase in MISSING)


def gh_view(reference: str):
    """`gh pr view` for one pull request, parsed.

    stderr is captured only to tell "no such pull request" (exit 1) from "gh
    failed" (exit 4), and is forwarded unchanged before this script adds its own
    line: gh's own error is worth more to whoever is reading than any summary of
    it, and capturing it must not be how it goes missing.
    """
    try:
        finished = subprocess.run(
            ["gh", "pr", "view", reference.lstrip("#"), "--json", FIELDS],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        # gh is not on PATH, or is not executable. Not a pull request that does
        # not exist: nothing was asked of GitHub at all.
        die(f"gh pr view failed for {reference}: {error}", 4)
    stderr = finished.stderr.decode("utf-8", "replace")
    if stderr:
        sys.stderr.write(stderr)
    if finished.returncode != 0:
        if missing(stderr):
            die(f"gh pr view failed for {reference}: no such pull request", 1)
        die(f"gh pr view failed for {reference}", 4)
    text = finished.stdout.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError as error:
        # gh exited 0 with something that is not JSON. The pull request may well
        # exist; what failed is gh, or a proxy in front of it.
        die(f"gh pr view failed for {reference}: it did not answer with JSON ({error})", 4)


def body(argv) -> int:
    arguments = argv[1:]
    first = arguments[0] if arguments else ""
    if first in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if first == "":
        sys.stderr.write(f"{PROG}: a pull request number or url is required\n\n")
        sys.stderr.write(__doc__)
        return 2
    if first.startswith("-"):
        die(f"unknown flag: {first}", 2)
    if len(arguments) != 1:
        die(f"exactly one pull request, got {len(arguments)} arguments", 2)
    sys.stdout.write(cli.dumps(pr_status.reduce(gh_view(first))))
    return 0


def main(argv) -> int:
    # internal_status 4, not the default 1: exit 1 has to mean "the pull request
    # does not exist" and nothing else, because the run loop fails a stream
    # permanently on it. An arm nobody anticipated is this script failing, which
    # is what 4 already says.
    return cli.run(PROG, lambda: body(argv), (cli.Failure, pr_status.Malformed), internal_status=4)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
