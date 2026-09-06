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
# Prints {ok, checked, matched, mismatches, results} and exits:
#   0  every claim holds
#   1  at least one claim does not; each mismatch is a finding the loop takes
#      back through ft-issue.sh like any other
#   2  usage, or a report this cannot read (no prs array, a number written as
#      a word, no repository)
#   3  the report names no pull requests: nothing to check is not a pass
#   4  gh or jq could not answer, so no claim was checked
#
# The comparison is in lib/verify.jq. Nothing here trusts the report: a pull
# request gh cannot answer for is a mismatch, not a pass. Pull request numbers
# written as strings ("50") are read as numbers, since the report is assembled
# from a markdown table.
#
# Overridable for tests: FT_GH (the gh command, default `gh`).
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq' 4
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
GH="${FT_GH:-gh}"

[[ -f "$report" ]] || die "no report at $report" 2
jq -e . "$report" >/dev/null 2>&1 || die "report is not valid JSON: $report" 2
jq -e '(.prs | type) == "array"' "$report" >/dev/null 2>&1 \
  || die "report has no prs array: $report" 2
[[ -n "$repo" ]] || repo="$(jq -r '.repo // ""' "$report")"
[[ -n "$repo" ]] || die 'no repository: put one in the report or pass --repo' 2

# A number written as a string is read as a number; anything else is refused
# rather than compared, because `50 == "50"` is false to jq and would read as
# "gh gave no answer".
claims="$(jq -c '[.prs[] | {number: (if (.number | type) == "string" and (.number | test("^[0-9]+$"))
                                    then (.number | tonumber) else .number end),
                          claimed: (.claimed // "")}]' "$report")" \
  || die "cannot read the claims out of $report" 2
bad="$(printf '%s' "$claims" | jq -r '[.[] | select((.number | type) != "number") | .number | tostring] | join(", ")')"
[[ -z "$bad" ]] || die "pull request numbers must be numbers, got: $bad" 2

if [[ "$(printf '%s' "$claims" | jq 'length')" -eq 0 ]]; then
  printf '{"ok": false, "checked": 0, "matched": 0, "mismatches": [], "results": [],\n "reason": "nothing to check: the report names no pull requests"}\n'
  exit 3
fi

excerpt() { printf '%s' "$1" | tr '\n' ' ' | cut -c1-160; }

actual='[]'
errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT
for number in $(printf '%s' "$claims" | jq -r '.[].number'); do
  if answer="$("$GH" pr view "$number" --repo "$repo" --json number,state,isDraft 2>"$errfile")"; then
    actual="$(jq -c --argjson a "$actual" --argjson r "$answer" '$a + [$r]' <<< 'null' 2>/dev/null)" \
      || die "gh answered with something this cannot read for pull request $number: $(excerpt "$answer")" 4
  else
    actual="$(jq -c --argjson a "$actual" --argjson n "$number" --arg e "$(excerpt "$(cat "$errfile")")" \
      '$a + [{number: $n, error: $e}]' <<< 'null')" \
      || die "jq failed while recording that gh could not answer for pull request $number" 4
  fi
done

result="$(jq -n --argjson claims "$claims" --argjson actual "$actual" -f "$LIB/verify.jq")" \
  || die 'jq failed while comparing the report against GitHub' 4
printf '%s\n' "$result"

# Exit 1 when anything did not match, so a caller can branch on the status alone.
printf '%s' "$result" | jq -e '.ok' >/dev/null
