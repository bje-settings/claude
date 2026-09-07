#!/usr/bin/env bash
# ft-harden-state.sh: read and write the state of one hardening run.
#
#   ft-harden-state.sh path <plugin:skill>
#   ft-harden-state.sh init <plugin:skill> [--force] [--model <alias>] [--effort low|medium|high]
#   ft-harden-state.sh show <plugin:skill>
#   ft-harden-state.sh add-target <plugin:skill> <path> [--repo <owner/name>]
#   ft-harden-state.sh set <plugin:skill> <path> <field> <value> [--json]
#   ft-harden-state.sh next <plugin:skill>
#
# One state file per skill being hardened, at
#   ${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/harden/<plugin>__<skill>.json
# Writes go to a temp file and are moved into place, so a crash mid-write leaves
# the old state intact. `init` refuses to overwrite an existing run without
# --force, because the targets already worked are the thing you would lose.
#
# The loop writes every transition here before taking the next action, so a
# session that stopped can re-run the skill and continue. `next` prints the path
# of the first target still to do, and nothing when the list is exhausted.
#
# `set` accepts only the fields below. pr and review_rounds take a number or null
# and issues a JSON array (--json is implied for all three); everything else is
# stored as a string.
#   status phase issues pr review_rounds merge_sha question summary repo
# Target statuses: pending running paused done failed
# Phases: field-test verify fix review merge summary done
#
# Exit 0 on success, 1 on any other failure, 2 on usage, 3 when init would
# overwrite without --force.
#
# Written for bash 3.2.

set -uo pipefail

STATUSES=" pending running paused done failed "
PHASES=" field-test verify fix review merge summary done "
FIELDS=" status phase issues pr review_rounds merge_sha question summary repo "
EFFORTS=" low medium high "
MODELS=" haiku sonnet opus fable inherit "
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"

