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

# Yarn Berry is selected per project through package.json's packageManager field,
# which corepack honours, so these fixtures do not depend on which yarn happens
# to be on PATH. Yarn 1 and bun are out of scope for /gh:sync.
FIXTURE_YARN_VERSION="${FIXTURE_YARN_VERSION:-4.5.3}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

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

# fixture_corrupt_index <work> — git status then exits non-zero with empty stdout.
# Resolves the real git dir rather than assuming $work/.git is a directory, which
# it is not in a linked worktree.
fixture_corrupt_index() {
  printf 'GARBAGE' > "$(fixture_git "$1" rev-parse --absolute-git-dir)/index"
}

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

# fixture_lock_index <work> — an index lock, which git status tolerates but any
# ref-updating command refuses. Lets a mid-run git failure be provoked without
# corrupting anything.
fixture_lock_index() { : > "$(fixture_git "$1" rev-parse --absolute-git-dir)/index.lock"; }

# fixture_many_prs <file> <count> [pr-json...] — <count> filler pull requests,
# followed by any given explicitly. When <count> is at least the script's bulk
# lookup limit, anything appended is past the window: invisible to the bulk query
# and reachable only by asking about that branch directly. With a smaller <count>
# the appended entries are visible to both, so the limit has to be passed
# deliberately to exercise the fallback.
fixture_many_prs() {
  local file="$1" count="$2"
  shift 2
  jq -n --argjson n "$count" --arg base "$FIXTURE_DEFAULT_BRANCH" \
    '[range($n) | {headRefName:("old-\(.)"), headRefOid:("\(.)"), baseRefName:$base,
                   isCrossRepository:false, state:"MERGED"}]' > "$file"
  local pr
  for pr in "$@"; do
    jq --argjson pr "$pr" '. + [$pr]' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  done
}

# fixture_break_origin <work> — the remote still exists but is unreachable, so
# fetch and set-head fail while the preflight still passes
fixture_break_origin() { fixture_git "$1" remote set-url origin /nonexistent/gone.git; }

# fixture_forget_origin_head <work> — drop the cached origin/HEAD, forcing the
# default-branch resolution to fall through to its later strategies
# origin/HEAD is a SYMBOLIC ref, so update-ref -d leaves it resolvable. It has to
# be deleted as a symref or the resolution never falls through.
fixture_forget_origin_head() {
  fixture_git "$1" symbolic-ref --delete refs/remotes/origin/HEAD 2>/dev/null
  return 0
}

# fixture_drop_remote_branches <work> — remove every remote-tracking branch, so
# no default branch can be resolved at all
fixture_drop_remote_branches() {
  local w="$1" ref
  while IFS= read -r ref; do
    [ -n "$ref" ] && fixture_git "$w" update-ref -d "$ref"
  done <<EOF
$(fixture_git "$w" for-each-ref --format='%(refname)' refs/remotes/origin/)
EOF
  return 0
}

# fixture_js_project <work> [pnpm|yarn|npm] — a package.json and lock file with
# no dependencies, so the install succeeds offline and the real install path runs.
# pnpm is the default: it is the house package manager and the branch
# gh-sync-repo.sh checks first. Yarn means Berry; yarn 1 and bun are out of scope
# for /gh:sync and have no fixtures.
#
# The developer's own ~/.npmrc is kept out of it: it may reference registries or
# auth tokens that are unavailable, which would make an offline install fail for
# reasons that have nothing to do with the code under test.
fixture_js_project() {
  local w="$1" mgr="${2:-pnpm}"
  _fixture_write_package_json "$w" "$mgr" fixture
  if [ "$mgr" = yarn ]; then
    # Berry writes a PnP bundle and a cache directory beside the lock file.
    # Neither belongs in the fixture's history.
    printf '.yarn/\n.pnp.*\n' > "$w/.gitignore"
  fi
  _fixture_install "$w" "$mgr" || return 1
  _fixture_require_lock "$w" "$mgr" || return 1
  fixture_git "$w" add -A
  fixture_git "$w" commit -qm "add $mgr project"
  fixture_push "$w"
}

# _fixture_require_lock <dir> <mgr> — fail loudly if no lock file was written.
# A package manager that cannot satisfy its pinned version may print guidance and
# still exit 0, which would otherwise surface as an unexplained assertion failure
# much later.
_fixture_require_lock() {
  local lock
  lock="$(fixture_lockfile_name "$2")"
  [ -f "$1/$lock" ] && return 0
  printf 'fixture: %s produced no %s in %s\n' "$2" "$lock" "$1" >&2
  return 1
}

# _fixture_write_package_json <dir> <mgr> <name>
# Berry is pinned per project through the packageManager field, which corepack
# honours, so the fixture does not depend on which yarn is on PATH.
_fixture_write_package_json() {
  local dir="$1" mgr="$2" name="$3"
  if [ "$mgr" = yarn ]; then
    printf '{"name":"%s","version":"1.0.0","packageManager":"yarn@%s"}\n' \
      "$name" "$FIXTURE_YARN_VERSION" > "$dir/package.json"
  else
    printf '{"name":"%s","version":"1.0.0"}\n' "$name" > "$dir/package.json"
  fi
}

