#!/usr/bin/env python3
"""Input and output for the SessionStart hook.

The hook is shell, but its two IO jobs are JSON: reading the payload Claude Code
sends on stdin, and writing the SessionStart response. Doing that inline with
python3 -c buried the logic in quoted heredocs inside the shell script, where it
could not be linted, tested, or read easily. It lives here instead.

Usage:
  hook-io.py cwd                        read the payload on stdin, print its cwd
  hook-io.py branch <current> <default> the "you are not on the default branch" message
  hook-io.py report                     the fan-out report, read from stdin
"""

import json
import sys

BRANCH_MESSAGE = """\
This session started on branch '{current}'; the repository's default branch is '{default}'.
Ask the user whether they would like to run /gh:sync to move to '{default}', fast-forward it,
and prune branches whose work has already landed. Ask first. Do not run it unprompted, and do
not mention this if the user is clearly in the middle of something else.
"""

REPORT_MESSAGE = """\
A read-only /gh:sync check ran for the repositories below. No branch, worktree, or working tree
was changed (it does fetch, so remote-tracking refs are current).

{report}

Offer to run /gh:sync to apply this for real. Ask first, and report the outcome plainly,
including any repository that gets skipped and why.
"""


def emit(context):
    """Write one SessionStart hook response."""
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


def read_cwd():
    """Print the payload's cwd, or nothing at all if it cannot be read.

    A malformed payload is not an error worth failing on: the caller falls back
    to its own working directory, and the hook must never block a session.
    """
    try:
        payload = json.load(sys.stdin)
        print(payload.get("cwd") or "")
    except (ValueError, AttributeError):
        print("")


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "cwd":
        read_cwd()
    elif mode == "branch" and len(argv) == 4:
        emit(BRANCH_MESSAGE.format(current=argv[2], default=argv[3]))
    elif mode == "report":
        emit(REPORT_MESSAGE.format(report=sys.stdin.read().rstrip("\n")))
    else:
        sys.stderr.write("usage: hook-io.py {cwd|branch <current> <default>|report}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
