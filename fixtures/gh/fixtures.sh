#!/usr/bin/env bash
# fixtures.sh — build real git repositories in known states.
#
# Source this, then compose primitives, or call one of the named scenarios at the
# bottom. Every fixture is a real repository with a real (local, bare) origin, so
# `git fetch`, `git merge --ff-only`, and worktree operations all behave exactly
# as they do in production. Nothing here touches the network.
#
# Each fixture_create makes a directory holding:
#   origin.git/   the bare remote
#   work/         a clone of it, which is what you pass to the script
#
# Written for bash 3.2, like the scripts under test.

FIXTURE_DEFAULT_BRANCH="${FIXTURE_DEFAULT_BRANCH:-main}"

# Keep fixture repos isolated from the developer's real git config, which may set
# a different default branch, sign commits, or install hooks.
fixture_git() {
  local dir="$1"; shift
  git -C "$dir" \
    -c user.name='Fixture' \
    -c user.email='fixture@example.invalid' \
    -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null \
    "$@"
}

# _fixture_seed <bare> <work> — shared by the two constructors below
_fixture_seed() {
  local bare="$1" w="$2"
  git init -q --bare --initial-branch="$FIXTURE_DEFAULT_BRANCH" "$bare" 2>/dev/null \
    || git init -q --bare "$bare"
  git clone -q "$bare" "$w" 2>/dev/null
  fixture_git "$w" checkout -q -B "$FIXTURE_DEFAULT_BRANCH"
  printf 'base\n' > "$w/file.txt"
  fixture_git "$w" add -A
  fixture_git "$w" commit -qm 'base'
  fixture_git "$w" push -q -u origin "$FIXTURE_DEFAULT_BRANCH"
  fixture_git "$w" remote set-head origin --auto >/dev/null 2>&1
  printf '%s\n' "$w"
}

# fixture_create <root> -> echoes the work tree at <root>/work
# Use for single-repo specs; the bare origin sits beside it at <root>/origin.git.
fixture_create() {
  mkdir -p "$1"
  _fixture_seed "$1/origin.git" "$1/work"
}

# fixture_create_at <parent> <name> -> echoes the work tree at <parent>/<name>
# Use for fan-out specs, where the scanned directory must contain work trees and
# nothing else. Bare origins are parked in <parent>/.origins, which the fan-out
# glob skips because it is hidden.
fixture_create_at() {
  local parent="$1" name="$2"
  mkdir -p "$parent/.origins"
  _fixture_seed "$parent/.origins/$name.git" "$parent/$name"
}

# fixture_commit <work> <message> [file] [content]
fixture_commit() {
  local w="$1" msg="$2" file="${3:-file.txt}" content="${4:-$2}"
  printf '%s\n' "$content" >> "$w/$file"
  fixture_git "$w" add -A
  fixture_git "$w" commit -qm "$msg"
}

# fixture_push <work> [branch]
fixture_push() { fixture_git "$1" push -q origin "${2:-$FIXTURE_DEFAULT_BRANCH}"; }

# fixture_branch <work> <name> [start-point] — creates it, leaves you on default
fixture_branch() {
  local w="$1" name="$2" start="${3:-$FIXTURE_DEFAULT_BRANCH}"
  fixture_git "$w" branch "$name" "$start"
}

# fixture_branch_with_work <work> <name> — a branch carrying one real commit
fixture_branch_with_work() {
  local w="$1" name="$2"
  fixture_git "$w" checkout -q -b "$name"
  fixture_commit "$w" "work on $name" "$name.txt" "$name"
  fixture_git "$w" checkout -q "$FIXTURE_DEFAULT_BRANCH"
}

# fixture_merge_ff <work> <branch> — fast-forward into the default branch, push.
# Leaves ancestry behind, so `git branch --merged` finds it.
fixture_merge_ff() {
  local w="$1" name="$2"
  fixture_git "$w" merge -q --ff-only "$name"
  fixture_push "$w"
}

# fixture_merge_commit <work> <branch> — merge with a merge commit, then push.
# This is what a PR merged with the "merge commit" strategy leaves behind, and
# unlike a fast-forward it leaves the branch strictly BEHIND the default branch,
# which is the state in which ancestry is the interesting signal. A fast-forward
# leaves the branch AT the tip, where the tip guard takes over instead.
fixture_merge_commit() {
  local w="$1" name="$2"
  fixture_git "$w" merge -q --no-ff -m "Merge $name" "$name"
  fixture_push "$w"
}

