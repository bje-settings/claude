#!/usr/bin/env bash
# run.sh — lint and test the plugin scripts.
#
#   spec/run.sh           lint, then the suite under both shells
#   spec/run.sh --quick   the suite under the default shell only
#
# The suite runs twice by design. bash 5 is what most contributors have on PATH;
# /bin/bash is 3.2 on macOS and is what actually executes these scripts when the
# plugin runs, so a passing 5.x run alone proves little.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fail=0
run() { printf '\n\033[1m== %s\033[0m\n' "$1"; shift; "$@" || fail=1; }

if command -v shellcheck >/dev/null 2>&1; then
  run "shellcheck" shellcheck -S warning \
    plugins/gh/scripts/gh-sync.sh \
    plugins/gh/scripts/gh-sync-repo.sh \
    plugins/gh/hooks/session-start.sh \
    fixtures/gh/fixtures.sh \
    fixtures/gh/bin/gh
else
  printf 'shellcheck not installed, skipping lint\n' >&2
fi

command -v shellspec >/dev/null 2>&1 || {
  printf 'shellspec is required: brew install shellspec\n' >&2
  exit 1
}

run "shellspec (default shell)" shellspec "$@"
if [[ "${1:-}" != "--quick" ]]; then
  run "shellspec (/bin/bash, the shell that ships on macOS)" shellspec --shell /bin/bash
fi

((fail)) && { printf '\n\033[31mFAILED\033[0m\n'; exit 1; }
printf '\n\033[32mAll green\033[0m\n'
