# shellcheck shell=bash
# Shared setup for the plugin specs. No section remains: every plugin is Python
# throughout and its tests and fixtures are under tests/<plugin>/. The harness
# itself is retired by issue #61.

ROOT="${SHELLSPEC_PROJECT_ROOT:-$PWD}"
export ROOT
