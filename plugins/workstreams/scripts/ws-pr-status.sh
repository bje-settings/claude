#!/usr/bin/env bash
# ws-pr-status.sh: reduce one pull request to the fields the run loop decides on.
#
#   ws-pr-status.sh <number | #number | url>
#
# Prints one JSON object:
#   {
#     "number": 12, "url": "...", "title": "...",
#     "state": "OPEN|MERGED|CLOSED", "draft": true|false,
#     "base": "main", "head": "wktr-12-thing", "headSha": "...",
#     "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN",
#     "checks": "pass|fail|pending|none",
#     "failing": ["lint"],
#     "reviewDecision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|"
#   }
#
# checks folds the status rollup (see lib/pr-status.jq): fail if any check failed,
# failed to start, errored, timed out, was cancelled, went stale, or needs action;
# pending if none failed but any is still running or has no conclusion; pass if
# every check succeeded, was neutral, or skipped; none if there are none. failing
# names the checks that failed (a CheckRun's name or a StatusContext's context).
#
# Exit 0 on success, 1 when gh or jq fails or the PR does not exist, 2 on usage.
# Written for bash 3.2.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die()   { printf 'ws-pr-status.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") printf 'ws-pr-status.sh: a pull request number or url is required\n\n' >&2; usage >&2; exit 2 ;;
  -*) die "unknown flag: $1" 2 ;;
esac
[[ $# -eq 1 ]] || die "exactly one pull request, got $# arguments" 2

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

FIELDS='number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup'

raw="$(gh pr view "${1#\#}" --json "$FIELDS")" || die "gh pr view failed for $1"
printf '%s' "$raw" | jq -f "$LIB/pr-status.jq" || die 'jq failed while folding the pull request'
