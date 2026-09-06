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
# The jq programs below are held in variables filled from a heredoc rather than
# written inline across several lines. Both forms are one shell statement, but kcov
# marks the continuation lines of a multi-line command as code that never runs, so
# an inline program reads as a block of permanently uncovered lines. A heredoc body
# is not instrumented, which is what the coverage number already assumes a jq
# program to be: one line, and the branches inside it tested by their own fixtures
# (see .claude/rules/type-jq.md).


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
  #
  # The last assistant turn that carries text, not simply the last one: a real
  # transcript often ends on a turn holding only thinking and tool_use blocks, and
  # the empty string that would print is indistinguishable from a target that said
  # nothing, which is the one thing this output exists to show.
  read -r -d '' LAST_TEXT_JQ <<'JQ' || true
split("\n") | map(select(length > 0) | . as $l | try fromjson catch empty)
| map(select(.type == "assistant")
      | (.message.content // []) | map(select(.type == "text") | .text) | join("\n")
      | select(length > 0))
| last // ""
JQ
  # Checked, not printed straight out: every way this can fail prints nothing, and
  # nothing is also what a target that said nothing prints. The whole point of this
  # output is telling those two apart.
  report="$(jq -rRs "$LAST_TEXT_JQ" "$transcript")" \
    || die "could not read the transcript at $transcript"
  printf '%s\n' "$report"
  exit 0
fi

events='[]'
if [[ -f "$events_file" ]]; then
  events="$(jq -sc . "$events_file")" || die "events file is not valid JSON lines: $events_file"
fi

jq -n --argjson run "$(cat "$run_json")" --argjson events "$events" -f "$LIB/collect.jq" \
  || die 'jq failed while collecting findings'
