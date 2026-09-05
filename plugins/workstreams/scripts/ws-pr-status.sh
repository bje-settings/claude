#!/usr/bin/env bash
# ws-pr-status.sh — reduce one pull request to the fields the run loop decides on.
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
#     "reviewDecision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|"
#   }
#
# checks folds the status rollup: fail if any check failed, errored, timed out,
# was cancelled or needs action; pending if none failed but any is still running;
# pass if every check succeeded, was neutral, or skipped; none if there are none.
#
# Exit 0 on success, 1 when gh fails or the PR does not exist, 2 on usage.
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") printf 'ws-pr-status.sh: a pull request number or url is required\n\n' >&2; usage >&2; exit 2 ;;
  -*) printf 'ws-pr-status.sh: unknown flag: %s\n' "$1" >&2; exit 2 ;;
esac
[[ $# -eq 1 ]] || { printf 'ws-pr-status.sh: exactly one pull request, got %d arguments\n' "$#" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || { printf 'ws-pr-status.sh: jq is required: brew install jq\n' >&2; exit 1; }

FIELDS='number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup'

raw="$(gh pr view "${1#\#}" --json "$FIELDS")" \
  || { printf 'ws-pr-status.sh: gh pr view failed for %s\n' "$1" >&2; exit 1; }

printf '%s' "$raw" | jq '
  def outcome:
    # CheckRun rows carry status/conclusion; StatusContext rows carry state.
    (.conclusion // .state // (if .status == "COMPLETED" then "SUCCESS" else "PENDING" end))
    | ascii_upcase;
  def fold:
    map(outcome) as $o
    | if ($o | length) == 0 then "none"
      elif any($o[]; . == "FAILURE" or . == "ERROR" or . == "TIMED_OUT"
                     or . == "CANCELLED" or . == "ACTION_REQUIRED" or . == "STARTUP_FAILURE") then "fail"
      elif all($o[]; . == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED") then "pass"
      else "pending" end;
  {
    number, url, title, state,
    draft: .isDraft,
    base: .baseRefName,
    head: .headRefName,
    headSha: .headRefOid,
    mergeable: (.mergeable // "UNKNOWN"),
    checks: ((.statusCheckRollup // []) | fold),
    reviewDecision: (.reviewDecision // "")
  }'
