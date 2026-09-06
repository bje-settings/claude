#!/usr/bin/env bash
# ft-run.sh: the field-test run marker for one Claude Code session.
#
#   ft-run.sh start <target> [--resolved <file>] [--cwd <dir>] [--] [arg...]
#   ft-run.sh finish
#   ft-run.sh show
#   ft-run.sh dir
#
# The marker is what tells this plugin's hooks that the session is a field test.
# It lives at
#   ${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/runs/<session-id>/run.json
# beside the events.jsonl the hooks append to. Those two files are the whole of
# the plugin's own state; nothing is cached, and the only other files in the run
# directory are the ones a run writes there for itself (resolved.json, names.json).
#
# The session id comes from --session, then $CLAUDE_CODE_SESSION_ID, which the
# Bash tool exports and which matches the session_id hooks receive on stdin.
#
# `--resolved` takes the JSON ft-resolve.sh printed for the target, so the marker
# records which plugin, version, and commit was under test. Without it those
# fields are null: the marker still works, the issues it feeds are just vaguer.
#
# Exit 0 on success, 1 on failure, 2 on usage or a missing session or state dir,
# 3 when a run is already active for this session.
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-run.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

# The jq programs below are held in variables filled from a heredoc rather than
# written inline across several lines. Both forms are one shell statement, but kcov
# marks the continuation lines of a multi-line command as code that never runs, so
# an inline program reads as a block of permanently uncovered lines. A heredoc body
# is not instrumented, which is what the coverage number already assumes a jq
# program to be: one line, and the branches inside it tested by their own fixtures
# (see .claude/rules/type-jq.md).

read -r -d '' MARKER_JQ <<'JQ' || true
{version: 1, session_id: $session, target: $target, args: $args, cwd: $cwd,
 resolved: $resolved, claude_version: $cv, started_at: $started, finished_at: null}
JQ

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

session=""
state_dir="${FT_STATE_DIR:-${CLAUDE_PLUGIN_DATA:-}}"

# The session flag is global: hooks pass the id from their payload, the skill
# lets the environment supply it.
args=()
while (($#)); do
  case "$1" in
    --session)
      [[ -n "${2:-}" && "${2:-}" != -* ]] || die '--session needs a value' 2
      session="$2"; shift 2 ;;
    # Everything from `--` on belongs to the target, including a --session of its
    # own. Scanning past it would send the marker to a directory no hook looks in.
    --) while (($#)); do args+=("$1"); shift; done ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

[[ -n "$state_dir" ]] || die 'set CLAUDE_PLUGIN_DATA (or FT_STATE_DIR) to locate the run marker' 2
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"
[[ -n "$session" ]] || die 'no session id: pass --session or set CLAUDE_CODE_SESSION_ID' 2

run_dir="$state_dir/runs/$session"
run_json="$run_dir/run.json"

# write_json <path> <jq args...>: build with jq into a temp file, then move it
# into place, so a crash mid-write cannot leave a half-written marker behind.
write_json() {
  local path="$1"; shift
  local tmp="$path.tmp.$$"
  jq "$@" > "$tmp" || { rm -f "$tmp"; die "jq failed while writing $path"; }
  mv "$tmp" "$path" || { rm -f "$tmp"; die "cannot write $path"; }
}

require_marker() {
  [[ -f "$run_json" ]] || die "no field test is running for session $session" 1
  valid_marker
}

# A marker that is not JSON is a crashed write, not a live run. Saying so is the
# difference between a user deleting one file and a session that can neither
# start nor finish a run.
valid_marker() {
  jq -e . "$run_json" >/dev/null 2>&1 \
    || die "the run marker at $run_json is not valid JSON; delete it and start again" 1
}

case "$cmd" in
  dir)
    printf '%s\n' "$run_dir" ;;

  start)
    target="${1:-}"; shift 2>/dev/null || true
    [[ -n "$target" && "$target" != -* ]] || die 'start needs a target' 2
    resolved=""; run_cwd="$PWD"
    while (($#)); do
      case "$1" in
        --resolved)
          [[ -n "${2:-}" ]] || die '--resolved needs a value' 2
          resolved="$2"; shift 2 ;;
        --cwd)
          [[ -n "${2:-}" ]] || die '--cwd needs a value' 2
          run_cwd="$2"; shift 2 ;;
        --) shift; break ;;
        -*) die "start: unknown argument: $1" 2 ;;
        *) break ;;
      esac
    done
    if [[ -f "$run_json" ]]; then
      valid_marker
      jq -e '.finished_at != null' "$run_json" >/dev/null 2>&1 \
        || die "a field test is already running for session $session; run finish first" 3
    fi
    if [[ -n "$resolved" ]]; then
      [[ -f "$resolved" ]] || die "no such resolved file: $resolved" 2
      jq -e . "$resolved" >/dev/null 2>&1 || die "resolved file is not valid JSON: $resolved"
    fi
    # One --arg per argument, rather than a newline-joined list: an argument may be
    # empty or may itself contain a newline, and either one silently changes the
    # recorded argv, which is what args_dropped findings are computed against.
    args_json='[]'
    for arg in ${1+"$@"}; do
      args_json="$(printf '%s' "$args_json" | jq -c --arg a "$arg" '. + [$a]')" \
        || die 'jq failed while recording the arguments'
    done
    mkdir -p "$run_dir" || die "cannot create $run_dir"
    : > "$run_dir/events.jsonl" || die "cannot create $run_dir/events.jsonl"
    # `claude --version` is recorded because an issue body has to say which
    # build produced the behaviour; a missing claude is not worth failing on.
    claude_version="$(claude --version 2>/dev/null | head -1)"
    write_json "$run_json" -n \
      --arg session "$session" --arg target "$target" --arg cwd "$run_cwd" \
      --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg cv "${claude_version:-}" \
      --argjson args "$args_json" \
      --argjson resolved "$(if [[ -n "$resolved" ]]; then cat "$resolved"; else printf 'null'; fi)" \
      "$MARKER_JQ"
    printf '%s\n' "$run_json"
    ;;

  finish)
    require_marker
    write_json "$run_json" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.finished_at = (.finished_at // $t)' "$run_json"
    ;;

  show)
    require_marker
    jq . "$run_json" ;;

  *)
    die "unknown command: $cmd" 2 ;;
esac
