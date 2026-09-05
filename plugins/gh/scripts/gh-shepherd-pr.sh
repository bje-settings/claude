#!/usr/bin/env bash
# gh-shepherd-pr.sh — the deterministic per-pull-request steps of /gh:shepherd.
#
# Usage:
#   gh-shepherd-pr.sh <path> <number> state
#   gh-shepherd-pr.sh <path> <number> rebase
#   gh-shepherd-pr.sh <path> <number> recreate
#   gh-shepherd-pr.sh <path> <number> wait
#   gh-shepherd-pr.sh <path> <number> skip <reason-file>
#   gh-shepherd-pr.sh <path> <number> merged
#
# Every action prints one JSON object: {"action", "ok", "detail", ...}. The
# agent running the loop decides which action comes next; this script only
# does the step, and refuses steps whose preconditions do not hold, so a
# confused caller cannot make it act on the wrong pull request.
#
#   state     the pull request as `summary` shapes it (see lib/shepherd.sh)
#   rebase    gh pr update-branch --rebase. Refuses unless the pull request is
#             open. Reports the head SHA before and after.
#   recreate  comments `@dependabot recreate`, then waits for the head SHA to
#             change. Refuses on a pull request Dependabot did not author.
#   wait      gh pr checks --watch --fail-fast, bounded (see below). Result is
#             one of passed, failed, pending, merged; `failing` lists the
#             failed checks and `log_tail` carries the failed steps' log.
#   skip      posts the comment in <reason-file> and reports its URL. Refuses
#             an empty file: a skip without a reason is not a skip.
#   merged    whether the pull request is MERGED, and its merge commit.
#
# The script never merges, never enables or disables auto-merge, never edits a
# label, and never bypasses a check. The only writes are the rebase, the two
# comments, and nothing else.
#
# Environment:
#   SHEPHERD_CI_SECONDS    typical CI wall time, from gh-shepherd-status.sh
#                          (default 300). The wait bound is twice this, clamped
#                          to [120, 540] so it fits inside a ten-minute tool
#                          call; the caller re-invokes `wait` on `pending`.
#   SHEPHERD_POLL_SECONDS  interval for the recreate head-SHA poll (default
#                          derived from SHEPHERD_CI_SECONDS, minimum 15).
#   SHEPHERD_LOG_LINES     lines of failed-step log to keep (default 60).
#   SHEPHERD_WAIT_BOUND    override the computed wait bound, in seconds. For
#                          specs and for repos whose CI is far from typical.
#
# Exits 0 when the action ran and reported (including ok:false refusals), 2 on
# a usage error, 1 when gh could not answer at all.

set -uo pipefail

# Resolve the library before any cd: the script may be invoked by a relative
# path, and the target directory is somewhere else entirely.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -r "$HERE/lib/shepherd.sh" ]] || { printf 'missing %s\n' "$HERE/lib/shepherd.sh" >&2; exit 2; }
# shellcheck source=lib/shepherd.sh
. "$HERE/lib/shepherd.sh"

