#!/usr/bin/env bash
# ws-state.sh — read and write the workstreams state file for the current repo.
#
#   ws-state.sh path
#   ws-state.sh init [--force] [--repo <owner/name>]
#   ws-state.sh show
#   ws-state.sh meta <field> <value>
#   ws-state.sh add-stream <id> --issues <n,n,...> --kind independent|stack
#                          --model <alias> --effort <level> [--reason <text>]
#                          [--base <branch>] [--order <n>]
#   ws-state.sh set <stream-id> <field> <value> [--json]
#   ws-state.sh list-streams [--status <status>]
#   ws-state.sh defer <issue> <reason>
#
# One state file per repository, at
#   ${WS_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/<owner>__<name>.json
# where owner/name comes from --repo or `gh repo view`. Writes go to a temp file
# and are moved into place, so a crash mid-write leaves the old state intact.
# `init` refuses to overwrite an existing file without --force.
#
# Stream statuses: planned running draft reviewing paused done failed
#
# Exit 0 on success, 1 when the file is missing or a stream is unknown, 2 on usage,
# 3 when init would overwrite without --force.
#
# Written for bash 3.2.

set -uo pipefail

STATUSES=" planned running draft reviewing paused done failed "
KINDS=" independent stack "

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die()   { printf 'ws-state.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

state_dir="${WS_STATE_DIR:-${CLAUDE_PLUGIN_DATA:-}}"
[[ -n "$state_dir" ]] || die 'set CLAUDE_PLUGIN_DATA (or WS_STATE_DIR) to locate the state file' 2

# resolve_repo [owner/name] — prints owner/name, from the argument or gh
resolve_repo() {
  local r="${1:-}"
  if [[ -z "$r" ]]; then
    r="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" \
      || die 'cannot resolve the repository; pass --repo owner/name'
  fi
  [[ "$r" == */* ]] || die "repo must be owner/name, got: $r" 2
  printf '%s' "$r"
}

state_path() { printf '%s/%s.json' "$state_dir" "${1//\//__}"; }

# write_state <path> <jq-filter> [jq args...] — atomic in-place update
write_state() {
  local path="$1" filter="$2"; shift 2
  local tmp="$path.tmp.$$"
  jq "$@" "$filter" "$path" > "$tmp" || { rm -f "$tmp"; die 'jq failed while updating state'; }
  mv "$tmp" "$path"
}

require_state() {
  [[ -f "$1" ]] || die "no state file at $1; run init first"
}

# Everything except init and path uses the repo recorded by gh, or WS_REPO.
repo_arg=""
force=""

case "$cmd" in
  init)
    while (($#)); do
      case "$1" in
        --force) force=1 ;;
        --repo) repo_arg="${2:-}"; shift ;;
        *) die "init: unknown argument: $1" 2 ;;
      esac
      shift
    done
    repo="$(resolve_repo "$repo_arg")" || exit $?
    path="$(state_path "$repo")"
    if [[ -f "$path" && -z "$force" ]]; then
      die "state already exists at $path; pass --force to start over" 3
    fi
    mkdir -p "$state_dir"
    tmp="$path.tmp.$$"
    jq -n --arg repo "$repo" --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{version: 1, repo: $repo, created: $created, meta: {}, streams: [], deferred: []}' > "$tmp"
    mv "$tmp" "$path"
    printf '%s\n' "$path"
    ;;

  path)
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    state_path "$repo"; printf '\n'
    ;;

  show)
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    jq . "$path"
    ;;

  meta)
    [[ $# -eq 2 ]] || die 'meta needs <field> <value>' 2
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    write_state "$path" '.meta[$k] = $v' --arg k "$1" --arg v "$2"
    ;;

  add-stream)
    id="${1:-}"; shift 2>/dev/null || true
    [[ -n "$id" && "$id" != -* ]] || die 'add-stream needs a stream id first' 2
    issues=""; kind=""; model=""; effort=""; reason=""; base=""; order=""
    while (($#)); do
      case "$1" in
        --issues) issues="${2:-}"; shift ;;
        --kind) kind="${2:-}"; shift ;;
        --model) model="${2:-}"; shift ;;
        --effort) effort="${2:-}"; shift ;;
        --reason) reason="${2:-}"; shift ;;
        --base) base="${2:-}"; shift ;;
        --order) order="${2:-}"; shift ;;
        *) die "add-stream: unknown argument: $1" 2 ;;
      esac
      shift
    done
    [[ -n "$issues" && -n "$kind" && -n "$model" && -n "$effort" ]] \
      || die 'add-stream needs --issues, --kind, --model, and --effort' 2
    [[ "$KINDS" == *" $kind "* ]] || die "add-stream: kind must be independent or stack, got: $kind" 2
    [[ "$issues" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "add-stream: --issues must be comma-separated numbers, got: $issues" 2
    [[ -z "$order" || "$order" =~ ^[0-9]+$ ]] || die "add-stream: --order must be a number, got: $order" 2
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    if jq -e --arg id "$id" '.streams[] | select(.id == $id)' "$path" >/dev/null; then
      die "add-stream: stream already exists: $id"
    fi
    write_state "$path" '.streams += [{
        id: $id,
        issues: ($issues | split(",") | map(tonumber)),
        kind: $kind, order: (if $order == "" then null else ($order | tonumber) end),
        base: (if $base == "" then null else $base end),
        model: $model, effort: $effort, reason: $reason,
        status: "planned", branch: null, worktree: null, pr: null,
        agent: null, question: null, attempts: 0
      }]' \
      --arg id "$id" --arg issues "$issues" --arg kind "$kind" --arg order "$order" \
      --arg base "$base" --arg model "$model" --arg effort "$effort" --arg reason "$reason"
    ;;

  set)
    id="${1:-}"; field="${2:-}"; value="${3:-}"; mode="${4:-}"
    [[ -n "$id" && -n "$field" && $# -ge 3 ]] || die 'set needs <stream-id> <field> <value> [--json]' 2
    [[ -z "$mode" || "$mode" == "--json" ]] || die "set: unknown argument: $mode" 2
    [[ "$field" != "id" ]] || die 'set: the id field is immutable' 2
    if [[ "$field" == "status" && "$STATUSES" != *" $value "* ]]; then
      die "set: invalid status: $value (one of:$STATUSES)" 2
    fi
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    jq -e --arg id "$id" '.streams[] | select(.id == $id)' "$path" >/dev/null \
      || die "set: unknown stream: $id"
    if [[ "$mode" == "--json" ]]; then
      printf '%s' "$value" | jq -e . >/dev/null 2>&1 || die "set: --json value is not valid JSON: $value" 2
      write_state "$path" '(.streams[] | select(.id == $id))[$f] = $v' \
        --arg id "$id" --arg f "$field" --argjson v "$value"
    else
      write_state "$path" '(.streams[] | select(.id == $id))[$f] = $v' \
        --arg id "$id" --arg f "$field" --arg v "$value"
    fi
    ;;

  list-streams)
    status=""
    while (($#)); do
      case "$1" in
        --status) status="${2:-}"; shift ;;
        *) die "list-streams: unknown argument: $1" 2 ;;
      esac
      shift
    done
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    jq --arg s "$status" '[.streams[] | select($s == "" or .status == $s)]' "$path"
    ;;

  defer)
    [[ $# -eq 2 && "$1" =~ ^[0-9]+$ ]] || die 'defer needs <issue-number> <reason>' 2
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    write_state "$path" '.deferred = ([.deferred[] | select(.issue != $n)] + [{issue: $n, reason: $r}])' \
      --argjson n "$1" --arg r "$2"
    ;;

  *)
    die "unknown command: $cmd" 2 ;;
esac
