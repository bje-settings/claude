#!/usr/bin/env bash
# session-start.sh — report-only sync check at session start.
#
# Never mutates a repo: the fan-out branch runs gh-sync.sh in --dry-run, and the
# in-repo branch does not even fetch. Always exits 0, so nothing here can stop a
# session from starting. Stays silent unless there is something worth acting on,
# because a hook that speaks every single time stops being read.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../scripts/gh-sync.sh"

# The hook receives its JSON payload on stdin; cwd is the useful field. Fall back
# to $PWD rather than taking a dependency on jq being installed.
PAYLOAD="$(cat 2>/dev/null || true)"
CWD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[[ -n "${CWD:-}" && -d "$CWD" ]] || CWD="$PWD"

command -v python3 >/dev/null 2>&1 || exit 0
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
# ("would ...") or a problem ("✗"). Repos that are already in order say neither.
printf '%s' "$report" | grep -q -e 'would ' -e '✗' || exit 0

emit "A read-only /gh:sync check ran for the repositories below. Nothing was modified.

$report

Offer to run /gh:sync to apply this for real. Ask first, and report the outcome plainly,
including any repository that gets skipped and why."