usage() { sed -n '2,45p' "$0"; }

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { usage; exit 0; }
(($# >= 3)) || { usage >&2; exit 2; }

TARGET="$1"; NUMBER="$2"; ACTION="$3"; shift 3

[[ -d "$TARGET" ]] || { printf 'not a directory: %s\n' "$TARGET" >&2; exit 2; }
[[ "$NUMBER" =~ ^[1-9][0-9]*$ ]] || { printf 'not a pull request number: %s\n' "$NUMBER" >&2; exit 2; }
cd "$TARGET" || exit 2
git rev-parse --show-toplevel >/dev/null 2>&1 || {
  printf 'not a git repository: %s\n' "$TARGET" >&2; exit 2
}
command -v gh >/dev/null 2>&1 || { printf 'gh is required\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 1; }


REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)"
[[ -n "$REPO" ]] || { printf 'could not resolve the repository with gh\n' >&2; exit 1; }

CI_SECONDS="${SHEPHERD_CI_SECONDS:-300}"
[[ "$CI_SECONDS" =~ ^[0-9]+$ ]] || CI_SECONDS=300
LOG_LINES="${SHEPHERD_LOG_LINES:-60}"
[[ "$LOG_LINES" =~ ^[1-9][0-9]*$ ]] || LOG_LINES=60

# ------------------------------------------------------------------ helpers ---

# emit <ok> <detail> [jq-assignments...]: one JSON object on stdout. Extra
# arguments are jq expressions applied to the object, so callers can attach
# structured fields without hand-building JSON in bash.
emit() {
  local ok="$1" detail="$2"; shift 2
  local expr='.'
  local extra
  for extra in "$@"; do expr="$expr | $extra"; done
  jq -n --arg action "$ACTION" --argjson ok "$ok" --arg detail "$detail" \
    --argjson number "$NUMBER" --arg repo "$REPO" \
    '{action: $action, repo: $repo, number: $number, ok: $ok, detail: $detail}' \
    | jq "$expr"
}

# The pull request as `summary` shapes it, or nothing if gh cannot answer.
read_pr() {
  gh pr view "$NUMBER" --repo "$REPO" --json "$SHEPHERD_PR_FIELDS" 2>/dev/null \
    | shepherd_jq -c 'include "shepherd"; summary' 2>/dev/null
}

field() { printf '%s' "$1" | jq -r "$2"; }

# run_bounded <seconds> <command...>: run the command, kill it after the bound.
# Sets BOUNDED_RC (124 when the bound was hit, mirroring coreutils timeout).
# The command's output is discarded: the pull request is re-read afterwards
# and that is the source of truth, not the watcher's screen. macOS ships no `timeout`, and bash 3.2 has no `wait -n`, so
# this is a plain background timer racing the command.
run_bounded() {
  local bound="$1"; shift
  local timer_pid cmd_pid rc
  "$@" >/dev/null 2>&1 &
  cmd_pid=$!
  ( sleep "$bound"; kill "$cmd_pid" 2>/dev/null ) &
  timer_pid=$!
  wait "$cmd_pid" 2>/dev/null
  rc=$?
  # The timer is still sleeping if the command finished first. Kill it and
  # reap it so no sleep outlives the script.
  kill "$timer_pid" 2>/dev/null
  wait "$timer_pid" 2>/dev/null
  # 143 is SIGTERM from the timer; anything else is the command's own status.
  if ((rc == 143)); then BOUNDED_RC=124; else BOUNDED_RC=$rc; fi
}

clamp() {  # clamp <value> <min> <max>
  local v="$1" lo="$2" hi="$3"
  ((v < lo)) && v=$lo
  ((v > hi)) && v=$hi
  printf '%s' "$v"
}

# ------------------------------------------------------------------ actions ---

action_state() {
  local pr
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  emit true "read" ".pr = $pr"
}

action_rebase() {
  local pr before after out
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  if [[ "$(field "$pr" .state)" != "OPEN" ]]; then
    emit false "refused: pull request is $(field "$pr" .state), not OPEN" ".pr = $pr"
    return
  fi
  before="$(field "$pr" .headRefOid)"
  if out="$(gh pr update-branch "$NUMBER" --repo "$REPO" --rebase 2>&1)"; then
    pr="$(read_pr)"
    after="$(field "${pr:-null}" '.headRefOid // ""')"
    emit true "rebased" ".before = \"$before\" | .after = \"$after\"" ".pr = ${pr:-null}"
  else
    emit false "rebase failed: $(printf '%s' "$out" | tr '\n' ' ' | sed 's/"/\\"/g')" ".before = \"$before\""
  fi
}

action_recreate() {
  local pr before after interval bound waited out
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  if [[ "$(field "$pr" .is_bot)" != "true" ]]; then
    emit false "refused: #$NUMBER was not authored by Dependabot; recreate only works for its own pull requests" ".pr = $pr"
    return
  fi
  if [[ "$(field "$pr" .state)" != "OPEN" ]]; then
    emit false "refused: pull request is $(field "$pr" .state), not OPEN" ".pr = $pr"
    return
  fi
  before="$(field "$pr" .headRefOid)"
  out="$(gh pr comment "$NUMBER" --repo "$REPO" --body "@dependabot recreate" 2>&1)" || {
    emit false "could not post the recreate comment: $(printf '%s' "$out" | tr '\n' ' ')"
    return
  }

  # Dependabot answers asynchronously and leaves no signal but a new head SHA.
  # Poll a few times per typical CI cycle, bounded by two cycles.
  bound=$((CI_SECONDS * 2))
  interval="${SHEPHERD_POLL_SECONDS:-$((CI_SECONDS / 4))}"
  [[ "$interval" =~ ^[0-9]+$ ]] || interval=15
  ((interval < 15)) && [[ -z "${SHEPHERD_POLL_SECONDS:-}" ]] && interval=15
  waited=0
  while ((waited < bound)); do
    sleep "$interval"
    waited=$((waited + interval))
    pr="$(read_pr)"
    after="$(field "${pr:-null}" '.headRefOid // ""')"
    if [[ -n "$after" && "$after" != "$before" ]]; then
      emit true "recreated" ".before = \"$before\" | .after = \"$after\" | .pr = $pr"
      return
    fi
  done
  emit false "recreate requested but the head did not change within ${bound}s" ".before = \"$before\""
}

action_wait() {
  local pr bound failing logs link run job esc
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  if [[ "$(field "$pr" .state)" == "MERGED" ]]; then
    emit true "merged" '.result = "merged"' ".pr = $pr"
    return
  fi
  if [[ "$(field "$pr" .checks.state)" == "none" ]]; then
    emit true "no checks reported on this head" '.result = "passed"' ".pr = $pr"
    return
  fi

  # Only watch while something is still running. A rollup that is already
  # terminal is answered from the pull request itself: `gh pr checks --watch`
  # has been seen to keep watching a fully finished rollup that contains
  # skipped checks, and a watcher that cannot return is worse than no watcher.
  bound="$(clamp $((CI_SECONDS * 2)) 120 540)"
  [[ "${SHEPHERD_WAIT_BOUND:-}" =~ ^[1-9][0-9]*$ ]] && bound="$SHEPHERD_WAIT_BOUND"
  BOUNDED_RC=0
  if [[ "$(field "$pr" .checks.state)" == "pending" ]]; then
    run_bounded "$bound" gh pr checks "$NUMBER" --repo "$REPO" --watch --fail-fast
  fi
  # gh pr checks exit codes: 0 all passed, 1 a check failed, 8 still pending.
  # 124 is our bound. Re-read the pull request afterwards in every case, since
  # a passing rollup may already have let auto-merge fire, and decide from the
  # rollup rather than the watcher's exit code.
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "checks finished but the pull request could not be re-read"; return; }
  if [[ "$(field "$pr" .state)" == "MERGED" ]]; then
    emit true "merged" '.result = "merged"' ".pr = $pr"
    return
  fi
  case "$(field "$pr" .checks.state)" in
    passed|none) emit true "checks passed" '.result = "passed"' ".pr = $pr"; return ;;
    pending) emit true "checks still running after ${bound}s" '.result = "pending"' ".bound = $bound" ".watcher_rc = $BOUNDED_RC" ".pr = $pr"; return ;;
  esac

  # Something failed. Name the checks and pull the failed steps' log for the
  # first Actions job among them, so the agent can classify without another
  # round trip. The link shape is .../actions/runs/<run>/job/<job>.
  failing="$(field "$pr" '.checks.failing')"
  logs=""
  link="$(printf '%s' "$failing" | jq -r 'map(.link // "") | map(select(test("/actions/runs/[0-9]+/job/[0-9]+"))) | first // ""')"
  if [[ -n "$link" ]]; then
    run="$(printf '%s' "$link" | sed -E 's#.*/actions/runs/([0-9]+)/job/([0-9]+).*#\1#')"
    job="$(printf '%s' "$link" | sed -E 's#.*/actions/runs/([0-9]+)/job/([0-9]+).*#\2#')"
    # Strip ANSI colour so the tail reads as text in a JSON string.
    esc="$(printf '\033')"
    logs="$(gh run view "$run" --repo "$REPO" --job "$job" --log-failed 2>/dev/null \
      | sed "s/${esc}\[[0-9;]*m//g" | tail -n "$LOG_LINES")"
  fi
  emit true "checks failed" '.result = "failed"' ".pr = $pr" \
    ".log_tail = $(printf '%s' "$logs" | jq -Rs .)"
}

