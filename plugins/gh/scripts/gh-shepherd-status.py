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

Exits 2 on a usage error, 1 when gh cannot answer for the repository.
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


def gh_json(args):
    """gh's answer parsed, or None when it could not be read.

    Every caller here treats "gh refused", "gh is missing" and "gh answered with
    something that is not JSON" the same way -- the repository cannot be read,
    or the optional listing is empty -- so the reason does not travel with the
    None the way it does in gh-sync-repo.py.
    """
    try:
        completed = subprocess.run(
            ["gh", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    try:
        return json.loads(completed.stdout.decode("utf-8", "replace") or "null")
    except ValueError:
        return None


def resolve_repo():
    """(nameWithOwner, default branch), or (None, None) when gh cannot say."""
    view = gh_json(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"])
    if not isinstance(view, dict):
        return None, None
    name = view.get("nameWithOwner") or None
    branch = (view.get("defaultBranchRef") or {}).get("name") or None
    if not name or not branch:
        return None, None
    return name, branch


def main(argv):
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
    except OSError:
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

    repo, default_branch = resolve_repo()
    if repo is None:
        print("could not resolve the repository with gh", file=sys.stderr)
        return 1

    pulls = gh_json(
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
        print(f"could not list pull requests for {repo}", file=sys.stderr)
        return 1

    # A run listing the repository cannot answer is not a failure: a repo with
    # no Actions at all is normal, and the loop only needs a wait bound.
    runs = gh_json(
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


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
