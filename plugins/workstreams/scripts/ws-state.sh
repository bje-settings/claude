#!/usr/bin/env bash
# ws-state.sh: read and write the workstreams state file for the current repo.
#
#   ws-state.sh path
#   ws-state.sh init [--force] [--repo <owner/name>]
#   ws-state.sh show
#   ws-state.sh meta <field> <value>
#   ws-state.sh add-stream <id> --issues <n,n,...> --kind independent|stack
#                          --model <alias> --effort low|medium|high [--reason <text>]
#                          [--stack <name> --order <n> [--base <branch>]]
#   ws-state.sh set <stream-id> <field> <value> [--json]
#   ws-state.sh list-streams [--status <status>]
#   ws-state.sh defer <issue> <reason>
#
# One state file per repository, at
#   ${WS_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/<owner>__<name>.json
# where owner/name comes from --repo (init only), then WS_REPO, then `gh repo view`.
# Writes go to a temp file and are moved into place, so a crash mid-write leaves
# the old state intact. `init` refuses to overwrite an existing file without
# --force.
#
# A stacked stream is one layer of a stack: --stack names the stack (shared by its
# layers), --order is the position from the bottom starting at 1, and --base is the
# branch of the layer below. The run skill starts one worker per stack.
#
# `set` accepts only the fields below. pr, attempts, and order take a number or
# null; prs takes a JSON array (pass --json); every other field is stored as a
# string unless --json is given. meta values are always strings.
#   status branch worktree pr prs agent question attempts model effort reason base order stack
# Stream statuses: planned running draft reviewing paused done failed
# Models: haiku sonnet opus fable inherit
#
# Exit 0 on success, 1 on any other failure (missing or corrupt state file, unknown
# stream, gh or jq failure, unwritable directory), 2 on usage, 3 when init would
# overwrite without --force.
#
# Written for bash 3.2.

set -uo pipefail

STATUSES=" planned running draft reviewing paused done failed "
KINDS=" independent stack "
FIELDS=" status branch worktree pr prs agent question attempts model effort reason base order stack "
NUMERIC=" pr attempts order "
EFFORTS=" low medium high "
MODELS=" haiku sonnet opus fable inherit "
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

