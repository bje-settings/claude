#!/usr/bin/env bash
# ws-issues.sh: resolve issue selectors to one JSON array of issues.
#
#   ws-issues.sh <selector>...
#
# Selectors, in any mix:
#   12  #12  10-14        issue numbers and inclusive ranges
#   label:<name>          open issues carrying the label
#   milestone:<title>     open issues in the milestone
#   anything else         joined into one `gh issue list --search` query
#                         (each such selector is reported on stderr)
#
# Output is sorted by number with duplicates removed. Each issue carries number,
# title, body, state, url, labels (names only), and refs: the other issue numbers
# mentioned as #N in its body, for the skill's blocked-on analysis. A number that
# turns out to be a pull request is an error, not an issue.
#
# Exit 0 with issues, 3 when nothing matched (stdout is still `[]`), 2 on usage,
# 1 when gh or jq fails. Deterministic: no judgment lives here.
#
# Written for bash 3.2.

set -uo pipefail

FIELDS='number,title,body,state,url,labels'
LIMIT="${WS_ISSUE_LIMIT:-200}"
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die()   { printf 'ws-issues.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") printf 'ws-issues.sh: at least one selector is required\n\n' >&2; usage >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

numbers=""
search=""
results=""

# collect <json>: accumulate one gh result (object or array) into results
collect() { results="${results}${results:+
}$1"; }

# list <flag> <value> <label-for-errors>: one gh issue list call, warning when it saturates
list() {
  local out
  out="$(gh issue list --state open --limit "$LIMIT" "$1" "$2" --json "$FIELDS")" \
    || die "gh issue list failed for $3"
  if [[ "$(printf '%s' "$out" | jq 'length')" == "$LIMIT" ]]; then
    printf 'ws-issues.sh: warning: %s returned %s issues, the limit; some may be missing\n' "$3" "$LIMIT" >&2
  fi
  collect "$out"
}

for sel in "$@"; do
  case "$sel" in
    label:*|milestone:*)
      flag="--${sel%%:*}"; value="${sel#*:}"
      [[ -n "$value" ]] || die "empty value in selector: $sel" 2
      list "$flag" "$value" "$sel" ;;
    \#[0-9]*|[0-9]*)
      n="${sel#\#}"
      if [[ "$n" =~ ^[0-9]+-[0-9]+$ ]]; then
        lo="${n%-*}"; hi="${n#*-}"
        (( lo <= hi )) || die "bad range: $sel" 2
        i="$lo"
        while (( i <= hi )); do numbers="$numbers $i"; i=$((i + 1)); done
      elif [[ "$n" =~ ^[0-9]+$ ]]; then
        numbers="$numbers $n"
      else
        # Starts like a number but is not one (1,3 or 1O): more likely a typo than a search.
        die "not a number, range, label:, or milestone: selector: $sel" 2
      fi ;;
    *)
      printf 'ws-issues.sh: treating as search text: %s\n' "$sel" >&2
      search="${search}${search:+ }$sel" ;;
  esac
done

for n in $numbers; do
  out="$(gh issue view "$n" --json "$FIELDS")" || die "gh issue view failed for #$n"
  case "$(printf '%s' "$out" | jq -r '.url // ""')" in
    */pull/*) die "#$n is a pull request, not an issue" ;;
  esac
  collect "$out"
done

[[ -n "$search" ]] && list --search "$search" "search: $search"

merged="$(printf '%s\n' "$results" | jq -s -f "$LIB/issues-merge.jq")" || die 'jq failed while merging issues'

printf '%s\n' "$merged"
if [[ "$(printf '%s' "$merged" | jq 'length')" == "0" ]]; then
  die "no issues matched: $*" 3
fi
