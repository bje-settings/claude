#!/usr/bin/env python3
"""ws-pr-comments.py: every review, comment, and review thread on one pull request.

  ws-pr-comments.py <number | #number | url> [--repo <owner/name>]

Prints one flat JSON list. Within a page the order is reviews, then issue
comments, then the comments of every review thread; a pull request long enough to
page arrives page by page, so the three interleave across pages and `kind` is
what to group by rather than position:
  [
    {
      "id": 123456, "kind": "review|comment|thread",
      "author": "coderabbitai", "bot": true, "resolved": false,
      "path": "src/parser.py", "line": 42, "body": "..."
    }
  ]

`id` is the comment's own database id, which is what a reply is addressed to
(`repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies` for a thread comment).
`bot` is true for a GitHub App account and for a login ending in `[bot]`.
`resolved` is the thread's flag, and is false on a review or an issue comment,
neither of which can be resolved. `path` and `line` are null except on a thread
comment, and `line` is null there too once GitHub has marked the comment
outdated. A review with an empty body is left out: GitHub records one for every
batch of inline comments, and those comments are in the threads already.

The repository comes from a url reference, else --repo, else WS_REPO, else
`gh repo view`. Reviews, comments, and threads are paged; a thread's own
comments are read 100 to a thread and not paged.

Exit 0 on success, 1 when gh failed or answered with something this cannot read
(gh's own message is forwarded first, unchanged), 2 on usage.
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, pr_comments  # noqa: E402  (needs HERE on sys.path first)

PROG = "ws-pr-comments.py"

# https://github.com/owner/name/pull/12, and the same with a trailing /files or
# a query string, which is what copying the address of a review comment gives.
PR_URL = re.compile(r"^https?://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+)")
NUMBER = re.compile(r"^#?([0-9]+)$")


def die(message: str, status: int = 1):
    raise cli.Failure(message, status)


def gh_repo() -> str:
    """The current repository's nameWithOwner, for a bare number with no --repo.

    The round that calls this runs in whatever session the user started, which is
    often a checkout of some other repository -- the whole point of naming the
    pull request explicitly. So this is the last resort, not the first, and its
    failure says which of the three ways to name the repository are left.
    """
    try:
        finished = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner"],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        die(f"cannot resolve the repository (gh: {error}); pass --repo owner/name")
    stderr = finished.stderr.decode("utf-8", "replace")
    if stderr:
        sys.stderr.write(stderr)
    if finished.returncode != 0:
        die("cannot resolve the repository; pass --repo owner/name")
    try:
        name = json.loads(finished.stdout.decode("utf-8", "replace"))["nameWithOwner"]
    except (ValueError, KeyError, TypeError):
        die("cannot resolve the repository; pass --repo owner/name")
    if not isinstance(name, str) or "/" not in name:
        die("cannot resolve the repository; pass --repo owner/name")
    return name


def split_repo(repo: str):
    owner, _, name = repo.partition("/")
    if not owner or not name or "/" in name:
        die(f"repo must be owner/name, got: {repo}", 2)
    return owner, name


def target(reference: str, repo_argument: str):
    """The owner, name, and number to query, from whichever of the three said so."""
    url = PR_URL.match(reference)
    if url:
        return url.group(1), url.group(2), int(url.group(3))
    number = NUMBER.match(reference)
    if not number:
        die(f"not a pull request number or url: {reference}", 2)
    repo = repo_argument or os.environ.get("WS_REPO", "") or gh_repo()
    owner, name = split_repo(repo)
    return owner, name, int(number.group(1))


def gh_graphql(owner: str, name: str, number: int, cursors: dict):
    """One page of the query, parsed.

    gh's stderr is forwarded unchanged before this script adds its own line: on a
    rate limit, an expired token, or a pull request that is not there, gh's own
    message is what says which, and capturing it must not be how it goes missing.
    """
    # -f sends a String, -F types the value: gh reads true, false, null, and an
    # all-digit value as their JSON types. Only `number` is an Int here. An owner
    # or repository named in digits (bje-co/2048) or a cursor that happens to be
    # all digits would be sent as an Int against a String! variable and the query
    # would be rejected before it ran, so every String goes through -f.
    command = [
        "gh",
        "api",
        "graphql",
        "-f",
        "query=" + pr_comments.QUERY,
        "-f",
        f"owner={owner}",
        "-f",
        f"name={name}",
        "-F",
        f"number={number}",
    ]
    for _, cursor_name in pr_comments.CONNECTIONS:
        value = cursors.get(cursor_name)
        # A null cursor is the first page. Omitted rather than sent empty: gh
        # would send "" and GraphQL would look for a cursor of that name.
        if value is not None:
            command += ["-f", f"{cursor_name}={value}"]
    try:
        finished = subprocess.run(command, capture_output=True, check=False)
    except OSError as error:
        die(f"gh api graphql failed for {owner}/{name}#{number}: {error}")
    stderr = finished.stderr.decode("utf-8", "replace")
    if stderr:
        sys.stderr.write(stderr)
    if finished.returncode != 0:
        die(f"gh api graphql failed for {owner}/{name}#{number}")
    text = finished.stdout.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError as error:
        die(
            f"gh api graphql failed for {owner}/{name}#{number}: "
            f"it did not answer with JSON ({error})"
        )


def collect(owner: str, name: str, number: int) -> list:
    """Every page of all three connections, flattened into one list.

    A connection that has run out keeps its cursor rather than falling back to
    null, so the rounds that follow it answer with an empty page instead of
    handing back the first one and doubling every entry on it.
    """
    cursors = {}
    entries = []
    while True:
        pull = pr_comments.pull_request(gh_graphql(owner, name, number, cursors))
        entries += pr_comments.flatten(pull)
        more = False
        for connection, cursor_name in pr_comments.CONNECTIONS:
            has_next, cursor = pr_comments.page(pull, connection)
            if cursor is not None:
                cursors[cursor_name] = cursor
            more = more or has_next
        if not more:
            return entries


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

    repo_argument = ""
    index = 1
    while index < len(arguments):
        flag = arguments[index]
        if flag != "--repo":
            die(f"unknown argument: {flag}", 2)
        value = arguments[index + 1] if index + 1 < len(arguments) else ""
        if not value or value.startswith("-"):
            die("--repo needs a value", 2)
        repo_argument = value
        index += 2

    owner, name, number = target(first, repo_argument)
    sys.stdout.write(cli.dumps(collect(owner, name, number)))
    return 0


def main(argv) -> int:
    return cli.run(PROG, lambda: body(argv), (cli.Failure, pr_comments.Malformed))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
