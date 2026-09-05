#!/usr/bin/env bash
# ws-preflight.sh: check that everything the workstreams skills depend on is present.
#
# Prints one JSON object: {"ok": true|false, "missing": [{"id": ..., "hint": ...}]}
# and exits 0 when everything is present, 1 when anything is missing, 2 on usage,
# 4 when jq itself is missing (plain text on stderr, since no JSON can be built).
# The skills print each hint verbatim and stop, so hints are commands to run.
#
# The gh-stack skill is accepted from the user's skills directory, from
# .claude/skills/gh-stack at the root of the current repository, or from an installed plugin
# named gh-stack.
#
# Overridable for tests:
#   WS_SKILLS_DIR          where user skills live      (default: $HOME/.claude/skills)
#   WS_INSTALLED_PLUGINS   Claude's installed plugins   (default: $HOME/.claude/plugins/installed_plugins.json)
#
# Written for bash 3.2.

set -uo pipefail

usage() {
  printf 'Usage: ws-preflight.sh\n\n'
  printf 'Checks gh, gh auth, jq, the gh-stack extension and skill, and pr-review-toolkit.\n'
}
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) printf 'ws-preflight.sh: unexpected argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac

skills_dir="${WS_SKILLS_DIR:-$HOME/.claude/skills}"
installed="${WS_INSTALLED_PLUGINS:-$HOME/.claude/plugins/installed_plugins.json}"

command -v jq >/dev/null 2>&1 || { printf 'ws-preflight.sh: jq is required: brew install jq\n' >&2; exit 4; }

missing='[]'
miss() {
  # miss <id> <hint>: append one entry to the missing array
  missing="$(printf '%s' "$missing" | jq -c --arg id "$1" --arg hint "$2" '. + [{id: $id, hint: $hint}]')"
}

if ! command -v gh >/dev/null 2>&1; then
  miss gh 'brew install gh'
else
  gh auth status >/dev/null 2>&1 || miss gh-auth 'gh auth login'
  # A failing `gh extension list` is a broken gh, not a missing extension, so
  # the two are reported apart and the real error is kept.
  if ext="$(gh extension list 2>&1)"; then
    printf '%s\n' "$ext" | awk -F'\t' '$2 == "github/gh-stack" { found = 1 } END { exit !found }' \
      || miss gh-stack-extension 'gh extension install github/gh-stack'
  else
    miss gh-broken "gh extension list failed: $(printf '%s' "$ext" | tr '\n' ' ')"
  fi
fi

# The skill may be installed by `gh skill install` (user or repo) or delivered by a plugin.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [[ ! -f "$skills_dir/gh-stack/SKILL.md" && ! -f "$repo_root/.claude/skills/gh-stack/SKILL.md" ]] \
  && ! jq -e '.plugins | keys[] | select(startswith("gh-stack@"))' "$installed" >/dev/null 2>&1; then
  miss gh-stack-skill 'gh skill install github/gh-stack --agent claude-code'
fi

if [[ ! -f "$installed" ]]; then
  miss pr-review-toolkit '/plugin install pr-review-toolkit@claude-plugins-official'
elif ! jq -e . "$installed" >/dev/null 2>&1; then
  miss pr-review-toolkit "installed plugins file is not valid JSON: $installed"
elif ! jq -e '.plugins | keys[] | select(startswith("pr-review-toolkit@"))' "$installed" >/dev/null 2>&1; then
  miss pr-review-toolkit '/plugin install pr-review-toolkit@claude-plugins-official'
fi

printf '%s' "$missing" | jq '{ok: (length == 0), missing: .}'
[[ "$missing" == "[]" ]]
