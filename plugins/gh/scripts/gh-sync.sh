#!/usr/bin/env bash
# gh-sync.sh — sync the current checkout, or every checkout one level down.
#
# Usage:
#   gh-sync.sh [--dry-run] [--no-install] [-j N] [path]
#
# Scope comes from the target directory, so no caller has to classify it:
#   - the directory is a git repo        -> sync that repo
#   - the directory is not a git repo    -> sync every immediate subdirectory
#                                           that is a git repo, non-recursively
#
# Subdirectories that are not git repos are skipped without comment. Nothing is
# ever cloned: only checkouts that already exist locally are touched.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SCRIPT="$HERE/gh-sync-repo.sh"

DRY_RUN=0
NO_INSTALL=0
JOBS=4
TARGET=""

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -j) shift; JOBS="${1:-4}" ;;
    -j*) JOBS="${1#-j}" ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

# An unvalidated -j is not merely wrong, it hangs: in arithmetic context a
# non-numeric word evaluates to 0, so the throttle condition "0 >= JOBS" is
# permanently true and no job is ever launched.
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { printf 'invalid -j value: %s\n' "$JOBS" >&2; exit 2; }

TARGET="${TARGET:-$PWD}"
[[ -d "$TARGET" ]] || { printf 'not a directory: %s\n' "$TARGET" >&2; exit 2; }
TARGET="$(cd "$TARGET" && pwd)"

[[ -x "$REPO_SCRIPT" || -r "$REPO_SCRIPT" ]] || {
  printf 'missing %s\n' "$REPO_SCRIPT" >&2; exit 2
}

export GH_SYNC_DRY_RUN="$DRY_RUN"
export GH_SYNC_NO_INSTALL="$NO_INSTALL"

# ------------------------------------------------------------- repo scope ---

if git -C "$TARGET" rev-parse --show-toplevel >/dev/null 2>&1; then
  bash "$REPO_SCRIPT" "$TARGET"
  exit 0
fi

# ----------------------------------------------------------- fan-out scope ---

repos=()
for dir in "$TARGET"/*/; do
  dir="${dir%/}"
  [[ -d "$dir" ]] || continue
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || continue
  # Only the checkout root counts, never a subdirectory of one.
  [[ "$top" == "$dir" ]] && repos+=("$dir")
done

if ((${#repos[@]} == 0)); then
  printf 'No git repositories directly inside %s\n' "$TARGET"
  exit 0
fi

# Unchecked, a failed mktemp leaves TMP empty, which turns the report into
# `cat /*` and the cleanup into `rm -rf ""`.
TMP="$(mktemp -d)" || { printf 'cannot create a temporary directory\n' >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT

# Bounded parallelism with plain job control rather than xargs: each job needs a
# numbered output file so the report can be assembled in directory order instead
# of whatever order the jobs happen to finish in, and that is awkward to thread
# through xargs quoting.
i=0
for repo in "${repos[@]}"; do
  while (( $(jobs -pr | wc -l) >= JOBS )); do
    wait -n 2>/dev/null || sleep 0.2
  done
  # The job records its own exit status into its own report, so a crashed or
  # killed repo cannot pass for one that simply had nothing to say. Doing it here
  # rather than with `wait <pid>` keeps it correct on bash 5, where the throttle
  # above has already reaped some children.
  {
    bash "$REPO_SCRIPT" "$repo" 2>&1
    rc=$?
    ((rc == 0)) || printf '  ✗ sync script exited with status %d\n' "$rc"
  } > "$TMP/$(printf '%04d' "$i")" &
  i=$((i + 1))
done
wait

printf '%s (%d repos)\n\n' "$TARGET" "${#repos[@]}"
cat "$TMP"/* 2>/dev/null
