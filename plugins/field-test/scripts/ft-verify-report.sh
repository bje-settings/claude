#!/usr/bin/env bash
# ft-verify-report.sh: check a field-test report against GitHub, pull request by
# pull request.
#
#   ft-verify-report.sh <report.json> [--repo <owner/name>]
#
# report.json is what the target skill claimed:
#   {"repo": "owner/name", "prs": [{"number": 11, "claimed": "merged"}, ...]}
# `claimed` is one of merged, closed, open, skipped. --repo overrides the repo in
# the file.
#
# Prints {ok, checked, matched, mismatches, results} and exits 0 when every claim
# holds, 1 when any does not, 2 on usage. A mismatch is a finding: the loop takes
# it back through ft-issue.sh like any other.
#
# The comparison is in lib/verify.jq. Nothing here trusts the report: a pull
# request gh cannot answer for is a mismatch, not a pass.
#
# Overridable for tests: FT_GH (the gh command, default `gh`).
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-verify-report.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

report="$1"; shift
repo=""
while (($#)); do
  case "$1" in
    --repo)
      [[ -n "${2:-}" && "${2:-}" != -* ]] || die '--repo needs a value' 2
      repo="$2"; shift 2 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
GH="${FT_GH:-gh}"

[[ -f "$report" ]] || die "no report at $report" 2
jq -e '(.prs | type) == "array"' "$report" >/dev/null 2>&1 \
  || die "report has no prs array: $report" 2
[[ -n "$repo" ]] || repo="$(jq -r '.repo // ""' "$report")"
[[ -n "$repo" ]] || die 'no repository: put one in the report or pass --repo' 2

claims="$(jq -c '[.prs[] | {number: .number, claimed: (.claimed // "")}]' "$report")" \
  || die "cannot read the claims out of $report"

actual='[]'
for number in $(printf '%s' "$claims" | jq -r '.[].number'); do
  if answer="$("$GH" pr view "$number" --repo "$repo" --json number,state,isDraft 2>&1)"; then
    actual="$(jq -c --argjson a "$actual" --argjson r "$answer" '$a + [$r]' <<< 'null')" \
      || die 'jq failed while collecting pull request state'
  else
    actual="$(jq -c --argjson a "$actual" --argjson n "$number" --arg e "$(printf '%s' "$answer" | tr '\n' ' ' | cut -c1-160)" \
      '$a + [{number: $n, error: $e}]' <<< 'null')"
  fi
done

result="$(jq -n --argjson claims "$claims" --argjson actual "$actual" -f "$LIB/verify.jq")" \
  || die 'jq failed while comparing the report against GitHub'
printf '%s\n' "$result"

# Exit 1 when anything did not match, so a caller can branch on the status alone.
printf '%s' "$result" | jq -e '.ok' >/dev/null
