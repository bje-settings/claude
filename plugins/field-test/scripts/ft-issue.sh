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

# owner_repo_of <remote-url>: the owner/name a git remote ends in, for the ssh,
# scp and https spellings. Split on the last host separator rather than on the
# literal "github.com": an ssh host alias (git@github.com-work:acme/app.git, which
# is how one machine holds two accounts) otherwise parses as the owner
# "-work:acme", and a wrong owner is one that redaction never replaces.
owner_repo_of() {
  local u="${1%.git}"
  u="${u#*://}"
  u="${u#*@}"
  u="${u#*:}"
  case "$u" in
    */*/*) u="${u#*/}" ;;
  esac
  case "$u" in
    */*/*) printf '' ;;
    */*) printf '%s' "$u" ;;
  esac
}

die() { printf 'ft-issue.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
GH="${FT_GH:-gh}"

# The jq programs below are held in variables filled from a heredoc rather than
# written inline across several lines. Both forms are one shell statement, but kcov
# marks the continuation lines of a multi-line command as code that never runs, so
# an inline program reads as a block of permanently uncovered lines. A heredoc body
# is not instrumented, which is what the coverage number already assumes a jq
# program to be: one line, and the branches inside it tested by their own fixtures
# (see .claude/rules/type-jq.md).

read -r -d '' REFS_JQ <<'JQ' || true
[.command? // "", .last_assistant_message? // "", .reason? // ""] | join(" ")
JQ

read -r -d '' NAMES_JQ <<'JQ' || true
{remote: $remote, repo: $repo, owner: $owner, name: $name,
 branches: $branches, paths: $paths, refs: $refs, subjects: $subjects}
JQ

case "$cmd" in
  names)
    dir="${1:-}"; shift 2>/dev/null || true
    [[ -n "$dir" && -d "$dir" ]] || die 'names needs an existing repository directory' 2
    # Everything below is collected with git. Without a checkout the table comes
    # back nearly empty and ft-redact.sh would still append its note saying the
    # names were replaced, which is how a real name reaches a public issue.
    git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 \
      || die "names needs a git checkout, and $dir is not one; nothing could be redacted" 2
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
      slug="$(owner_repo_of "$remote")"
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
      refs="$(jq -r "$REFS_JQ" "$run_dir/events.jsonl" 2>/dev/null | grep -o '#[0-9][0-9]*' | sort -u)"
    fi
    lines_to_json() { printf '%s' "$1" | jq -Rc 'select(length > 0)' | jq -sc .; }
    jq -n --arg remote "${remote:-}" --arg repo "${slug:-}" --arg owner "${owner:-}" \
      --arg name "${name:-}" \
      --argjson branches "$(lines_to_json "$branches")" \
      --argjson paths "$(lines_to_json "$paths")" \
      --argjson refs "$(lines_to_json "$refs")" \
      --argjson subjects "$(lines_to_json "$subjects")" "$NAMES_JQ" \
      | jq -f "$LIB/names.jq"
    ;;

  search)
    repo="${1:-}"; signature="${2:-}"
    [[ -n "$repo" && -n "$signature" ]] || die 'search needs <repo> <signature>' 2
    # The signature is in the issue body verbatim, so a substring search on it is
    # exact enough; anything gh cannot answer means "no match", and the caller
    # opens a new issue rather than silently attaching to the wrong one.
    # The signature goes to jq through --arg, never spliced into the program: a
    # signature is normalised command text and routinely holds quotes, which would
    # otherwise break the filter and report every duplicate as a new bug.
    "$GH" issue list --repo "$repo" --state open --label field-test \
      --search "$signature" --json number,body 2>/dev/null \
      | jq -r --arg sig "$signature" \
        '[.[] | select(.body | contains($sig))] | .[0].number // empty' 2>/dev/null
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
