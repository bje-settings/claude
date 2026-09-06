#!/usr/bin/env bash
# ft-hook.sh — the single entry point for every field-test hook.
#
#   bash ft-hook.sh <PreToolUse|PostToolUse|PostToolUseFailure|SubagentStop|Stop>
#
# Everything this does is JSON, so the work is in hook-io.py beside this file; a
# hook runs on every tool call, so it depends only on what a Mac already ships.
# This wrapper exists to keep the hooks.json commands uniform and to guarantee the
# one thing that matters: it always exits 0. A hook that fails must never be the
# reason a session stops.
#
# hook-io.py's first action is to look for a live run marker for the payload's
# session, and it returns immediately when there is none, which is every session
# that is not a field test.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_IO="$HERE/hook-io.py"

command -v python3 >/dev/null 2>&1 || exit 0
[[ -r "$HOOK_IO" ]] || exit 0
[[ -n "${1:-}" ]] || exit 0

python3 "$HOOK_IO" "$1" 2>/dev/null
exit 0
