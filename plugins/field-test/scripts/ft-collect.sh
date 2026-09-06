#!/usr/bin/env bash
# ft-collect.sh: turn one field test's recorded events into candidate problems.
#
#   ft-collect.sh <run-dir>              the findings, as a JSON array
#   ft-collect.sh <run-dir> --report     the target's final message, as text
#
# The run directory is what ft-run.sh created and the hooks appended to. The
# decision logic is in lib/collect.jq, one branch per kind of finding; see
# .claude/rules/type-jq.md for why each of those branches has its own fixture.
#
# --report prints the last assistant message from the session transcript the hooks
# recorded on the marker. That is the target's own account of what it did, which is
# the thing worth checking against GitHub rather than trusting.
#
# Exit 0 with the array (possibly empty), 1 on a broken run directory, 2 on usage.
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-collect.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

run_dir="$1"; shift
mode="findings"
case "${1:-}" in
  "") ;;
  --report) mode="report" ;;
  *) die "unknown argument: $1" 2 ;;
esac

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
run_json="$run_dir/run.json"
events_file="$run_dir/events.jsonl"

[[ -f "$run_json" ]] || die "no run marker at $run_json"
jq -e . "$run_json" >/dev/null 2>&1 || die "run marker is not valid JSON: $run_json"

if [[ "$mode" == "report" ]]; then
  transcript="$(jq -r '.transcript_path // ""' "$run_json")"
  [[ -n "$transcript" ]] || die 'the run marker has no transcript_path; no hook event carried one'
  [[ -f "$transcript" ]] || die "no transcript at $transcript"
  # The transcript is JSON lines; -R with fromjson? keeps a truncated final line
  # (the file is still being written) from failing the whole read.
  jq -rRs 'split("\n") | map(select(length > 0) | . as $l | try fromjson catch empty)
    | map(select(.type == "assistant"))
    | last // {}
    | (.message.content // []) | map(select(.type == "text") | .text) | join("\n")' "$transcript"
  exit 0
fi

events='[]'
if [[ -f "$events_file" ]]; then
  events="$(jq -sc . "$events_file")" || die "events file is not valid JSON lines: $events_file"
fi

jq -n --argjson run "$(cat "$run_json")" --argjson events "$events" -f "$LIB/collect.jq" \
  || die 'jq failed while collecting findings'
