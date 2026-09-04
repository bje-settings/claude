#!/usr/bin/env bash
# gh-sync-repo.sh — sync one checkout: move to the default branch, fast-forward,
# install if a lock file changed, and prune branches whose work has landed.
#
# Usage:
#   gh-sync-repo.sh [--dry-run] [--no-install] <repo-path>
#
# Flags may also arrive as GH_SYNC_DRY_RUN=1 / GH_SYNC_NO_INSTALL=1, which is how
# gh-sync.sh passes them through xargs.
#
# Exit status is 0 for a synced repo AND for a skipped one: skipping is a normal
# outcome, not a failure. Non-zero means the script itself broke.

set -uo pipefail

DRY_RUN="${GH_SYNC_DRY_RUN:-0}"
NO_INSTALL="${GH_SYNC_NO_INSTALL:-0}"
REPO=""

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *) REPO="$1" ;;
  esac
  shift
done

[[ -n "$REPO" ]] || { echo "usage: gh-sync-repo.sh [--dry-run] [--no-install] <repo-path>" >&2; exit 2; }

NAME="$(basename "$REPO")"   # refined to the work tree name once resolved

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }

header() { printf '%s\n' "$NAME"; }

header_printed=0
ensure_header() { ((header_printed)) || { header; header_printed=1; }; }

# A skipped repo prints its reason and exits cleanly. Nothing has been mutated at
# the point any of these fire.
skip() { ensure_header; bad "skipped: $*"; exit 0; }

# ---------------------------------------------------------------- preflight ---

cd "$REPO" 2>/dev/null || skip "cannot enter directory"

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || skip "not a git repository"
cd "$TOP" || skip "cannot enter work tree"
NAME="$(basename "$TOP")"

git remote get-url origin >/dev/null 2>&1 || skip "no 'origin' remote"

GITDIR="$(git rev-parse --git-dir)"
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  [[ -e "$GITDIR/$marker" ]] && skip "git operation in progress ($marker)"
done

# Untracked files deliberately do not block: checkout, fast-forward, and branch
# deletion cannot touch them. Only tracked modifications and staged changes do.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  skip "uncommitted changes"
fi

# ----------------------------------------------------------- default branch ---

resolve_default_branch() {
  local ref name
  ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
  if [[ -z "$ref" ]]; then
    git remote set-head origin --auto >/dev/null 2>&1
    ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
  fi
  if [[ -n "$ref" ]]; then printf '%s\n' "${ref#refs/remotes/origin/}"; return 0; fi

  name="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)"
  if [[ -n "$name" ]]; then printf '%s\n' "$name"; return 0; fi

  for name in main master; do
    if git show-ref --verify --quiet "refs/remotes/origin/$name"; then
      printf '%s\n' "$name"; return 0
    fi
  done
  return 1
}

DEFAULT="$(resolve_default_branch)" || skip "cannot determine the default branch"

# ------------------------------------------------------------------- lockfiles ---

LOCKFILES=(pnpm-lock.yaml yarn.lock package-lock.json bun.lockb)

lock_fingerprint() {
  local f
  for f in "${LOCKFILES[@]}"; do
    [[ -f "$f" ]] && printf '%s:%s ' "$f" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
  done
}

