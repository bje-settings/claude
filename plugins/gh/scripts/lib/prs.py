"""lib/prs.py — reading merge proof out of a `gh pr list` result.

This is the jq program `gh-sync-repo.sh` used to run, as plain functions. Three
things are required of a pull request before it counts as proof that a local
branch has landed, because a bare branch-name match is not evidence about your
commits:

  - it merged into the default branch, not into some other branch
  - it came from this repository, not from a fork (a fork's PR head ref is just
    a name like "patch-1", which collides with local branches trivially)
  - its head commit is exactly where the local branch still points, so a branch
    that was reused or committed to after the merge is not treated as landed

The base is filtered server-side by `--base`, so only the last two live here.
Forks are dropped by `own_rows` rather than by the query, so the row count the
caller checks against the lookup limit stays the real number of pull requests
the window returned.
"""

from __future__ import annotations

# The fields the queries ask for. isCrossRepository is what own_rows reads;
# without it every fork would look like a local branch.
FIELDS = "headRefName,headRefOid,isCrossRepository"


def own_rows(rows):
    """The rows from this repository, dropping forks."""
    return [row for row in rows if not row.get("isCrossRepository")]


def has_match(rows, branch, sha):
    """Does any row name this branch AT this commit?"""
    return any(row.get("headRefName") == branch and row.get("headRefOid") == sha for row in rows)


def names_branch(rows, branch):
    """Does any row name this branch, at any commit?"""
    return any(row.get("headRefName") == branch for row in rows)
