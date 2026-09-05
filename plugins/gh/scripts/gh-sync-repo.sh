#!/usr/bin/env bash
# gh-sync-repo.sh — sync one checkout: move to the default branch, fast-forward,
# install if a lock file changed, and prune branches whose work has landed.
#
# Usage:
#   gh-sync-repo.sh [--dry-run] [--no-install] <repo-path>
#
# Flags may also arrive as GH_SYNC_DRY_RUN=1 / GH_SYNC_NO_INSTALL=1, which is how
# gh-sync.sh passes them to the per-repo jobs it backgrounds.
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

# A skipped repo prints its reason and exits cleanly. The preflight skips below
# all fire before anything is written; the later ones (a missing origin/<default>,
# an unreadable ref list) can follow a fetch.
skip() { ensure_header; bad "skipped: $*"; exit 0; }

# ---------------------------------------------------------------- preflight ---

cd "$REPO" 2>/dev/null || skip "cannot enter directory"

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || skip "not a git repository"
cd "$TOP" || skip "cannot enter work tree"
NAME="$(basename "$TOP")"

git remote get-url origin >/dev/null 2>&1 || skip "no 'origin' remote"

# Checked for every worktree, not just this one. A rebase in a linked worktree
# leaves its HEAD detached, so that worktree contributes no branch mapping later
# and its branch would otherwise look free to delete.
check_in_progress() {
  local dir gitdir marker
  dir="$1"
  gitdir="$(git -C "$dir" rev-parse --git-dir 2>/dev/null)" || return 0
  [[ "$gitdir" = /* ]] || gitdir="$dir/$gitdir"
  for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    [[ -e "$gitdir/$marker" ]] && { printf '%s' "$marker"; return 0; }
  done
  return 0
}

marker="$(check_in_progress "$TOP")"
[[ -z "$marker" ]] || skip "git operation in progress ($marker)"

# Untracked files deliberately do not block: checkout, fast-forward, and branch
# deletion cannot touch them. Only tracked modifications and staged changes do.
# A failed probe must not read as clean, so the exit status is checked separately
# from the output: a corrupt or unreadable index exits non-zero with empty stdout.
DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null)" \
  || skip "cannot read the working tree state"
[[ -n "$DIRTY" ]] && skip "uncommitted changes"

# ----------------------------------------------------------- default branch ---

resolve_default_branch() {
  local ref name
  ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"
  if [[ -z "$ref" ]] && ((!DRY_RUN)); then
    # Repairing origin/HEAD writes a ref, so it is skipped in --dry-run; the
    # fallbacks below answer the same question without touching the repository.
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

LOCKFILES=(pnpm-lock.yaml yarn.lock package-lock.json)

# pnpm, Yarn Berry, and npm. Yarn 1 and bun are deliberately out of scope: a
# repo on either gets the lock-file notice and installs by hand.
install_deps() {
  if [[ -f pnpm-lock.yaml ]]; then
    pnpm install --frozen-lockfile
  elif [[ -f yarn.lock ]]; then
    yarn install --immutable
  elif [[ -f package-lock.json ]]; then
    npm ci
  else
    return 3   # no recognised lock file; nothing to install
  fi
}

# ------------------------------------------------------------------- fetch ---

ensure_header
if ! git fetch --prune origin >/dev/null 2>&1; then
  bad "fetch failed; nothing changed"
  exit 0
fi

# Everything below compares against origin/$DEFAULT. If that ref is missing, git
# reports it by echoing the name back rather than failing loudly, which would
# turn the tip guard into a silent no-op and empty the ancestry set.
TIP="$(git rev-parse --verify --quiet "refs/remotes/origin/$DEFAULT")" \
  || skip "origin/$DEFAULT does not exist locally; nothing to compare against"

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
    ADVANCED_FROM=""
    if [[ "$BEFORE" == "$TARGET" ]]; then
      note "$DEFAULT already up to date ($BEFORE)"
    elif ! git merge-base --is-ancestor "$DEFAULT" "origin/$DEFAULT" 2>/dev/null; then
      bad "$DEFAULT has diverged from origin/$DEFAULT; needs a manual merge"
    elif ((DRY_RUN)); then
      note "would fast-forward $DEFAULT $BEFORE..$TARGET"
      ADVANCED_FROM="$BEFORE"
    elif git merge --ff-only "origin/$DEFAULT" >/dev/null 2>&1; then
      ok "fast-forwarded $DEFAULT $BEFORE..$TARGET"
      ADVANCED_FROM="$BEFORE"
    else
      bad "could not fast-forward $DEFAULT"
    fi
  fi
fi

# ----------------------------------------------------------------- install ---

if ((CAN_ADVANCE)) && ((!NO_INSTALL)) && [[ -n "${ADVANCED_FROM:-}" ]]; then
  # Diff the range the branch moved over rather than hashing files on disk, so
  # --dry-run can answer this without having merged anything.
  if [[ -n "$(git diff --name-only "$ADVANCED_FROM" "$TARGET" -- "${LOCKFILES[@]}" 2>/dev/null)" ]]; then
    if ((DRY_RUN)); then
      note "lock file changed in that range; would run install"
    else
      install_log="$(install_deps 2>&1)"
      install_rc=$?
      case "$install_rc" in
        0) ok "lock file changed; dependencies installed" ;;
        3) note "lock file changed but no recognised lock file remains; nothing installed" ;;
        # The reason matters here: a missing package manager, a lock file out of
        # sync with package.json, and a registry outage all land on this line.
        *) bad "install failed (${install_log##*$'\n'}); run it by hand" ;;
      esac
    fi
  fi
fi

# ------------------------------------------------------------- merge proof ---


PR_LIMIT=200

# One API call covers every branch in the repo. Three things are required of a
# pull request before it counts as proof, because a bare branch-name match is not
# evidence about your commits:
#   - it merged into the default branch, not into some other branch
#   - it came from this repository, not from a fork (a fork's PR head ref is just
#     a name like "patch-1", which collides with local branches trivially)
#   - its head commit is exactly where the local branch still points, so a branch
#     that was reused or committed to after the merge is not treated as landed
PR_PAIRS=""
PR_LOOKUP_OK=1
if command -v gh >/dev/null 2>&1; then
  PR_PAIRS="$(gh pr list --state merged --base "$DEFAULT" --limit "$PR_LIMIT" \
      --json headRefName,headRefOid,isCrossRepository \
      --jq '.[] | select(.isCrossRepository == false) | "\(.headRefName)\t\(.headRefOid)"' \
      2>/dev/null)" || PR_LOOKUP_OK=0
else
  PR_LOOKUP_OK=0
fi
((PR_LOOKUP_OK)) || note "could not read merged pull requests; using ancestry alone"

# The bulk list above covers the common case in one call, but it is a window:
# a repo with more merged pull requests than the limit drops the oldest, and a
# branch merged before that window looks unproven. This asks about one branch
# directly, and is used only for branches nothing else could prove, so it costs
# a call per genuinely-unproven branch rather than a call per branch.
# Sets PR_BRANCH_STATE to one of:
#   match  a merged pull request whose head is exactly this commit
#   moved  a merged pull request for this branch, at a different commit
#   none   no merged pull request for this branch at all
# "moved" is worth separating: it means the work landed but the local branch is
# not the copy that landed, which is common when a bot rebases the remote branch.
# Deleting it would still throw away a commit that exists nowhere else.
pr_proof_for_branch() {
  local pairs
  PR_BRANCH_STATE=none
  pairs="$(gh pr list --state merged --base "$DEFAULT" --head "$1" --limit 5 \
      --json headRefName,headRefOid,isCrossRepository \
      --jq '.[] | select(.isCrossRepository == false) | "\(.headRefName)\t\(.headRefOid)"' \
      2>/dev/null)" || return 1
  [ -n "$pairs" ] || return 1
  if in_list "$1	$2" "$pairs"; then
    PR_BRANCH_STATE=match
    return 0
  fi
  PR_BRANCH_STATE=moved
  return 1
}

# Ancestry catches the other case: merged locally with no pull request at all.
# A failed probe must not masquerade as "nothing is merged", which would silently
# reduce the proof to the pull-request signal alone.
ANCESTRY_OK=1
ANCESTRY="$(git branch --merged "refs/remotes/origin/$DEFAULT" --format='%(refname:short)' 2>/dev/null)" \
  || ANCESTRY_OK=0
((ANCESTRY_OK)) || note "could not read merged branches; using pull requests alone"

if ((!PR_LOOKUP_OK)) && ((!ANCESTRY_OK)); then
  bad "no way to prove what has merged; skipped pruning entirely"
  exit 0
fi

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
done < <(git worktree list --porcelain 2>/dev/null) \
  || skip "cannot list worktrees"

# Any linked worktree mid-operation has a detached HEAD, so it maps to no branch
# and its work would be invisible to the guards below.
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      other="${line#worktree }"
      [[ "$other" == "$TOP" ]] && continue
      marker="$(check_in_progress "$other")"
      [[ -z "$marker" ]] || skip "git operation in progress in $other ($marker)"
      ;;
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

BRANCHES="$(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)" \
  || skip "cannot list local branches"

while IFS= read -r branch; do
  [[ -z "$branch" || "$branch" == "$DEFAULT" ]] && continue

  sha="$(git rev-parse --verify --quiet "refs/heads/$branch")" || {
    bad "kept $branch (cannot resolve its tip)"
    continue
  }

  proof=""
  if ((PR_LOOKUP_OK)) && [[ -n "$PR_PAIRS" ]] && in_list "$branch	$sha" "$PR_PAIRS"; then
    proof="merged PR"
  elif ((ANCESTRY_OK)) && [[ -n "$ANCESTRY" ]] && in_list "$branch" "$ANCESTRY"; then
    proof="merged into $DEFAULT"
  elif ((PR_LOOKUP_OK)) && pr_proof_for_branch "$branch" "$sha"; then
    proof="merged PR"
  fi

  if [[ -z "$proof" ]]; then
    if [[ "${PR_BRANCH_STATE:-none}" == "moved" ]]; then
      note "kept $branch (a merged PR used this name, but at a different commit)"
    else
      note "kept $branch (no merge proof)"
    fi
    continue
  fi

  wt="$(worktree_for "$branch")"

  # Checked before the tip guard below, so that a branch protected by unfinished
  # work in a worktree is reported for that reason rather than an incidental one.
  # An unreadable worktree counts as occupied: this guard is the only thing
  # between real uncommitted work and a force delete, so it fails closed.
  if [[ -n "$wt" && "$wt" != "$TOP" ]]; then
    if ! wt_dirty="$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)"; then
      bad "kept $branch (cannot read worktree $wt)"
      continue
    fi
    if [[ -n "$wt_dirty" ]]; then
      bad "kept $branch and its worktree $wt (uncommitted changes)"
      continue
    fi
  fi

  # A branch pointing at the same commit as origin/<default> has nothing to
  # prune, and is typically one that was just created and not committed to yet.
  if [[ "$sha" == "$TIP" ]]; then
    note "kept $branch (already at origin/$DEFAULT, nothing to prune)"
    continue
  fi

  short="$(git rev-parse --short "$branch")"

  if [[ -n "$wt" && "$wt" != "$TOP" ]]; then
    if ((DRY_RUN)); then
      note "would remove worktree $wt and delete $branch ($short, $proof)"
      continue
    fi
    if ! git worktree remove "$wt" >/dev/null 2>&1; then
      bad "kept $branch (could not remove worktree $wt)"
      continue
    fi
    ok "removed worktree $wt"
  fi

  if ((DRY_RUN)); then
    note "would delete $branch ($short, $proof)"
  elif git branch -D "$branch" >/dev/null 2>&1; then
    # -D rather than -d because a squash-merged branch is not an ancestor of the
    # default branch. The SHA makes it recoverable: git branch <name> <sha>.
    ok "deleted $branch ($short, $proof)"
  else
    bad "could not delete $branch"
  fi
done <<< "$BRANCHES"

((DRY_RUN)) || git worktree prune >/dev/null 2>&1

exit 0