usage() { sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die()   { printf 'ws-state.sh: %s\n' "$1" >&2; exit "${2:-1}"; }
# need <flag> <value>: a flag given last with no value is an error, not an empty string
need()  { [[ -n "${2:-}" && "${2:-}" != -* ]] || die "$1 needs a value" 2; }

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

state_dir="${WS_STATE_DIR:-${CLAUDE_PLUGIN_DATA:-}}"
[[ -n "$state_dir" ]] || die 'set CLAUDE_PLUGIN_DATA (or WS_STATE_DIR) to locate the state file' 2

# resolve_repo [owner/name]: prints owner/name, from the argument or gh
resolve_repo() {
  local r="${1:-}"
  if [[ -z "$r" ]]; then
    # stderr is folded into the message so the real cause (no remote, expired
    # token, offline) reaches the user instead of a generic hint.
    r="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1)" \
      || die "cannot resolve the repository ($(printf '%s' "$r" | tr '\n' ' ')); pass --repo owner/name or set WS_REPO"
  fi
  [[ "$r" == */* ]] || die "repo must be owner/name, got: $r" 2
  printf '%s' "$r"
}

state_path() { printf '%s/%s.json' "$state_dir" "${1//\//__}"; }

# write_state <path> <jq-filter-or-file> [jq args...]: atomic in-place update
write_state() {
  local path="$1" filter="$2"; shift 2
  local tmp="$path.tmp.$$"
  ( : > "$tmp" ) 2>/dev/null || die "cannot write $tmp"
  if [[ -f "$filter" ]]; then
    jq "$@" -f "$filter" "$path" > "$tmp" || { rm -f "$tmp"; die 'jq failed while updating state'; }
  else
    jq "$@" "$filter" "$path" > "$tmp" || { rm -f "$tmp"; die 'jq failed while updating state'; }
  fi
  mv "$tmp" "$path" || { rm -f "$tmp"; die "cannot write $path"; }
}

require_state() {
  [[ -f "$1" ]] || die "no state file at $1; run init first"
  jq -e 'type == "object" and (.streams | type) == "array"' "$1" >/dev/null 2>&1 \
    || die "state file is not valid workstreams JSON: $1"
}

repo_arg=""
force=""

case "$cmd" in
  init)
    while (($#)); do
      case "$1" in
        --force) force=1 ;;
        --repo) need "$1" "${2:-}"; repo_arg="$2"; shift ;;
        *) die "init: unknown argument: $1" 2 ;;
      esac
      shift
    done
    repo="$(resolve_repo "${repo_arg:-${WS_REPO:-}}")" || exit $?
    path="$(state_path "$repo")"
    if [[ -f "$path" && -z "$force" ]]; then
      die "state already exists at $path; pass --force to start over" 3
    fi
    mkdir -p "$state_dir" || die "cannot create $state_dir"
    tmp="$path.tmp.$$"
    jq -n --arg repo "$repo" --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{version: 1, repo: $repo, created: $created, meta: {}, streams: [], deferred: []}' > "$tmp" \
      || { rm -f "$tmp"; die "cannot write $tmp"; }
    mv "$tmp" "$path" || { rm -f "$tmp"; die "cannot write $path"; }
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
    issues=""; kind=""; model=""; effort=""; reason=""; base=""; order=""; stack=""
    while (($#)); do
      case "$1" in
        --issues|--kind|--model|--effort|--reason|--base|--order|--stack) need "$1" "${2:-}" ;;
        *) die "add-stream: unknown argument: $1" 2 ;;
      esac
      case "$1" in
        --issues) issues="$2" ;;
        --kind) kind="$2" ;;
        --model) model="$2" ;;
        --effort) effort="$2" ;;
        --reason) reason="$2" ;;
        --base) base="$2" ;;
        --order) order="$2" ;;
        --stack) stack="$2" ;;
      esac
      shift 2
    done
    [[ -n "$issues" && -n "$kind" && -n "$model" && -n "$effort" ]] \
      || die 'add-stream needs --issues, --kind, --model, and --effort' 2
    [[ "$KINDS" == *" $kind "* ]] || die "add-stream: kind must be independent or stack, got: $kind" 2
    [[ "$EFFORTS" == *" $effort "* ]] || die "add-stream: effort must be low, medium, or high, got: $effort" 2
    [[ "$MODELS" == *" $model "* ]] || die "add-stream: model must be one of$MODELS got: $model" 2
    [[ "$issues" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "add-stream: --issues must be comma-separated numbers, got: $issues" 2
    [[ -z "$order" || "$order" =~ ^[1-9][0-9]*$ ]] || die "add-stream: --order must be a number from 1, got: $order" 2
    if [[ "$kind" == "stack" ]]; then
      [[ -n "$stack" && -n "$order" ]] || die 'add-stream: a stack layer needs --stack and --order' 2
    else
      [[ -z "$stack" && -z "$order" && -z "$base" ]] || die 'add-stream: --stack, --order, and --base are for --kind stack' 2
    fi
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    if jq -e --arg id "$id" '.streams[] | select(.id == $id)' "$path" >/dev/null; then
      die "add-stream: stream already exists: $id"
    fi
    write_state "$path" "$LIB/add-stream.jq" \
      --arg id "$id" --arg issues "$issues" --arg kind "$kind" --arg order "$order" --arg stack "$stack" \
      --arg base "$base" --arg model "$model" --arg effort "$effort" --arg reason "$reason"
    ;;

  set)
    id="${1:-}"; field="${2:-}"; value="${3:-}"; mode="${4:-}"
    [[ -n "$id" && -n "$field" && $# -ge 3 ]] || die 'set needs <stream-id> <field> <value> [--json]' 2
    [[ -z "$mode" || "$mode" == "--json" ]] || die "set: unknown argument: $mode" 2
    [[ "$FIELDS" == *" $field "* ]] || die "set: unknown field: $field (one of:$FIELDS)" 2
    if [[ "$field" == "status" && "$STATUSES" != *" $value "* ]]; then
      die "set: invalid status: $value (one of:$STATUSES)" 2
    fi
    if [[ "$NUMERIC" == *" $field "* ]]; then
      [[ "$value" =~ ^[0-9]+$ || "$value" == "null" ]] || die "set: $field takes a number or null, got: $value" 2
      mode="--json"
    elif [[ "$field" == "prs" ]]; then
      mode="--json"
    fi
    if [[ "$mode" == "--json" ]]; then
      [[ -n "$value" ]] && printf '%s' "$value" | jq . >/dev/null 2>&1 \
        || die "set: --json value is not valid JSON: $value" 2
    fi
    repo="$(resolve_repo "${WS_REPO:-}")" || exit $?
    path="$(state_path "$repo")"; require_state "$path"
    jq -e --arg id "$id" '.streams[] | select(.id == $id)' "$path" >/dev/null \
      || die "set: unknown stream: $id"
    if [[ "$mode" == "--json" ]]; then
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
        --status) need "$1" "${2:-}"; status="$2"; shift ;;
        *) die "list-streams: unknown argument: $1" 2 ;;
      esac
      shift
    done
    if [[ -n "$status" && "$STATUSES" != *" $status "* ]]; then
      die "list-streams: invalid status: $status (one of:$STATUSES)" 2
    fi
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
