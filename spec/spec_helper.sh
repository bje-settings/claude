# shellcheck shell=bash
# Shared setup for the plugin specs. Nothing is left in it: every plugin's
# scripts are Python now, and every suite is pytest, under tests/<plugin>/.
# Issue #61 deletes this file together with the rest of the shell harness.

ROOT="${SHELLSPEC_PROJECT_ROOT:-$PWD}"
export ROOT
