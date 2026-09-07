#!/usr/bin/env bash
# fixtures.sh — build real git repositories in known states.
#
# Source this, then compose the primitives. Every fixture is a real repository
# with a real (local, bare) origin, so `git fetch`, `git merge --ff-only`, and
# worktree operations all behave exactly as they do in production. Nothing here
# touches the network.
#
# Only what the specs in spec/gh/ still use lives here. The states the sync tests
# need -- package-manager projects, worktrees, in-progress markers, a corrupt
# index -- moved to tests/gh/conftest.py with the scripts they exercise.
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

# fixture_branch_with_work <work> <name> — a branch carrying one real commit
fixture_branch_with_work() {
  local w="$1" name="$2"
  fixture_git "$w" checkout -q -b "$name"
  fixture_commit "$w" "work on $name" "$name.txt" "$name"
  fixture_git "$w" checkout -q "$FIXTURE_DEFAULT_BRANCH"
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

# fixture_dirty <work> [file] — uncommitted change to a TRACKED file
fixture_dirty() { printf 'dirty\n' >> "${1}/${2:-file.txt}"; }

# fixture_forget_origin_head <work> — drop the cached origin/HEAD, forcing the
# default-branch resolution to fall through to its later strategies
# origin/HEAD is a SYMBOLIC ref, so update-ref -d leaves it resolvable. It has to
# be deleted as a symref or the resolution never falls through.
fixture_forget_origin_head() {
  fixture_git "$1" symbolic-ref --delete refs/remotes/origin/HEAD 2>/dev/null
  return 0
}

# ---------------------------------------------------------------------------
# Pull-request fixtures, consumed by the gh stub in fixtures/gh/bin/gh.
#
# fixture_prs <file> <pr-json...>   writes the canned PR set
# fixture_dep_pr <number> [key=...] emits one PR object, for composing that set
# ---------------------------------------------------------------------------

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

# fixture_dep_pr <number> [key=value ...] — one dependencies pull request as the
# shepherd scripts see it. Keys and defaults:
#   state=OPEN          OPEN | MERGED | CLOSED
#   merge=CLEAN         mergeStateStatus: CLEAN | BEHIND | DIRTY | BLOCKED | ...
#   checks=passed       passed | failed | pending | none | mixed (one of each)
#                       | neutral (NEUTRAL and SKIPPED conclusions only)
#                       | cancelled (a CANCELLED run beside a success)
#                       | null-conclusion (COMPLETED with conclusion null)
#                       | status-failed | status-pending | status-passed
#                         (StatusContext rows, the older commit-status shape)
#   auto=true           auto-merge enabled
#   bot=true            authored by app/dependabot; false gives a human author
#   draft=false
#   risk=               merge-risk band label to add: low | medium | high
#   created=            createdAt; defaults to 2026-01-<number>T00:00:00Z
#   head=               headRefOid; defaults to sha<number>
fixture_dep_pr() {
  local number="$1"; shift
  local state=OPEN merge=CLEAN checks=passed auto=true bot=true draft=false risk="" created="" head="" kv
  for kv in "$@"; do
    case "$kv" in
      state=*) state="${kv#*=}" ;;
      merge=*) merge="${kv#*=}" ;;
      checks=*) checks="${kv#*=}" ;;
      auto=*) auto="${kv#*=}" ;;
      bot=*) bot="${kv#*=}" ;;
      draft=*) draft="${kv#*=}" ;;
      risk=*) risk="${kv#*=}" ;;
      created=*) created="${kv#*=}" ;;
      head=*) head="${kv#*=}" ;;
      *) printf 'fixture_dep_pr: unknown key %s\n' "$kv" >&2; return 1 ;;
    esac
  done
  [[ -n "$created" ]] || created="$(printf '2026-01-%02dT00:00:00Z' "$number")"
  [[ -n "$head" ]] || head="sha$number"
  jq -nc --argjson n "$number" --arg state "$state" --arg merge "$merge" --arg checks "$checks" \
    --argjson auto "$auto" --argjson bot "$bot" --argjson draft "$draft" --arg risk "$risk" \
    --arg created "$created" --arg head "$head" '
    def run(name; status; conclusion):
      {__typename: "CheckRun", name: name, status: status, conclusion: conclusion,
       detailsUrl: ("https://github.com/acme/widgets/actions/runs/1" + ($n|tostring) + "/job/2" + ($n|tostring))};
    {
      number: $n,
      title: ("build(deps): bump dep-" + ($n|tostring)),
      state: $state,
      isDraft: $draft,
      author: (if $bot then {login: "app/dependabot", is_bot: true} else {login: "someone", is_bot: false} end),
      labels: ([{name: "dependencies"}] + (if $risk == "" then [] else [{name: ("merge-risk:" + $risk)}] end)),
      autoMergeRequest: (if $auto then {mergeMethod: "MERGE"} else null end),
      mergeStateStatus: $merge,
      mergeable: (if $merge == "DIRTY" then "CONFLICTING" else "MERGEABLE" end),
      headRefOid: $head,
      headRefName: ("dependabot/npm/dep-" + ($n|tostring)),
      baseRefName: "main",
      createdAt: $created,
      mergeCommit: (if $state == "MERGED" then {oid: ("merged" + ($n|tostring))} else null end),
      statusCheckRollup: (
        if $checks == "passed" then [run("test"; "COMPLETED"; "SUCCESS"), run("lint"; "COMPLETED"; "SKIPPED")]
        elif $checks == "failed" then [run("test"; "COMPLETED"; "SUCCESS"), run("build"; "COMPLETED"; "FAILURE")]
        elif $checks == "pending" then [run("test"; "COMPLETED"; "SUCCESS"), run("build"; "IN_PROGRESS"; null)]
        elif $checks == "mixed" then [run("test"; "IN_PROGRESS"; null), run("build"; "COMPLETED"; "FAILURE")]
        elif $checks == "neutral" then [run("lint"; "COMPLETED"; "NEUTRAL"), run("docs"; "COMPLETED"; "SKIPPED")]
        elif $checks == "cancelled" then [run("test"; "COMPLETED"; "SUCCESS"), run("build"; "COMPLETED"; "CANCELLED")]
        elif $checks == "null-conclusion" then [run("test"; "COMPLETED"; "SUCCESS"), run("build"; "COMPLETED"; null)]
        elif $checks == "status-failed" then [{__typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "https://ci.example/1"}]
        elif $checks == "status-pending" then [{__typename: "StatusContext", context: "ci/legacy", state: "PENDING", targetUrl: "https://ci.example/1"}]
        elif $checks == "status-passed" then [{__typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci.example/1"}]
        else [] end)
    }'
}
