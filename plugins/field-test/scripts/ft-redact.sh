#!/usr/bin/env bash
# ft-redact.sh: strip a repository's identity out of text bound for a public issue.
#
#   ft-redact.sh <names.json> [--inside] < text > text
#
# names.json is what `ft-issue.sh names` produced: a table of literal strings and
# the placeholder each becomes, longest first.
#
# With --inside this is the identity function, byte for byte: the repository under
# test belongs to the same enterprise as the plugin, so the specifics are exactly
# what makes the issue reproducible and they stay.
#
# Without it, every name in the table is replaced and a line is appended saying the
# run was on a repository outside the enterprise, so a reader knows the shape is
# real and the names are not. Matching is literal, not regular expression: a branch
# or commit subject can contain anything, and a pattern built from one would be a
# way to leak the very name this exists to remove.
#
# Exit 0, 1 on a broken names file, 2 on usage.
#
# Written for bash 3.2.

set -uo pipefail

usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'ft-redact.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

NOTE='This run was on a repository outside the plugin'"'"'s enterprise, so the organization, repository, path, branch, commit, and pull request names above were replaced with placeholders. The shape of the case is real; the names are not.'

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

names="$1"; shift
inside=""
case "${1:-}" in
  "") ;;
  --inside) inside=1 ;;
  *) die "unknown argument: $1" 2 ;;
esac

command -v jq >/dev/null 2>&1 || die 'jq is required: brew install jq'
[[ -f "$names" ]] || die "no names file at $names" 2

if [[ -n "$inside" ]]; then
  cat
  exit 0
fi

table="$(jq -c '.placeholders // []' "$names")" || die "names file is not valid JSON: $names"

# split/join with a plain string is a literal replacement in jq; gsub would treat
# the value as a regular expression.
jq -Rrs --argjson table "$table" --arg note "$NOTE" '
  reduce $table[] as $n (.; split($n.value) | join($n.placeholder))
  | . + "\n> " + $note + "\n"'
