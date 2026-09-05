#!/usr/bin/env bash
# ws-issues.sh — resolve issue selectors to one JSON array of issues.
#
#   ws-issues.sh <selector>...
#
# Selectors, in any mix:
#   12  #12  10-14        issue numbers and inclusive ranges
#   label:<name>          open issues carrying the label
#   milestone:<title>     open issues in the milestone
#   anything else         joined into one `gh issue list --search` query
#
# Output is sorted by number with duplicates removed. Each issue carries number,
# title, body, state, url, labels (names only), and refs: the other issue numbers
# mentioned as #N in its body, for the skill's blocked-on analysis.
#
# Exit 0 with issues, 3 when nothing matched (stdout is still `[]`), 2 on usage,
# 1 when gh fails. Deterministic: no judgment lives here.
#
# Written for bash 3.2.

set -uo pipefail

FIELDS='number,title,body,state,url,labels'
LIMIT=200

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") printf 'ws-issues.sh: at least one selector is required\n\n' >&2; usage >&2; exit 2 ;;
esac

numbers=""
search=""
results=""

# collect <json> — accumulate one gh result (object or array) into results
collect() { results="${results}${results:+
}$1"; }

for sel in "$@"; do
  case "$sel" in
    label:*|milestone:*)
      flag="--${sel%%:*}"; value="${sel#*:}"
      [[ -n "$value" ]] || { printf 'ws-issues.sh: empty value in selector: %s\n' "$sel" >&2; exit 2; }
      out="$(gh issue list --state open --limit "$LIMIT" "$flag" "$value" --json "$FIELDS")" \
        || { printf 'ws-issues.sh: gh issue list failed for %s\n' "$sel" >&2; exit 1; }
      collect "$out" ;;
    *)
      n="${sel#\#}"
      if [[ "$n" =~ ^[0-9]+-[0-9]+$ ]]; then
        lo="${n%-*}"; hi="${n#*-}"
        (( lo <= hi )) || { printf 'ws-issues.sh: bad range: %s\n' "$sel" >&2; exit 2; }
        i="$lo"
        while (( i <= hi )); do numbers="$numbers $i"; i=$((i + 1)); done
      elif [[ "$n" =~ ^[0-9]+$ ]]; then
        numbers="$numbers $n"
      else
        search="${search}${search:+ }$sel"
      fi ;;
  esac
done

for n in $numbers; do
  out="$(gh issue view "$n" --json "$FIELDS")" \
    || { printf 'ws-issues.sh: gh issue view failed for #%s\n' "$n" >&2; exit 1; }
  collect "$out"
done

if [[ -n "$search" ]]; then
  out="$(gh issue list --state open --limit "$LIMIT" --search "$search" --json "$FIELDS")" \
    || { printf 'ws-issues.sh: gh issue list failed for search: %s\n' "$search" >&2; exit 1; }
  collect "$out"
fi

merged="$(printf '%s\n' "$results" | jq -s '
  map(if type == "array" then .[] else . end)
  | unique_by(.number)
  | sort_by(.number)
  | map(
      . as $i
      | {
          number, title, state, url,
          body: (.body // ""),
          labels: [.labels[]?.name],
          refs: ([(.body // "") | scan("(?:^|[^A-Za-z0-9/])#([0-9]+)") | .[0] | tonumber]
                 | unique | map(select(. != $i.number)))
        }
    )')"

printf '%s\n' "$merged"
if [[ "$(printf '%s' "$merged" | jq 'length')" == "0" ]]; then
  printf 'ws-issues.sh: no issues matched\n' >&2
  exit 3
fi
