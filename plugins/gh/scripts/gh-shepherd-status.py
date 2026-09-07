#!/usr/bin/env python3
"""gh-shepherd-status.py — what /gh:shepherd would work on in one repository.

Usage:
  gh-shepherd-status.py [path]

Prints one JSON document and changes nothing:

  repo                  owner/name
  default_branch        the branch pull requests are merged into
  ci_seconds            median wall time of recent completed workflow runs on
                        the default branch; 300 when there are none
  targets               open, non-draft pull requests labelled `dependencies`
                        that a human has already marked for auto-merge, in
                        the order the loop should take them
  skipped_no_automerge  `dependencies` pull requests without auto-merge. They
                        are reported, never enabled: auto-merge is the
                        human's signal that the pull request is wanted.

Ordering: gh-security's merge-risk:<band> label first (low, then unlabelled,
then medium, then high), oldest first within a band. Each target carries the
fields the loop needs to pick its next step, plus a `checks` summary reduced
from statusCheckRollup so the caller does not have to know both the CheckRun
and StatusContext shapes.

Exits 2 on a usage error, 1 when gh cannot answer for the repository, and 3 on
an internal error, which is outside the documented set so a caller cannot
mistake it for an answer.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SHEPHERD_LIB = os.path.join(HERE, "lib", "shepherd.py")

try:
    from lib import shepherd, streams  # noqa: E402
except ImportError:
    # A checkout missing its own library is reported as the wiring mistake it
    # is, rather than as a traceback naming an import the reader did not write.
    # Both names go together because they come from the same directory: if
    # `lib/` is gone, neither resolves.
    shepherd = None
    streams = None

# How far back the CI-duration sample reaches. Twenty runs is a few days on an
# active repository and still one API call.
RUN_SAMPLE = 20

# The listing window for `dependencies` pull requests. A repository with more
# than this open at once has a bigger problem than the shepherd loop.
PR_LIMIT = 100


def use_utf8(stream):
    if streams is not None:
        streams.use_utf8(stream)


def one_line(text):
    """gh's output on one line, so it can sit in a one-line message."""
    if not text:
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return " ".join(text.split())


def gh_json(args):
    """(gh's answer parsed, why it could not be read).

    The reason travels with the None the way it does in gh-sync-repo.py: every
    caller here does treat "gh refused", "gh is missing" and "gh answered with
    something that is not JSON" the same way, but the person reading the
    refusal afterwards cannot tell an expired token from a repository that does
    not exist unless gh's own words come with it.
    """
    try:
        completed = subprocess.run(
            ["gh", *args],
            capture_output=True,
        )
    except OSError as error:
        return None, f"cannot run gh: {error}"
    problem = one_line(completed.stderr)
    if completed.returncode != 0:
        return None, problem or f"gh exited {completed.returncode}"
    try:
        return json.loads(completed.stdout.decode("utf-8", "replace") or "null"), ""
    except ValueError:
        return None, problem or "gh answered with something that is not JSON"


def resolve_repo():
    """(nameWithOwner, default branch, why not), the last empty when both resolved."""
    view, problem = gh_json(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"])
    if not isinstance(view, dict):
        return None, None, problem or "gh answered with no repository object"
    name = view.get("nameWithOwner") or None
    branch = (view.get("defaultBranchRef") or {}).get("name") or None
    if not name:
        return None, None, "gh answered without nameWithOwner"
    if not branch:
        # Half an answer is not an answer: the run listing needs the branch.
        return None, None, "gh answered without a default branch"
    return name, branch, ""


def run(argv):
    if streams is not None:
        streams.bind_closed_streams()
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)

    # Before the usage text, as the shell version checked it: a copy of this
    # script sitting on its own answers the same way whatever it is asked.
    if shepherd is None or not os.path.exists(SHEPHERD_LIB):
        print(f"missing {SHEPHERD_LIB}", file=sys.stderr)
        return 2
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0

    target = argv[0] if argv else os.getcwd()
    if not os.path.isdir(target):
        print(f"not a directory: {target}", file=sys.stderr)
        return 2
    try:
        os.chdir(target)
    except OSError as error:
        # Named, because "exit 2" against a path the caller believes in reads as
        # a bug in the caller rather than as a directory it may not enter.
        print(f"cannot enter {target}: {error}", file=sys.stderr)
        return 2
    if (
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        != 0
    ):
        print(f"not a git repository: {target}", file=sys.stderr)
        return 2

    if shutil.which("gh") is None:
        print("gh is required", file=sys.stderr)
        return 1

    repo, default_branch, problem = resolve_repo()
    if repo is None:
        print(f"could not resolve the repository with gh: {problem}", file=sys.stderr)
        return 1

    pulls, problem = gh_json(
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--label",
            "dependencies",
            "--limit",
            str(PR_LIMIT),
            "--json",
            shepherd.PR_FIELDS,
        ]
    )
    if not isinstance(pulls, list):
        print(f"could not list pull requests for {repo}: {problem}", file=sys.stderr)
        return 1

    # A run listing the repository cannot answer is not a failure: a repo with
    # no Actions at all is normal, and the loop only needs a wait bound.
    runs, _ = gh_json(
        [
            "run",
            "list",
            "--repo",
            repo,
            "--branch",
            default_branch,
            "--status",
            "completed",
            "--limit",
            str(RUN_SAMPLE),
            "--json",
            "createdAt,updatedAt",
        ]
    )
    if not isinstance(runs, list):
        runs = []

    document = shepherd.status_document(pulls, repo, default_branch, shepherd.ci_seconds(runs))
    try:
        print(json.dumps(document, indent=2, ensure_ascii=False))
        # Forces the write now, while BrokenPipeError still lands in the handler
        # below. Left implicit, buffered output is flushed during interpreter
        # shutdown instead, which prints its own "Exception ignored in" trace.
        sys.stdout.flush()
    except BrokenPipeError:
        # Nothing was changed and nothing is left to say: the reader went away
        # before the one document this script exists to print landed.
        if streams is not None:  # pragma: no branch - only a broken checkout has none
            streams.silence_output()
    return 0


def main(argv):
    """`run`, with anything it did not expect reported rather than raised.

    Exit 3 is outside the documented set on purpose: a caller parsing the JSON
    on stdout must not read a crash as an answer, and the agent gets a line
    naming what broke instead of a traceback it cannot act on.
    """
    try:
        return run(argv)
    except Exception as error:
        print(
            f"{os.path.basename(__file__)}: internal error: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