usage() { sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-harden-state.sh: %s\n' "$1" >&2; exit "${2:-1}"; }
need() { [[ -n "${2:-}" && "${2:-}" != -* ]] || die "$1 needs a value" 2; }

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

state_dir="${FT_STATE_DIR:-${CLAUDE_PLUGIN_DATA:-}}"
[[ -n "$state_dir" ]] || die 'set CLAUDE_PLUGIN_DATA (or FT_STATE_DIR) to locate the state file' 2

skill="${1:-}"; shift 2>/dev/null || true
[[ -n "$skill" && "$skill" != -* ]] || die "$cmd needs a <plugin:skill> target" 2
[[ "$skill" == *:* ]] || die "target must be plugin:skill, got: $skill" 2

# gh:shepherd becomes gh__shepherd, the same shape ws-state.py uses for owner/name.
safe="${skill//\//_}"
path="$state_dir/harden/${safe//:/__}.json"

write_state() {
  local filter="$1"; shift
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
  [[ -f "$path" ]] || die "no hardening run for $skill; run init first"
  jq -e 'type == "object" and (.targets | type) == "array"' "$path" >/dev/null 2>&1 \
    || die "state file is not valid field-test JSON: $path"
}

case "$cmd" in
  path)
    printf '%s\n' "$path" ;;

  init)
    force=""; model="opus"; effort="high"
    while (($#)); do
      case "$1" in
        --force) force=1; shift ;;
        --model) need "$1" "${2:-}"; model="$2"; shift 2 ;;
        --effort) need "$1" "${2:-}"; effort="$2"; shift 2 ;;
        *) die "init: unknown argument: $1" 2 ;;
      esac
    done
    [[ "$MODELS" == *" $model "* ]] || die "init: model must be one of$MODELS got: $model" 2
    [[ "$EFFORTS" == *" $effort "* ]] || die "init: effort must be low, medium, or high, got: $effort" 2
    if [[ -f "$path" && -z "$force" ]]; then
      die "a hardening run for $skill already exists at $path; pass --force to start over" 3
    fi
    mkdir -p "$state_dir/harden" || die "cannot create $state_dir/harden"
    tmp="$path.tmp.$$"
    jq -n --arg skill "$skill" --arg model "$model" --arg effort "$effort" \
      --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{version: 1, skill: $skill, created: $created, model: $model, effort: $effort,
        targets: []}' > "$tmp" || { rm -f "$tmp"; die "cannot write $tmp"; }
    mv "$tmp" "$path" || { rm -f "$tmp"; die "cannot write $path"; }
    printf '%s\n' "$path"
    ;;

  show)
    require_state
    jq . "$path" ;;

  add-target)
    target="${1:-}"; shift 2>/dev/null || true
    [[ -n "$target" && "$target" != -* ]] || die 'add-target needs a repository path' 2
    repo=""
    while (($#)); do
      case "$1" in
        --repo) need "$1" "${2:-}"; repo="$2"; shift 2 ;;
        *) die "add-target: unknown argument: $1" 2 ;;
      esac
    done
    require_state
    write_state "$LIB/harden-state.jq" --arg path "$target" --arg repo "$repo"
    ;;

  set)
    target="${1:-}"; field="${2:-}"; value="${3:-}"; mode="${4:-}"
    [[ -n "$target" && -n "$field" && $# -ge 3 ]] || die 'set needs <path> <field> <value> [--json]' 2
    [[ -z "$mode" || "$mode" == "--json" ]] || die "set: unknown argument: $mode" 2
    # Whole words only: a value holding a space could match two valid words at
    # once against the padded list, and a target whose status is "pending done"
    # is one `next` would skip without a word.
    [[ "$field" != *[[:space:]]* && "$FIELDS" == *" $field "* ]] \
      || die "set: unknown field: $field (one of:$FIELDS)" 2
    if [[ "$field" == "status" ]] && [[ "$value" == *[[:space:]]* || "$STATUSES" != *" $value "* ]]; then
      die "set: invalid status: $value (one of:$STATUSES)" 2
    fi
    if [[ "$field" == "phase" ]] && [[ "$value" == *[[:space:]]* || "$PHASES" != *" $value "* ]]; then
      die "set: invalid phase: $value (one of:$PHASES)" 2
    fi
    if [[ "$field" == "pr" || "$field" == "review_rounds" ]]; then
      [[ "$value" =~ ^[0-9]+$ || "$value" == "null" ]] || die "set: $field takes a number or null, got: $value" 2
      mode="--json"
    elif [[ "$field" == "issues" ]]; then
      # Valid JSON that is not an array is refused here; invalid JSON falls
      # through to the --json check below and is named as such.
      if printf '%s' "$value" | jq -e . >/dev/null 2>&1 \
        && ! printf '%s' "$value" | jq -e 'type == "array"' >/dev/null 2>&1; then
        die "set: issues takes a JSON array, got: $value" 2
      fi
      mode="--json"
    fi
    if [[ "$mode" == "--json" ]]; then
      [[ -n "$value" ]] && printf '%s' "$value" | jq . >/dev/null 2>&1 \
        || die "set: --json value is not valid JSON: $value" 2
    fi
    require_state
    jq -e --arg p "$target" '.targets[] | select(.path == $p)' "$path" >/dev/null \
      || die "set: unknown target: $target"
    if [[ "$mode" == "--json" ]]; then
      write_state '(.targets[] | select(.path == $p))[$f] = $v' \
        --arg p "$target" --arg f "$field" --argjson v "$value"
    else
      write_state '(.targets[] | select(.path == $p))[$f] = $v' \
        --arg p "$target" --arg f "$field" --arg v "$value"
    fi
    ;;

  next)
    [[ $# -eq 0 ]] || die "next: unknown argument: $1" 2
    require_state
    # The first target that is neither done nor failed. A paused target is still
    # returned: it is waiting on a decision, and the caller has to see it and stop
    # rather than step over it and bury the question under the next round.
    jq -r 'first(.targets[] | select(.status == "pending" or .status == "running" or .status == "paused") | .path) // empty' "$path"
    ;;

  *)
    die "unknown command: $cmd" 2 ;;
esac
