#!/usr/bin/env bash
# session-start.sh — report-only sync check at session start.
#
# Never changes a branch, worktree, or working tree: the fan-out branch runs
# gh-sync.sh in --dry-run, and the in-repo branch does not touch the network at
# all. The fan-out branch does fetch, which updates remote-tracking refs.
# Always exits 0, so nothing here can stop a session from starting. Stays silent
# unless there is something worth acting on, because a hook that speaks every
# single time stops being read.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../scripts/gh-sync.sh"

command -v python3 >/dev/null 2>&1 || exit 0

# The hook receives its JSON payload on stdin; cwd is the useful field. Parsed
# with python3 rather than a regex, because a greedy match picks up the last
# cwd-like key in the payload and any escaped character truncates the path, and
# a wrong answer here points the fan-out at an unintended directory.
PAYLOAD="$(cat 2>/dev/null || true)"
CWD="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("cwd", "") or "")
except Exception:
    print("")
' 2>/dev/null)"
[[ -n "${CWD:-}" && -d "$CWD" ]] || CWD="$PWD"
[[ -r "$SYNC" ]] || exit 0

emit() {
  python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": sys.stdin.read(),
}}))' <<< "$1"
  exit 0
}

if git -C "$CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  # ---- in a repo: purely local check, no network -------------------------
  current="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [[ -n "$current" && "$current" != "HEAD" ]] || exit 0

  ref="$(git -C "$CWD" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
  default="${ref#refs/remotes/origin/}"
  if [[ -z "$default" ]]; then
    for candidate in main master; do
      if git -C "$CWD" show-ref --verify --quiet "refs/heads/$candidate"; then
        default="$candidate"; break
      fi
    done
  fi
  [[ -n "$default" && "$default" != "$current" ]] || exit 0

  emit "This session started on branch '$current'; the repository's default branch is '$default'.
Ask the user whether they would like to run /gh:sync to move to '$default', fast-forward it, and
prune branches whose work has already landed. Ask first. Do not run it unprompted, and do not
mention this if the user is clearly in the middle of something else."
fi

# ---- not a repo: dry-run report across the immediate subdirectories -------
report="$(bash "$SYNC" --dry-run --no-install "$CWD" 2>/dev/null)" || exit 0

# Only speak when the report contains something actionable: a proposed change
# ("would ..."), a problem ("✗"), or a degraded run ("could not ..."). A run
# whose merge lookups all failed has nothing to propose, and silence there would
# read as "everything is in order" rather than "nothing could be checked".
printf '%s' "$report" | grep -q -e 'would ' -e '✗' -e 'could not' || exit 0

emit "A read-only /gh:sync check ran for the repositories below. No branch, worktree, or
working tree was changed (it does fetch, so remote-tracking refs are current).

$report

Offer to run /gh:sync to apply this for real. Ask first, and report the outcome plainly,
including any repository that gets skipped and why."
