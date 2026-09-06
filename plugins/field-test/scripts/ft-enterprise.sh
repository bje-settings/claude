#!/usr/bin/env bash
# ft-enterprise.sh: are the plugin under test and the repository it was tested on
# in the same GitHub enterprise?
#
#   ft-enterprise.sh <plugin-repo-dir> <target-repo-dir>
#
# Prints one JSON object:
#   {inside, enterprise, plugin_owner, target_owner, reason}
# and always exits 0 with an answer, because "we could not tell" is an answer:
# it is `inside: false`, and the reason says why. Names are redacted whenever
# this says false, so failing closed costs detail in an issue and never leaks a
# repository name.
#
# `inside` is true only when both owners appear under one enterprise slug in
#   viewer { enterprises { nodes { slug organizations { nodes { login } } } } }
# asked once per run through `gh api graphql`, with the organizations paginated.
# Nothing is cached: a run is rare, the answer decides what gets published, and a
# stale cache would decide it wrongly.
#
# Overridable for tests: FT_GH (the gh command, default `gh`).
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-enterprise.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac
[[ $# -eq 2 ]] || { printf 'ft-enterprise.sh: expected <plugin-repo-dir> <target-repo-dir>\n' >&2; exit 2; }

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
GH="${FT_GH:-gh}"

# answer <inside> <enterprise> <reason>
answer() {
  jq -nc --argjson inside "$1" --arg ent "$2" --arg reason "$3" \
    --arg po "${plugin_owner:-}" --arg to "${target_owner:-}" \
    '{inside: $inside, enterprise: (if $ent == "" then null else $ent end),
      plugin_owner: (if $po == "" then null else $po end),
      target_owner: (if $to == "" then null else $to end),
      reason: $reason}'
  exit 0
}

# owner_of <dir>: the owner segment of the origin remote, ssh or https, or nothing
owner_of() {
  local url="" path
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 0
  url="${url%.git}"
  path="${url#*github.com}"
  path="${path#:}"
  path="${path#/}"
  case "$path" in
    */*) printf '%s' "${path%%/*}" ;;
  esac
}

plugin_owner="$(owner_of "$1")"
target_owner="$(owner_of "$2")"
[[ -n "$plugin_owner" ]] || answer false "" "no github origin remote in the plugin checkout ($1)"
[[ -n "$target_owner" ]] || answer false "" "no github origin remote in the repository under test ($2)"

read -r -d '' FIRST_PAGE <<'GQL' || true
query {
  viewer {
    enterprises(first: 10) {
      nodes {
        slug
        organizations(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { login }
        }
      }
    }
  }
}
GQL

read -r -d '' NEXT_PAGE <<'GQL' || true
query($slug: String!, $after: String) {
  enterprise(slug: $slug) {
    organizations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { login }
    }
  }
}
GQL

first="$("$GH" api graphql -f query="$FIRST_PAGE" 2>&1)" \
  || answer false "" "could not read the enterprise list ($(printf '%s' "$first" | tr '\n' ' ' | cut -c1-200)); treating the run as outside"
printf '%s' "$first" | jq -e '.data.viewer.enterprises.nodes' >/dev/null 2>&1 \
  || answer false "" 'the enterprise query returned no data; the token may lack read:enterprise'

# One line per enterprise: slug, whether there are more organizations, the cursor.
# Enterprises are few; the pagination below only runs for one that has more than a
# hundred organizations, which is the case the first page would answer wrongly.
enterprises="$(printf '%s' "$first" | jq -r '
  .data.viewer.enterprises.nodes[]?
  | [.slug, (.organizations.pageInfo.hasNextPage | tostring), (.organizations.pageInfo.endCursor // "")]
  | @tsv')"

match_slug=""
while IFS="$(printf '\t')" read -r slug more cursor; do
  [[ -n "$slug" ]] || continue
  logins="$(printf '%s' "$first" | jq -r --arg s "$slug" '
    .data.viewer.enterprises.nodes[]? | select(.slug == $s) | .organizations.nodes[]?.login')"
  while [[ "$more" == "true" && -n "$cursor" ]]; do
    page="$("$GH" api graphql -f query="$NEXT_PAGE" -f slug="$slug" -f after="$cursor" 2>/dev/null)" || break
    logins="$logins
$(printf '%s' "$page" | jq -r '.data.enterprise.organizations.nodes[]?.login')"
    more="$(printf '%s' "$page" | jq -r '.data.enterprise.organizations.pageInfo.hasNextPage // false')"
    cursor="$(printf '%s' "$page" | jq -r '.data.enterprise.organizations.pageInfo.endCursor // ""')"
  done
  if printf '%s\n' "$logins" | grep -qx -- "$plugin_owner" \
    && printf '%s\n' "$logins" | grep -qx -- "$target_owner"; then
    match_slug="$slug"
    break
  fi
done <<EOF
$enterprises
EOF

[[ -n "$match_slug" ]] \
  && answer true "$match_slug" "$plugin_owner and $target_owner are both organizations in the $match_slug enterprise"
answer false "" "$plugin_owner and $target_owner are not both organizations in one enterprise you belong to"
