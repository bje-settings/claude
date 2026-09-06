#!/usr/bin/env bash
# ft-wait-pr.sh: block until a pull request has an answer, or the wait runs out.
#
#   ft-wait-pr.sh <repo> <pr> [--timeout <seconds>] [--interval <seconds>]
#
# Prints one word and exits:
#   merged   the pull request merged                                  exit 0
#   passed   still open, every check green, nothing left to wait for  exit 0
#   failed   a check failed, or the pull request was closed unmerged  exit 1
#   pending  the wait ran out with checks still running               exit 3
# Usage errors exit 2; a gh that cannot answer at all exits 4.
#
# This blocks in the foreground on purpose. A worker that arms a wake and ends its
# turn leaves the orchestrator looking at "waiting" and the work stopped; the
# caller sets the Bash tool's own timeout above this one and gets an answer or a
# `pending` it can act on. Default timeout is 540 seconds, under the 600 the
# calling skill sets.
#
# A pull request with no checks at all is not a pull request to wait on: it is
# reported `passed` once seen twice, the same rule /workstreams:run uses, since
# workflows may not have queued yet on the first look.
#
# Overridable for tests: FT_GH (the gh command, default `gh`).
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-wait-pr.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
repo="${1:-}"; pr="${2:-}"; shift 2 2>/dev/null || true
[[ -n "$repo" && -n "$pr" ]] || { usage >&2; exit 2; }
[[ "$repo" == */* ]] || die "repo must be owner/name, got: $repo" 2
[[ "$pr" =~ ^[0-9]+$ ]] || die "pull request must be a number, got: $pr" 2

timeout=540
interval=30
while (($#)); do
  case "$1" in
    --timeout)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || die '--timeout needs a number of seconds' 2
      timeout="$2"; shift 2 ;;
    --interval)
      # Zero would spin without the elapsed time ever reaching the timeout.
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || die '--interval needs a number of seconds from 1' 2
      interval="$2"; shift 2 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
GH="${FT_GH:-gh}"

waited=0
seen_none=0
while :; do
  answer="$("$GH" pr view "$pr" --repo "$repo" --json state,isDraft,statusCheckRollup 2>&1)" \
    || die "cannot read pull request $pr in $repo: $(printf '%s' "$answer" | tr '\n' ' ' | cut -c1-160)" 4
  folded="$(printf '%s' "$answer" | jq -c -f "$LIB/checks.jq" 2>/dev/null)" \
    || die "gh answered with something this cannot read for pull request $pr: $(printf '%s' "$answer" | tr '\n' ' ' | cut -c1-160)" 4

  state="$(printf '%s' "$folded" | jq -r '.state')"
  checks="$(printf '%s' "$folded" | jq -r '.checks')"

  case "$state" in
    MERGED) printf 'merged\n'; exit 0 ;;
    CLOSED) printf 'failed\n'; exit 1 ;;
  esac

  case "$checks" in
    fail) printf 'failed\n'; exit 1 ;;
    pass) printf 'passed\n'; exit 0 ;;
    none)
      # Twice in a row with nothing queued means there is nothing coming.
      seen_none=$((seen_none + 1))
      [[ "$seen_none" -ge 2 ]] && { printf 'passed\n'; exit 0; }
      ;;
    *) seen_none=0 ;;
  esac

  [[ "$waited" -ge "$timeout" ]] && { printf 'pending\n'; exit 3; }
  sleep "$interval"
  waited=$((waited + interval))
done
