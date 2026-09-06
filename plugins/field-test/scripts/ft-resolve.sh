#!/usr/bin/env bash
# ft-resolve.sh: work out what a field-test target actually is, before running it.
#
#   ft-resolve.sh <target>
#
# Targets:
#   plugin:skill   an installed plugin's skill, found through Claude's own registry
#   name           a project or user command (.claude/commands/<name>.md), then a
#                  project or user skill (.claude/skills/<name>/SKILL.md)
#   workflow:name  refused: see below
#
# Prints one JSON object on success:
#   {kind, target, plugin, skill, marketplace, path, version, install_path,
#    marketplace_path, commit, repo}
# `path` is the file that defines the target. `commit` and `repo` are filled only
# when the marketplace was added from a local directory, which is the case the
# issues care about: a finding is worth filing against a checkout you can fix.
#
# Workflow targets are unsupported in v1 and exit 5 rather than being guessed at.
# Whether a background workflow agent's tool calls fire this plugin's hooks in the
# parent session, and under which session_id, is unknown; a field test that
# silently records nothing is worse than one that refuses.
#
# Exit 0 resolved, 2 on usage, 3 unresolved, 5 workflow target.
#
# Overridable for tests:
#   FT_INSTALLED_PLUGINS   default $HOME/.claude/plugins/installed_plugins.json
#   FT_MARKETPLACES        default $HOME/.claude/plugins/known_marketplaces.json
#   FT_USER_DIR            default $HOME/.claude
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-resolve.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac
[[ $# -eq 1 ]] || die "expected one target, got $#" 2

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'

target="$1"
installed="${FT_INSTALLED_PLUGINS:-$HOME/.claude/plugins/installed_plugins.json}"
markets="${FT_MARKETPLACES:-$HOME/.claude/plugins/known_marketplaces.json}"
user_dir="${FT_USER_DIR:-$HOME/.claude}"
project_dir="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"

lower="$(printf '%s' "$target" | tr '[:upper:]' '[:lower:]')"
case "$lower" in
  workflow:*|workflow\ *)
    die "workflow targets are not supported yet: $target (hooks may not see a background workflow agent's tool calls)" 5 ;;
esac

# emit <kind> <plugin> <skill> <marketplace> <path> <version> <install_path> <marketplace_path> <commit> <repo>
emit() {
  jq -nc --arg kind "$1" --arg target "$target" --arg plugin "$2" --arg skill "$3" \
    --arg marketplace "$4" --arg path "$5" --arg version "$6" --arg install "$7" \
    --arg mpath "$8" --arg commit "$9" --arg repo "${10}" \
    '{kind: $kind, target: $target,
      plugin: (if $plugin == "" then null else $plugin end),
      skill: (if $skill == "" then null else $skill end),
      marketplace: (if $marketplace == "" then null else $marketplace end),
      path: $path,
      version: (if $version == "" then null else $version end),
      install_path: (if $install == "" then null else $install end),
      marketplace_path: (if $mpath == "" then null else $mpath end),
      commit: (if $commit == "" then null else $commit end),
      repo: (if $repo == "" then null else $repo end)}'
}

# owner_repo <dir>: owner/name from the checkout's origin remote, ssh or https.
owner_repo() {
  local url
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 0
  url="${url%.git}"
  url="${url#*github.com}"
  url="${url#:}"
  url="${url#/}"
  case "$url" in
    */*) printf '%s' "$url" ;;
  esac
}

if [[ "$target" == *:* ]]; then
  plugin="${target%%:*}"
  skill="${target#*:}"
  [[ -n "$plugin" && -n "$skill" && "$skill" != *:* ]] \
    || die "a plugin target must be plugin:skill, got: $target" 2
  [[ -f "$installed" ]] || die "no installed plugins file at $installed" 3
  jq -e . "$installed" >/dev/null 2>&1 || die "installed plugins file is not valid JSON: $installed" 3

  # One line per installed copy: "<marketplace>\t<installPath>\t<version>".
  # A plugin can be installed from more than one marketplace and at more than one
  # scope; the first copy that actually carries the skill is the one under test.
  found=""
  while IFS="$(printf '\t')" read -r market install version; do
    [[ -n "$install" ]] || continue
    [[ -f "$install/skills/$skill/SKILL.md" ]] || continue
    found="$market"$'\t'"$install"$'\t'"$version"
    break
  done <<EOF
$(jq -r --arg p "$plugin" '
  .plugins // {} | to_entries[]
  | select(.key | startswith($p + "@"))
  | (.key | split("@")[1]) as $m
  | .value[]? | [$m, (.installPath // ""), (.version // "")] | @tsv' "$installed" 2>/dev/null)
EOF
  [[ -n "$found" ]] || die "no installed plugin provides $target; install it and try again" 3

  market="${found%%$'\t'*}"
  rest="${found#*$'\t'}"
  install="${rest%%$'\t'*}"
  version="${rest#*$'\t'}"

  mpath=""; commit=""; repo=""
  if [[ -f "$markets" ]]; then
    mpath="$(jq -r --arg m "$market" '
      (.[$m] // {}) as $e
      | if ($e.source.source // "") == "directory"
        then ($e.source.path // $e.installLocation // "") else "" end' "$markets" 2>/dev/null)"
    [[ "$mpath" == "null" ]] && mpath=""
  fi
  if [[ -n "$mpath" && -d "$mpath" ]]; then
    commit="$(git -C "$mpath" rev-parse HEAD 2>/dev/null)"
    repo="$(owner_repo "$mpath")"
  fi
  emit plugin-skill "$plugin" "$skill" "$market" "$install/skills/$skill/SKILL.md" \
    "$version" "$install" "$mpath" "$commit" "$repo"
  exit 0
fi

for candidate in \
  "command:$project_dir/.claude/commands/$target.md" \
  "command:$user_dir/commands/$target.md" \
  "skill:$project_dir/.claude/skills/$target/SKILL.md" \
  "skill:$user_dir/skills/$target/SKILL.md"; do
  kind="${candidate%%:*}"
  path="${candidate#*:}"
  [[ -f "$path" ]] || continue
  emit "$kind" "" "$target" "" "$path" "" "" "" "" ""
  exit 0
done

die "cannot resolve $target as a plugin skill, a command, or a skill; give it as plugin:skill or install it" 3