action_skip() {
  local file="${1:-}" pr out url
  [[ -n "$file" ]] || { printf 'skip needs a reason file\n' >&2; exit 2; }
  [[ -s "$file" ]] || { emit false "refused: reason file is missing or empty: $file"; return; }
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  if [[ "$(field "$pr" .state)" != "OPEN" ]]; then
    emit false "refused: pull request is $(field "$pr" .state), not OPEN" ".pr = $pr"
    return
  fi
  if out="$(gh pr comment "$NUMBER" --repo "$REPO" --body-file "$file" 2>&1)"; then
    url="$(printf '%s' "$out" | grep -Eo 'https://[^ ]+' | tail -n 1)"
    emit true "skip comment posted" ".comment_url = \"$url\""
  else
    emit false "could not post the skip comment: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}

action_merged() {
  local pr
  pr="$(read_pr)"
  [[ -n "$pr" ]] || { emit false "could not read pull request #$NUMBER"; return; }
  if [[ "$(field "$pr" .state)" == "MERGED" ]]; then
    emit true "merged" ".merged = true | .mergeCommit = $(field "$pr" '.mergeCommit | tojson')"
  else
    emit true "not merged: $(field "$pr" .state)" '.merged = false'
  fi
}

case "$ACTION" in
  state) action_state ;;
  rebase) action_rebase ;;
  recreate) action_recreate ;;
  wait) action_wait ;;
  skip) action_skip "$@" ;;
  merged) action_merged ;;
  *) printf 'unknown action: %s\n' "$ACTION" >&2; usage >&2; exit 2 ;;
esac
