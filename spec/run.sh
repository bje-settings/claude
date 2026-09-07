#!/usr/bin/env bash
# run.sh — lint and test the plugin scripts.
#
#   spec/run.sh             lint, then both harnesses (shellspec on both shells)
#   spec/run.sh --quick     pytest, then shellspec once under the default shell
#   spec/run.sh --coverage  both harnesses with the CI thresholds applied
#   SPEC_JOBS=N spec/run.sh shellspec --jobs to use (default: the core count,
#                           split between the two passes when both run)
#
# There are two harnesses. shellspec covers the scripts that are still bash;
# pytest covers the ones that are Python. This runs both, so one command still
# covers the repo.
#
# The shellspec suite runs twice by design. bash 5 is what most contributors have
# on PATH; /bin/bash is 3.2 on macOS and is what actually executes these scripts
# when the plugin runs, so a passing 5.x run alone proves little.
#
# Both shell passes run in parallel: shellspec --jobs spreads spec files across
# the cores, and the two shell passes run at the same time. Coverage is the
# exception, and serial; see CLAUDE.md, Tests.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# Run as CI does. Package managers change behaviour when CI is set: Yarn Berry
# turns on immutable installs, which forbids creating the lock file a fixture
# exists to write. Without this, that failure only appears after a push.
export CI="${CI:-true}"

fail=0
run() { printf '\n\033[1m== %s\033[0m\n' "$1"; shift; "$@" || fail=1; }

if command -v shellcheck >/dev/null 2>&1; then
  run "shellcheck" shellcheck -S warning \
    plugins/gh/scripts/lib/shepherd.sh \
    plugins/gh/scripts/gh-shepherd-status.sh \
    plugins/gh/scripts/gh-shepherd-pr.sh \
    plugins/gh/hooks/session-start.sh \
    fixtures/gh/fixtures.sh \
    fixtures/gh/bin/gh
else
  printf 'shellcheck not installed, skipping lint\n' >&2
fi

# uv runs the Python lint and the Python suite. Unlike shellcheck it is not
# optional, because part of the suite lives behind it. The coverage gate below is
# deliberately not run through uv: it is stdlib-only so that a broken dev
# environment cannot be what decides whether a build passes.
command -v uv >/dev/null 2>&1 || {
  printf 'uv is required: brew install uv\n' >&2
  exit 1
}

# --locked everywhere: drift between pyproject.toml and uv.lock fails here rather
# than being silently re-resolved into a set of versions CI never saw.
#
# ruff covers every .py in the repo, which is the plugin files shellcheck says
# nothing about plus the tests themselves.
run "ruff" uv run --locked ruff check .
run "ruff format" uv run --locked ruff format --check .

command -v shellspec >/dev/null 2>&1 || {
  printf 'shellspec is required: brew install shellspec\n' >&2
  exit 1
}

jobs="${SPEC_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || {
  printf 'SPEC_JOBS must be a positive integer, got: %s\n' "$jobs" >&2
  exit 2
}

if [[ "${1:-}" == "--coverage" ]]; then
  command -v kcov >/dev/null 2>&1 || {
    printf 'kcov is required for --coverage: brew install kcov\n' >&2
    exit 1
  }
  # kcov first: it owns the whole covdir, and coverage.py only adds a file to it.
  run "shellspec (kcov)" shellspec --kcov --covdir coverage \
    --kcov-options "--include-path=./plugins --path-strip-level=1"
  run "shell coverage threshold" python3 tests/coverage_check.py coverage/cobertura.xml 95
  run "pytest (coverage)" uv run --locked pytest --cov --cov-report=xml
  run "python coverage threshold" python3 tests/coverage_check.py coverage/python.xml 95
elif [[ "${1:-}" == "--quick" ]]; then
  # --quick is this script's flag, not shellspec's: forwarded, it would switch
  # shellspec into its own quick mode and leave .shellspec-quick.log in the
  # checkout, which every later run (both passes at once) would then share.
  shift
  run "pytest" uv run --locked pytest -n auto
  run "shellspec (default shell, --jobs $jobs)" shellspec --jobs "$jobs" "$@"
else
  # Both passes run as background jobs and the script waits on them, because
  # shellspec --jobs does not stop on Ctrl-C: in 0.28.1 the runner's INT handler
  # waits for a reporter that waits for an executor that waits for the workers
  # it just killed. SIGTERM does stop it, but only sent to its whole process
  # group at once. Job control gives each pass its own process group, so the
  # terminal's SIGINT reaches only this script, whose trap then TERMs the two
  # groups. The 3.2 pass writes to a file so the streaming bash 5 pass stays
  # readable; that file is printed whatever its status, so a 3.2 crash shows.
  # Half the jobs each, so the two passes together hold one worker per core:
  # the examples that poll on real seconds start missing their bounds when the
  # machine is oversubscribed, and measured wall time is the same either way.
  # pytest first, and on its own: it is the harness a Python change is most
  # likely to have broken. The whole suite, including the examples marked `slow`
  # that perform a real package-manager install; those are the ones the
  # pre-commit hook deselects, and CI runs them too.
  run "pytest" uv run --locked pytest -n auto
  jobs=$(( (jobs + 1) / 2 ))
  legacy_out="$(mktemp)" || { printf 'could not create a temp file for the /bin/bash pass\n' >&2; exit 1; }
  set -m
  shellspec --shell /bin/bash --jobs "$jobs" "$@" > "$legacy_out" 2>&1 &
  legacy_pid=$!
  printf '\n\033[1m== %s\033[0m\n' "shellspec (default shell, --jobs $jobs)"
  shellspec --jobs "$jobs" "$@" &
  main_pid=$!
  set +m
  cleanup() {
    kill -TERM -- -"$main_pid" -"$legacy_pid" 2>/dev/null && { sleep 0.5; kill -KILL -- -"$main_pid" -"$legacy_pid" 2>/dev/null; }
    rm -f "$legacy_out"
  }
  trap cleanup EXIT
  trap 'cleanup; trap - INT; kill -INT $$' INT
  trap 'cleanup; trap - TERM; kill -TERM $$' TERM
  wait "$main_pid" || fail=1
  printf '\n\033[1m== %s\033[0m\n' "shellspec (/bin/bash, the shell that ships on macOS, --jobs $jobs)"
  wait "$legacy_pid"; legacy_status=$?
  cat "$legacy_out"
  ((legacy_status)) && { printf '\n/bin/bash pass exited with status %d\n' "$legacy_status" >&2; fail=1; }
fi

((fail)) && { printf '\n\033[31mFAILED\033[0m\n'; exit 1; }
printf '\n\033[32mAll green\033[0m\n'
