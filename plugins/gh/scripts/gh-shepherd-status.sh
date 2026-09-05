#!/usr/bin/env bash
# gh-shepherd-status.sh — what /gh:shepherd would work on in one repository.
#
# Usage:
#   gh-shepherd-status.sh [path]
#
# Prints one JSON document and changes nothing:
#
#   repo                  owner/name
#   default_branch        the branch pull requests are merged into
#   ci_seconds            median wall time of recent completed workflow runs on
#                         the default branch; 300 when there are none
#   targets               open, non-draft pull requests labelled `dependencies`
#                         that a human has already marked for auto-merge, in
#                         the order the loop should take them
#   skipped_no_automerge  `dependencies` pull requests without auto-merge. They
#                         are reported, never enabled: auto-merge is the
#                         human's signal that the pull request is wanted.
#
# Ordering: gh-security's merge-risk:<band> label first (low, then unlabelled,
# then medium, then high), oldest first within a band. Each target carries the
# fields the loop needs to pick its next step, plus a `checks` summary reduced
# from statusCheckRollup so the caller does not have to know both the CheckRun
# and StatusContext shapes.
#
# Exits 2 on a usage error, 1 when gh cannot answer for the repository.

set -uo pipefail

# Resolve the library before any cd: the script may be invoked by a relative
# path, and the target directory is somewhere else entirely.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -r "$HERE/lib/shepherd.sh" ]] || { printf 'missing %s\n' "$HERE/lib/shepherd.sh" >&2; exit 2; }
# shellcheck source=lib/shepherd.sh
. "$HERE/lib/shepherd.sh"

TARGET="${1:-$PWD}"
[[ "$TARGET" == "-h" || "$TARGET" == "--help" ]] && { sed -n '2,25p' "$0"; exit 0; }
[[ -d "$TARGET" ]] || { printf 'not a directory: %s\n' "$TARGET" >&2; exit 2; }
cd "$TARGET" || exit 2
git rev-parse --show-toplevel >/dev/null 2>&1 || {
  printf 'not a git repository: %s\n' "$TARGET" >&2; exit 2
}

command -v gh >/dev/null 2>&1 || { printf 'gh is required\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 1; }

repo_json="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null)" || {
  printf 'could not resolve the repository with gh\n' >&2; exit 1
}
REPO="$(printf '%s' "$repo_json" | jq -r '.nameWithOwner // empty')"
DEFAULT="$(printf '%s' "$repo_json" | jq -r '.defaultBranchRef.name // empty')"
[[ -n "$REPO" && -n "$DEFAULT" ]] || {
  printf 'could not resolve the repository with gh\n' >&2; exit 1
}


prs="$(gh pr list --repo "$REPO" --state open --label dependencies --limit 100 \
  --json "$SHEPHERD_PR_FIELDS" 2>/dev/null)" || {
  printf 'could not list pull requests for %s\n' "$REPO" >&2; exit 1
}

# A run's wall time is updatedAt - createdAt; startedAt can be null for a run
# that was queued and never started. Failures on the default branch are kept:
# a failing run took as long as it took, and the loop is sizing a wait, not
# judging health. No runs at all (a repo without Actions) falls back to 300 s.
runs="$(gh run list --repo "$REPO" --branch "$DEFAULT" --status completed --limit 20 \
  --json createdAt,updatedAt 2>/dev/null)" || runs='[]'
ci_seconds="$(printf '%s' "$runs" | jq -r '
  [ .[] | select(.createdAt != null and .updatedAt != null)
        | ((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601))
        | select(. > 0) ]
  | if length == 0 then 300
    else sort | .[length / 2 | floor] end' 2>/dev/null)"
[[ "$ci_seconds" =~ ^[0-9]+$ ]] || ci_seconds=300

printf '%s' "$prs" | jq \
  --arg repo "$REPO" --arg default "$DEFAULT" --argjson ci "$ci_seconds" \
  "$SHEPHERD_JQ_LIB"'
  def rank:
    (.labels | map(.name) | map(select(startswith("merge-risk:"))) | first // "")
    | if . == "merge-risk:low" then 0
      elif . == "" then 1
      elif . == "merge-risk:medium" then 2
      elif . == "merge-risk:high" then 3
      else 4 end;
  map(select(.isDraft | not)) as $open
  | {
      repo: $repo,
      default_branch: $default,
      ci_seconds: $ci,
      targets: ($open
        | map(select(.autoMergeRequest != null))
        | sort_by([rank, .createdAt])
        | map(summary)),
      skipped_no_automerge: ($open
        | map(select(.autoMergeRequest == null))
        | sort_by(.createdAt)
        | map({number, title, author: .author.login}))
    }'