install_deps() {
  if [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile
  elif [[ -f yarn.lock ]]; then
    # Yarn classic and Berry spell the same intent differently.
    if [[ "$(yarn --version 2>/dev/null)" == 1.* ]]; then
      yarn install --frozen-lockfile
    else
      yarn install --immutable
    fi
  elif [[ -f package-lock.json ]]; then
    npm ci
  elif [[ -f bun.lockb ]]; then
    bun install --frozen-lockfile
  fi
}

# ------------------------------------------------------------------- fetch ---

ensure_header
if ! git fetch --prune origin >/dev/null 2>&1; then
  bad "fetch failed; nothing changed"
  exit 0
fi

LOCKS_BEFORE="$(lock_fingerprint)"
CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
CAN_ADVANCE=1

# --------------------------------------------------- checkout + fast-forward ---

# The default branch may be checked out in another worktree, in which case this
# checkout cannot succeed. That is not fatal: pruning still has value.
if [[ "$CURRENT" != "$DEFAULT" ]]; then
  if ((DRY_RUN)); then
    note "would switch from $CURRENT to $DEFAULT"
  elif git checkout "$DEFAULT" >/dev/null 2>&1; then
    ok "switched from $CURRENT to $DEFAULT"
  else
    bad "cannot switch to $DEFAULT (checked out elsewhere?); pruning only"
    CAN_ADVANCE=0
  fi
fi

if ((CAN_ADVANCE)); then
  TARGET="$(git rev-parse --short "origin/$DEFAULT" 2>/dev/null)"
  if ! git show-ref --verify --quiet "refs/heads/$DEFAULT"; then
    # Only reachable in --dry-run, where the checkout above was not performed.
    note "would create $DEFAULT from origin/$DEFAULT ($TARGET)"
  else
    # Always compare the default branch itself, never HEAD: in --dry-run we have
    # not switched, so HEAD is still whatever branch the user was sitting on.
    BEFORE="$(git rev-parse --short "$DEFAULT")"
    if [[ "$BEFORE" == "$TARGET" ]]; then
      note "$DEFAULT already up to date ($BEFORE)"
    elif ! git merge-base --is-ancestor "$DEFAULT" "origin/$DEFAULT" 2>/dev/null; then
      bad "$DEFAULT has diverged from origin/$DEFAULT; needs a manual merge"
    elif ((DRY_RUN)); then
      note "would fast-forward $DEFAULT $BEFORE..$TARGET"
    elif git merge --ff-only "origin/$DEFAULT" >/dev/null 2>&1; then
      ok "fast-forwarded $DEFAULT $BEFORE..$TARGET"
    else
      bad "could not fast-forward $DEFAULT"
    fi
  fi
fi

# ----------------------------------------------------------------- install ---

if ((CAN_ADVANCE)) && ((!NO_INSTALL)); then
  LOCKS_AFTER="$(lock_fingerprint)"
  if [[ "$LOCKS_BEFORE" != "$LOCKS_AFTER" ]]; then
    if ((DRY_RUN)); then
      note "lock file would change; would run install"
    elif install_deps >/dev/null 2>&1; then
      ok "lock file changed; dependencies installed"
    else
      bad "lock file changed but install failed; run it by hand"
    fi
  fi
fi

# ------------------------------------------------------------- merge proof ---

# One API call covers every branch in the repo. `head:<branch>` matches a PR's
# head ref regardless of how it was merged, so this catches squash and rebase
# merges that leave no ancestry behind.
PR_REFS=""
PR_LOOKUP_OK=1
if command -v gh >/dev/null 2>&1; then
  PR_REFS="$(gh pr list --state merged --limit 200 --json headRefName --jq '.[].headRefName' 2>/dev/null)" \
    || PR_LOOKUP_OK=0
else
  PR_LOOKUP_OK=0
fi
((PR_LOOKUP_OK)) || note "could not read merged PRs; falling back to ancestry only"

# Ancestry catches the other case: merged locally with no PR at all.
ANCESTRY="$(git branch --merged "origin/$DEFAULT" --format='%(refname:short)' 2>/dev/null)"

in_list() {
  local needle="$1" line
  while IFS= read -r line; do
    [[ "$line" == "$needle" ]] && return 0
  done <<< "$2"
  return 1
}

# branch -> worktree path as tab-separated lines. Deliberately not an associative
# array: /bin/bash on macOS is 3.2, which has none.
WORKTREES=""
_wt=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *) _wt="${line#worktree }" ;;
    branch\ refs/heads/*) WORKTREES+="${line#branch refs/heads/}	$_wt"$'\n' ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null)

worktree_for() {
  local needle="$1" br path
  while IFS=$'\t' read -r br path; do
    [[ "$br" == "$needle" ]] && { printf '%s\n' "$path"; return 0; }
  done <<< "$WORKTREES"
  return 0
}

# ------------------------------------------------------------------- prune ---

while IFS= read -r branch; do
  [[ -z "$branch" || "$branch" == "$DEFAULT" ]] && continue

  proof=""
  if [[ -n "$PR_REFS" ]] && in_list "$branch" "$PR_REFS"; then
    proof="merged PR"
  elif [[ -n "$ANCESTRY" ]] && in_list "$branch" "$ANCESTRY"; then
    proof="merged into $DEFAULT"
  fi

  if [[ -z "$proof" ]]; then
    note "kept $branch (no merge proof)"
    continue
  fi

  sha="$(git rev-parse --short "$branch")"
  wt="$(worktree_for "$branch")"

  # Checked before the tip guard below, so that a branch protected by unfinished
  # work in a worktree is reported for that reason rather than an incidental one.
  if [[ -n "$wt" && "$wt" != "$TOP" ]]; then
    if [[ -n "$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      bad "kept $branch and its worktree $wt (uncommitted changes)"
      continue
    fi
  fi

  # A branch pointing exactly at the default branch tip is one that was just
  # created and not committed to yet. Ancestry calls it merged; deleting it would
  # pull the rug out from under someone about to start work.
  if [[ "$(git rev-parse "$branch")" == "$(git rev-parse "origin/$DEFAULT")" ]]; then
    note "kept $branch (sitting on the $DEFAULT tip, nothing to prune)"
    continue
  fi

  if [[ -n "$wt" && "$wt" != "$TOP" ]]; then
    if ((DRY_RUN)); then
      note "would remove worktree $wt and delete $branch ($sha, $proof)"
      continue
    fi
    if ! git worktree remove "$wt" >/dev/null 2>&1; then
      bad "kept $branch (could not remove worktree $wt)"
      continue
    fi
    ok "removed worktree $wt"
  fi

  if ((DRY_RUN)); then
    note "would delete $branch ($sha, $proof)"
  elif git branch -D "$branch" >/dev/null 2>&1; then
    # -D rather than -d because a squash-merged branch is not an ancestor of the
    # default branch. The SHA makes it recoverable: git branch <name> <sha>.
    ok "deleted $branch ($sha, $proof)"
  else
    bad "could not delete $branch"
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

((DRY_RUN)) || git worktree prune >/dev/null 2>&1

exit 0