# _fixture_install <dir> <mgr> — write the lock file without fetching anything.
#
# Reports the package manager's own output on failure rather than swallowing it.
# A silent failure here surfaces as "Example aborted" with no reason, which costs
# a CI round trip to diagnose.
_fixture_install() {
  local dir="$1" mgr="$2" out rc
  # Two bash 3.2 constraints in five lines. The redirect goes on a brace group
  # rather than on esac, and every case pattern carries a leading parenthesis:
  # bash 3.2 mis-parses the unbalanced ")" of a case pattern inside $( ).
  out="$(
    {
      cd "$dir" || exit 1
      export NPM_CONFIG_USERCONFIG=/dev/null npm_config_userconfig=/dev/null
      case "$mgr" in
        (pnpm) pnpm install --lockfile-only --silent ;;
        # --no-immutable because Yarn Berry turns immutable installs on by
        # itself whenever CI is set, and an immutable install refuses to create
        # the lock file this fixture exists to write (YN0028). The code under
        # test still runs a plain --immutable install; only the fixture opts out.
        (yarn) yarn install --no-immutable ;;
        (npm)  npm install --package-lock-only --silent ;;
      esac
    } 2>&1
  )"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'fixture: %s install failed in %s (exit %s)\n' "$mgr" "$dir" "$rc" >&2
    printf '%s\n' "$out" | tail -20 >&2
  fi
  return "$rc"
}

# fixture_lockfile_name <manager>
fixture_lockfile_name() {
  case "$1" in
    pnpm) printf 'pnpm-lock.yaml\n' ;;
    yarn) printf 'yarn.lock\n' ;;
    npm)  printf 'package-lock.json\n' ;;
  esac
}

# fixture_remote_update_lock <work> [pnpm|yarn|npm] — origin legitimately
# regenerates the lock file, so the sync sees a real lock change and a VALID file
# to install from. Appending to a lock file, as fixture_remote_advance would,
# corrupts it instead.
#
# The change is a dependency on a directory inside the repo. Every manager
# records a real dependency, and a file: path resolves without the network, so
# this works the same for all three and does not depend on which metadata a
# given version happens to write. Perturbing manager-specific fields does not
# survive: pnpm 10 records an override for a package nothing depends on and
# pnpm 11 drops it, which passed here and failed in CI.
fixture_remote_update_lock() {
  local w="$1" mgr="${2:-pnpm}" origin scratch
  origin="$(fixture_git "$w" remote get-url origin)"
  scratch="$(mktemp -d)"
  git clone -q "$origin" "$scratch/c" 2>/dev/null
  mkdir -p "$scratch/c/local-dep"
  printf '{"name":"local-dep","version":"1.0.0"}\n' > "$scratch/c/local-dep/package.json"
  (
    cd "$scratch/c" || exit 1
    jq '.dependencies = {"local-dep":"file:./local-dep"}' package.json > t && mv t package.json
  ) >/dev/null 2>&1
  if ! _fixture_install "$scratch/c" "$mgr" || ! _fixture_require_lock "$scratch/c" "$mgr"; then
    rm -rf "$scratch"
    return 1
  fi
  fixture_git "$scratch/c" add -A
  fixture_git "$scratch/c" commit -qm 'add a local dependency'
  fixture_push "$scratch/c"
  rm -rf "$scratch"
}

# fixture_remote_break_lock <work> [lock] — origin pushes a lock file that cannot
# be parsed, so the install fails for a real, reportable reason
fixture_remote_break_lock() {
  local w="$1" lock="${2:-pnpm-lock.yaml}" origin scratch
  origin="$(fixture_git "$w" remote get-url origin)"
  scratch="$(mktemp -d)"
  git clone -q "$origin" "$scratch/c" 2>/dev/null
  printf 'not: [valid\n' > "$scratch/c/$lock"
  fixture_git "$scratch/c" add -A
  fixture_git "$scratch/c" commit -qm 'break the lock file'
  fixture_push "$scratch/c"
  rm -rf "$scratch"
}

# fixture_remote_drop_lockfile <work> — origin deletes the lock file, so the range
# shows a lock change but nothing is left to install
fixture_remote_drop_lockfile() {
  local w="$1" lock="${2:-pnpm-lock.yaml}" origin scratch
  origin="$(fixture_git "$w" remote get-url origin)"
  scratch="$(mktemp -d)"
  git clone -q "$origin" "$scratch/c" 2>/dev/null
  rm -f "$scratch/c/$lock"
  fixture_git "$scratch/c" add -A
  fixture_git "$scratch/c" commit -qm 'drop lock file'
  fixture_push "$scratch/c"
  rm -rf "$scratch"
}

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
