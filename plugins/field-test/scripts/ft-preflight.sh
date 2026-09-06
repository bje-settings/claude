#!/usr/bin/env bash
# ft-preflight.sh: check that everything /field-test:harden depends on is present.
#
# Prints one JSON object: {"ok": true|false, "missing": [{"id": ..., "hint": ...}]}
# and exits 0 when everything is present, 1 when anything is missing, 2 on usage,
# 4 when jq itself is missing (plain text on stderr, since no JSON can be built).
# The skill prints each hint verbatim and stops, so hints are commands to run,
# except registry-unreadable, whose hint names the file. A `detail` field carries
# the tool's own message when there is one, so a network error is not reported
# as a missing login.
#
# `harden` reuses the workstreams worker and reviewer agents and the review loop
# they already own rather than growing its own, so both plugins have to be
# installed. That dependency is checked here instead of failing halfway through a
# target, when a fix is already in flight.
#
# Overridable for tests:
#   FT_INSTALLED_PLUGINS   Claude's installed plugins
#                          (default: $HOME/.claude/plugins/installed_plugins.json)
#
# Written for bash 3.2.

set -uo pipefail

usage() {
  printf 'Usage: ft-preflight.sh\n\n'
  printf 'Checks gh, gh auth, jq, the workstreams plugin, and pr-review-toolkit.\n'
}
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) printf 'ft-preflight.sh: unexpected argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac

installed="${FT_INSTALLED_PLUGINS:-$HOME/.claude/plugins/installed_plugins.json}"

command -v jq >/dev/null 2>&1 || { printf 'ft-preflight.sh: jq is required: brew install jq\n' >&2; exit 4; }

missing='[]'
miss() {
  missing="$(printf '%s' "$missing" | jq -c --arg id "$1" --arg hint "$2" '. + [{id: $id, hint: $hint}]')"
}

if ! command -v gh >/dev/null 2>&1; then
  miss gh 'brew install gh'
else
  gh auth status >/dev/null 2>&1 || miss gh-auth 'gh auth login'
fi

# A plugin is present when the registry names it under any marketplace. Which
# marketplace it came from is not this script's business: a fork of workstreams
# under another name is still workstreams to the agents that dispatch it.
if [[ ! -f "$installed" ]]; then
  miss workstreams '/plugin install workstreams@bje'
  miss pr-review-toolkit '/plugin install pr-review-toolkit@claude-plugins-official'
elif ! jq -e . "$installed" >/dev/null 2>&1; then
  miss registry-unreadable "installed plugins file is not valid JSON: $installed"
else
  jq -e '.plugins | keys[] | select(startswith("workstreams@"))' "$installed" >/dev/null 2>&1 \
    || miss workstreams '/plugin install workstreams@bje'
  jq -e '.plugins | keys[] | select(startswith("pr-review-toolkit@"))' "$installed" >/dev/null 2>&1 \
    || miss pr-review-toolkit '/plugin install pr-review-toolkit@claude-plugins-official'
fi

printf '%s' "$missing" | jq '{ok: (length == 0), missing: .}'
[[ "$missing" == "[]" ]]