# fixture_merge_squash <work> <branch> — squash into the default branch, push.
# Leaves NO ancestry, so only a pull-request signal can prove this one.
fixture_merge_squash() {
  local w="$1" name="$2"
  fixture_git "$w" merge -q --squash "$name" >/dev/null 2>&1
  fixture_git "$w" commit -qm "squash $name"
  fixture_push "$w"
}

# fixture_dirty <work> [file] — uncommitted change to a TRACKED file
fixture_dirty() { printf 'dirty\n' >> "${1}/${2:-file.txt}"; }

# fixture_untracked <work> [file] — an untracked file, which must NOT block a sync
fixture_untracked() { printf 'untracked\n' > "${1}/${2:-untracked.txt}"; }

# fixture_corrupt_index <work> — git status then exits non-zero with empty stdout
fixture_corrupt_index() { printf 'GARBAGE' > "$1/.git/index"; }

# fixture_in_progress <work> <marker> — e.g. rebase-merge, MERGE_HEAD
fixture_in_progress() {
  local w="$1" marker="$2" gitdir
  gitdir="$(fixture_git "$w" rev-parse --absolute-git-dir)"
  case "$marker" in
    *-*) mkdir -p "$gitdir/$marker" ;;
    *)   printf '%s\n' "$(fixture_git "$w" rev-parse HEAD)" > "$gitdir/$marker" ;;
  esac
}

# fixture_worktree <work> <path> <branch> — add a linked worktree
fixture_worktree() { fixture_git "$1" worktree add -q "$2" "$3"; }

# fixture_diverge <work> — a local-only commit plus an origin-only commit, so the
# default branch cannot fast-forward
fixture_diverge() {
  local w="$1" origin scratch
  origin="$(fixture_git "$w" remote get-url origin)"
  scratch="$(mktemp -d)"
  git clone -q "$origin" "$scratch/c" 2>/dev/null
  fixture_commit "$scratch/c" 'origin side'
  fixture_push "$scratch/c"
  rm -rf "$scratch"
  fixture_commit "$w" 'local side' local.txt local
}

# fixture_lockfile <work> <name> [content] — commit a lock file and push
fixture_lockfile() {
  local w="$1" name="$2" content="${3:-{\"lockfileVersion\":3\}}"
  printf '%s\n' "$content" > "$w/$name"
  printf '{"name":"fixture"}\n' > "$w/package.json"
  fixture_git "$w" add -A
  fixture_git "$w" commit -qm "add $name"
  fixture_push "$w"
}

# fixture_remote_advance <work> [file] — origin gains a commit the clone lacks,
# so the default branch is behind and can fast-forward
fixture_remote_advance() {
  local w="$1" file="${2:-file.txt}" origin scratch
  origin="$(fixture_git "$w" remote get-url origin)"
  scratch="$(mktemp -d)"
  git clone -q "$origin" "$scratch/c" 2>/dev/null
  fixture_commit "$scratch/c" 'remote advance' "$file" 'advanced'
  fixture_push "$scratch/c"
  rm -rf "$scratch"
}

fixture_remove_origin() { fixture_git "$1" remote remove origin; }

# fixture_sha <work> <rev>
fixture_sha() { fixture_git "$1" rev-parse "$2"; }

# ---------------------------------------------------------------------------
# Pull-request fixtures, consumed by the gh stub in fixtures/gh/bin/gh.
#
# fixture_prs <file> <json-array>   writes the canned PR set
# fixture_pr <headRefName> <headRefOid> [baseRefName] [isCrossRepository]
#                                   emits one PR object, for composing an array
# ---------------------------------------------------------------------------

fixture_pr() {
  printf '{"headRefName":"%s","headRefOid":"%s","baseRefName":"%s","isCrossRepository":%s,"state":"MERGED"}' \
    "$1" "$2" "${3:-$FIXTURE_DEFAULT_BRANCH}" "${4:-false}"
}

fixture_prs() {
  local file="$1"; shift
  local out="[" first=1 pr
  for pr in "$@"; do
    ((first)) || out="$out,"
    out="$out$pr"; first=0
  done
  printf '%s]\n' "$out" > "$file"
}

fixture_no_prs() { printf '[]\n' > "$1"; }
