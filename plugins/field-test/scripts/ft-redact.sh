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

# The note says what was done, not which categories were present: a checkout with no
# origin remote collects no organization name, and a note that named one anyway would
# be asserting a redaction that never happened.
NOTE='This run was on a repository outside the plugin'"'"'s enterprise, so every name collected from it was replaced with a placeholder. The shape of the case is real; the names are not.'

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
# The jq programs below are held in variables filled from a heredoc rather than
# written inline across several lines. Both forms are one shell statement, but kcov
# marks the continuation lines of a multi-line command as code that never runs, so
# an inline program reads as a block of permanently uncovered lines. A heredoc body
# is not instrumented, which is what the coverage number already assumes a jq
# program to be: one line, and the branches inside it tested by their own fixtures
# (see .claude/rules/type-jq.md).

[[ -f "$names" ]] || die "no names file at $names" 2

if [[ -n "$inside" ]]; then
  cat
  exit 0
fi

table="$(jq -c '.placeholders // []' "$names")" || die "names file is not valid JSON: $names"

# split/join with a plain string is a literal replacement in jq; gsub would treat
# the value as a regular expression.
read -r -d '' REDACT_JQ <<'JQ' || true
reduce $table[] as $n (.; split($n.value) | join($n.placeholder))
| . + "\n> " + $note + "\n"
JQ
jq -Rrs --argjson table "$table" --arg note "$NOTE" "$REDACT_JQ"
