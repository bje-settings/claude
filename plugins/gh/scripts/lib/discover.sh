#!/usr/bin/env bash
# lib/discover.sh — repository discovery shared by the gh plugin scripts.
#
# Source this file, then call:
#
#   discover_repos <target>
#
# Prints one checkout root per line, symlink-resolved (pwd -P), because git
# reports resolved paths and callers compare against them. On macOS /tmp and
# /var are symlinks, so a logical path would never match.
#
# Scope comes from the target, so no caller has to classify it:
#   - the target is inside a git repo  -> that repo's checkout root
#   - the target is not a git repo     -> every immediate subdirectory that is
#                                         the root of a checkout, non-recursively
#
# Subdirectories that are not git repos, and subdirectories that are merely
# inside a repo rather than its root, are skipped without comment. Nothing is
# ever cloned. Returns 1 when the target is not a directory; a target with no
# repositories prints nothing and returns 0.

discover_repos() {
  local target="${1:-$PWD}" real top dir
  [[ -d "$target" ]] || return 1
  target="$(cd "$target" && pwd -P)" || return 1

  if top="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\n' "$top"
    return 0
  fi

  for dir in "$target"/*/; do
    dir="${dir%/}"
    [[ -d "$dir" ]] || continue
    real="$(cd "$dir" && pwd -P)" || continue
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || continue
    # Only the checkout root counts, never a subdirectory of one.
    [[ "$top" == "$real" ]] && printf '%s\n' "$real"
  done
  return 0
}
