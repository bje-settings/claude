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
PR_BRANCH_LIMIT=100
TAB=$'\t'

# own_rows <pairs> — the rows from this repository, dropping forks. Forks are
# kept in the raw result so the row count reflects the real window size, but they
# say nothing about a local branch: a fork's head ref is just a name.
own_rows() {
  printf '%s' "$1" | grep "^false$TAB" 2>/dev/null || true
}

# name_in_rows <branch> <rows> — does any row name this branch, at any commit?
name_in_rows() {
  local needle="false$TAB$1$TAB" line
  while IFS= read -r line; do
    case "$line" in ("$needle"*) return 0 ;; esac
  done <<< "$2"
  return 1
}

# One API call covers every branch in the repo. Three things are required of a
# pull request before it counts as proof, because a bare branch-name match is not
# evidence about your commits:
#   - it merged into the default branch, not into some other branch
#   - it came from this repository, not from a fork (a fork's PR head ref is just
#     a name like "patch-1", which collides with local branches trivially)
#   - its head commit is exactly where the local branch still points, so a branch
#     that was reused or committed to after the merge is not treated as landed
#
# Forks are carried in the row rather than filtered out by jq, so the row count
# is the real number of pull requests the window returned. That count is what
# tells us whether the window was saturated, and a fork row can never match a
# lookup key, which always begins "false".
PR_JQ='.[] | "\(.isCrossRepository)\t\(.headRefName)\t\(.headRefOid)"'
PR_PAIRS=""
PR_LOOKUP_OK=1
PR_BULK_SATURATED=0
if command -v gh >/dev/null 2>&1; then
  PR_PAIRS="$(gh pr list --state merged --base "$DEFAULT" --limit "$PR_LIMIT" \
      --json headRefName,headRefOid,isCrossRepository --jq "$PR_JQ" 2>/dev/null)" \
    || PR_LOOKUP_OK=0
else
  PR_LOOKUP_OK=0
fi
PR_OWN=""
PR_FALLBACK_OFF=0
PR_UNCHECKED=0
if ((PR_LOOKUP_OK)); then
  pr_count="$(printf '%s' "$PR_PAIRS" | grep -c . 2>/dev/null)" || pr_count=0
  ((pr_count >= PR_LIMIT)) && PR_BULK_SATURATED=1
  PR_OWN="$(own_rows "$PR_PAIRS")"
else
  note "could not read merged pull requests; using ancestry alone"
fi

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

# Asks about a single branch, for the case the bulk window cannot answer: a repo
# with more merged pull requests than the limit drops the oldest, so a branch
# merged before that window is absent from the list without being unmerged.
#
# Sets PR_BRANCH_STATE to one of:
#   match    a merged pull request from this repo, into the default branch, whose
#            head is exactly this commit
#   moved    merged pull requests used this name, none of them at this commit
#   none     no merged pull request used this name
#   crowded  the window filled up, so "none of them" could not be established
#   error    the query did not complete, so nothing was established either way
#
# The last three are all reasons to keep the branch, but they are different
# statements and the report says which. Reporting a failed query as "none" would
# assert an absence that was never checked.
# Asks about a single branch. Never resets PR_BRANCH_STATE: the caller sets it
# per branch, and this can only raise what is already known.
pr_proof_for_branch() {
  local pairs own count
  pairs="$(gh pr list --state merged --base "$DEFAULT" --head "$1" \
      --limit "$PR_BRANCH_LIMIT" \
      --json headRefName,headRefOid,isCrossRepository --jq "$PR_JQ" 2>/dev/null)" \
    || {
      # Only downgrade to "unknown" if the bulk list established nothing. A
      # "moved" from the bulk list is still a fact this failure does not undo.
      [ "$PR_BRANCH_STATE" = none ] && PR_BRANCH_STATE=error
      return 1
    }
  own="$(own_rows "$pairs")"
  if [ -n "$own" ] && in_list "false$TAB$1$TAB$2" "$own"; then
    PR_BRANCH_STATE=match
    return 0
  fi
  # A saturated result is a window, not an answer. Concluding "none at this
  # commit" from a truncated list is the mistake this change exists to fix.
  count="$(printf '%s' "$pairs" | grep -c . 2>/dev/null)" || count=0
  if ((count >= PR_BRANCH_LIMIT)); then
    PR_BRANCH_STATE=crowded
    return 1
  fi
  [ -n "$own" ] && PR_BRANCH_STATE=moved
  return 1
}

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
    branch\ refs/heads/*) WORKTREES+="${line#branch refs/heads/}"$'\t'"$_wt"$'\n' ;;
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
  # Reset per branch rather than relying on the arms below to always run, so a
  # verdict can never carry over from the previous iteration.
  PR_BRANCH_STATE=none
  if ((PR_LOOKUP_OK)) && [[ -n "$PR_PAIRS" ]] && in_list "false$TAB$branch$TAB$sha" "$PR_OWN"; then
    proof="merged PR"
  elif ((ANCESTRY_OK)) && [[ -n "$ANCESTRY" ]] && in_list "$branch" "$ANCESTRY"; then
    proof="merged into $DEFAULT"
  else
    # The bulk list can already show this name at another commit, so say so
    # without a second call. The per-branch query below can only raise this.
    if ((PR_LOOKUP_OK)) && [[ -n "$PR_OWN" ]] && name_in_rows "$branch" "$PR_OWN"; then
      PR_BRANCH_STATE=moved
    fi
    # Only worth asking when the bulk window filled up: an unsaturated window
    # already listed every merged pull request, so a second call cannot find one
    # it missed, and asking anyway would be an API call per branch.
    if ((PR_LOOKUP_OK)) && ((PR_BULK_SATURATED)); then
      if ((PR_FALLBACK_OFF)); then
        # A previous branch's query already failed. Whatever is wrong is very
        # unlikely to be branch-specific, and a rate limit only gets worse if we
        # keep asking, so stop calling and say these were never checked.
        [[ "$PR_BRANCH_STATE" == none ]] && PR_BRANCH_STATE=error
      elif pr_proof_for_branch "$branch" "$sha"; then
        proof="merged PR"
      elif [[ "$PR_BRANCH_STATE" == error ]]; then
        PR_FALLBACK_OFF=1
      fi
    fi
  fi

  if [[ -z "$proof" ]]; then
    case "$PR_BRANCH_STATE" in
      moved)
        note "kept $branch (merged PRs used this name; none at this commit)" ;;
      crowded)
        note "kept $branch (too many merged PRs used this name to tell)" ;;
      error)
        PR_UNCHECKED=$((PR_UNCHECKED + 1))
        bad "kept $branch (could not ask about this branch; unproven, not disproven)" ;;
      *)
        note "kept $branch (no merge proof)" ;;
    esac
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

((PR_UNCHECKED)) && bad "$PR_UNCHECKED branch(es) were never checked against pull requests; this run is incomplete"

((DRY_RUN)) || git worktree prune >/dev/null 2>&1

exit 0
