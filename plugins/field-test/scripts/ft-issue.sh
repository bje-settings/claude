#!/usr/bin/env bash
# ft-issue.sh: the pieces of filing a field-test finding as an issue.
#
#   ft-issue.sh names <target-repo-dir> [--run <run-dir>]
#   ft-issue.sh search <repo> <signature>
#   ft-issue.sh render <record.json> <run.json> <names.json> [--inside]
#   ft-issue.sh ensure-label <repo>
#
# Nothing here creates an issue. Creating one is a side effect the user confirms,
# so it stays in the skill where the user can see what is about to be published;
# these are the deterministic parts around it.
#
# names   collects every string that identifies the repository under test: its
#         remote, owner, name, owner/name, checkout path, branches, recent commit
#         subjects, and the #N references seen in the run. Redaction is literal, so
#         a name that is not collected here is a name that survives into a public
#         issue: err towards collecting too much.
# search  looks for an open issue on the plugin's repo with the same signature, so
#         a second run of the same bug comments instead of opening a duplicate.
# render  fills the issue template from one finding and pipes it through
#         ft-redact.sh. The first line of the output is the title; the rest is the
#         body.
# ensure-label  creates the field-test label if it is not there.
#
# Exit 0 on success, 1 on failure, 2 on usage.
#
# Overridable for tests: FT_GH (the gh command, default `gh`).
#
# Written for bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/lib"
TEMPLATE="$HERE/../skills/run/issue-template.md"

usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-issue.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
GH="${FT_GH:-gh}"

case "$cmd" in
  names)
    dir="${1:-}"; shift 2>/dev/null || true
    [[ -n "$dir" && -d "$dir" ]] || die 'names needs an existing repository directory' 2
    run_dir=""
    while (($#)); do
      case "$1" in
        --run) [[ -n "${2:-}" ]] || die '--run needs a value' 2; run_dir="$2"; shift 2 ;;
        *) die "names: unknown argument: $1" 2 ;;
      esac
    done
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$dir")"
    # Both spellings of the checkout: git resolves symlinks in --show-toplevel and
    # the caller's own path may not be resolved, and a path that is only half
    # collected is a path that survives into a public issue.
    abs="$(cd "$dir" 2>/dev/null && pwd)"
    paths="$top"
    [ -n "$abs" ] && [ "$abs" != "$top" ] && paths="$top
$abs"
    remote="$(git -C "$dir" remote get-url origin 2>/dev/null)"
    slug=""; owner=""; name=""
    if [[ -n "$remote" ]]; then
      slug="${remote%.git}"
      slug="${slug#*github.com}"
      slug="${slug#:}"
      slug="${slug#/}"
      case "$slug" in
        */*) owner="${slug%%/*}"; name="${slug#*/}" ;;
        *) slug="" ;;
      esac
    fi
    [[ -n "$name" ]] || name="$(basename "$top")"
    branches="$(git -C "$dir" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)"
    subjects="$(git -C "$dir" log --format='%s' -20 2>/dev/null)"
    # #N references seen during the run: they are pull request and issue numbers on
    # the repository under test, which name it as surely as its branches do.
    refs=""
    if [[ -n "$run_dir" && -f "$run_dir/events.jsonl" ]]; then
      refs="$(jq -r '[.command? // "", .last_assistant_message? // "", .reason? // ""] | join(" ")' \
        "$run_dir/events.jsonl" 2>/dev/null | grep -o '#[0-9][0-9]*' | sort -u)"
    fi
    lines_to_json() { printf '%s' "$1" | jq -Rc 'select(length > 0)' | jq -sc .; }
    jq -n --arg remote "${remote:-}" --arg repo "${slug:-}" --arg owner "${owner:-}" \
      --arg name "${name:-}" \
      --argjson branches "$(lines_to_json "$branches")" \
      --argjson paths "$(lines_to_json "$paths")" \
      --argjson refs "$(lines_to_json "$refs")" \
      --argjson subjects "$(lines_to_json "$subjects")" \
      '{remote: $remote, repo: $repo, owner: $owner, name: $name,
        branches: $branches, paths: $paths, refs: $refs, subjects: $subjects}' \
      | jq -f "$LIB/names.jq"
    ;;

  search)
    repo="${1:-}"; signature="${2:-}"
    [[ -n "$repo" && -n "$signature" ]] || die 'search needs <repo> <signature>' 2
    # The signature is in the issue body verbatim, so a substring search on it is
    # exact enough; anything gh cannot answer means "no match", and the caller
    # opens a new issue rather than silently attaching to the wrong one.
    "$GH" issue list --repo "$repo" --state open --label field-test \
      --search "$signature" --json number,body \
      --jq "[.[] | select(.body | contains(\"$signature\"))] | .[0].number // empty" 2>/dev/null
    exit 0
    ;;

  render)
    record="${1:-}"; run="${2:-}"; names="${3:-}"; shift 3 2>/dev/null || true
    [[ -f "${record:-}" && -f "${run:-}" && -f "${names:-}" ]] \
      || die 'render needs <record.json> <run.json> <names.json>' 2
    inside=""
    case "${1:-}" in
      "") ;;
      --inside) inside="--inside" ;;
      *) die "render: unknown argument: $1" 2 ;;
    esac
    [[ -f "$TEMPLATE" ]] || die "no issue template at $TEMPLATE"
    jq -rn --rawfile template "$TEMPLATE" \
      --argjson record "$(cat "$record")" --argjson run "$(cat "$run")" \
      -f "$LIB/render.jq" \
      | bash "$HERE/ft-redact.sh" "$names" $inside
    ;;

  ensure-label)
    repo="${1:-}"
    [[ -n "$repo" ]] || die 'ensure-label needs <repo>' 2
    "$GH" label create field-test --repo "$repo" --force \
      --color BFD4F2 --description 'Found while running a skill under /field-test:run' \
      || die "could not create the field-test label on $repo"
    ;;

  *)
    die "unknown command: $cmd" 2 ;;
esac
