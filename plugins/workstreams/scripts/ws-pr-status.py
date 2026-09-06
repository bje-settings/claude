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

Exit 0 on success, 1 when gh fails, the PR does not exist, or gh answers with a
rollup this cannot fold, 2 on usage.
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


def gh_view(reference: str):
    """`gh pr view` for one pull request, parsed.

    Only stdout is captured: gh's own error ("could not resolve to a
    PullRequest") is worth more to whoever is reading than this script's
    summary of it, so that stream is left alone.
    """
    try:
        finished = subprocess.run(
            ["gh", "pr", "view", reference.lstrip("#"), "--json", FIELDS],
            stdout=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        die(f"gh pr view failed for {reference}: {error}")
    if finished.returncode != 0:
        die(f"gh pr view failed for {reference}")
    text = finished.stdout.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError as error:
        die(f"gh pr view failed for {reference}: it did not answer with JSON ({error})")


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
    return cli.run(PROG, lambda: body(argv), (cli.Failure, pr_status.Malformed))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
