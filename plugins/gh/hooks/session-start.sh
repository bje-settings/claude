#!/usr/bin/env bash
# session-start.sh — report-only sync check at session start.
#
# Never changes a branch, worktree, or working tree: the fan-out branch runs
# gh-sync.sh in --dry-run, and the in-repo branch does not touch the network at
# all. The fan-out branch does fetch, which updates remote-tracking refs.
# Always exits 0, so nothing here can stop a session from starting. Stays silent
# unless there is something worth acting on, because a hook that speaks every
# single time stops being read.
#
# The JSON on both ends is handled by hook-io.py, next to this file.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../scripts/gh-sync.sh"
HOOK_IO="$HERE/hook-io.py"

command -v python3 >/dev/null 2>&1 || exit 0
[[ -r "$SYNC" && -r "$HOOK_IO" ]] || exit 0

PAYLOAD="$(cat 2>/dev/null || true)"
CWD="$(printf '%s' "$PAYLOAD" | python3 "$HOOK_IO" cwd 2>/dev/null)"
[[ -n "${CWD:-}" && -d "$CWD" ]] || CWD="$PWD"

if git -C "$CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  # ---- in a repo: purely local check, no network -------------------------
  current="$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [[ -n "$current" && "$current" != "HEAD" ]] || exit 0

  ref="$(git -C "$CWD" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
  default="${ref#refs/remotes/origin/}"
  if [[ -z "$default" ]]; then
    for candidate in main master; do
      git -C "$CWD" show-ref --verify --quiet "refs/heads/$candidate" || continue
      default="$candidate"
      break
    done
  fi
  [[ -n "$default" && "$default" != "$current" ]] || exit 0

  python3 "$HOOK_IO" branch "$current" "$default"
  exit 0
fi

# ---- not a repo: dry-run report across the immediate subdirectories -------
report="$(bash "$SYNC" --dry-run --no-install "$CWD" 2>/dev/null)" || exit 0

# Only speak when the report contains something actionable: a proposed change
# ("would ..."), a problem ("✗"), or a degraded run ("could not ..."). A run
# whose merge lookups all failed has nothing to propose, and silence there would
# read as "everything is in order" rather than "nothing could be checked".
printf '%s' "$report" | grep -q -e 'would ' -e '✗' -e 'could not' || exit 0

printf '%s' "$report" | python3 "$HOOK_IO" report
exit 0
