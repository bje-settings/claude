# shellcheck shell=bash
# Shared setup for the gh plugin specs.

ROOT="${SHELLSPEC_PROJECT_ROOT:-$PWD}"
PLUGIN_DIR="$ROOT/plugins/gh"
FIXTURES_DIR="$ROOT/fixtures/gh"
SYNC_REPO="$PLUGIN_DIR/scripts/gh-sync-repo.sh"
SYNC="$PLUGIN_DIR/scripts/gh-sync.sh"
HOOK="$PLUGIN_DIR/hooks/session-start.sh"
DISCOVER="$PLUGIN_DIR/scripts/lib/discover.sh"
export ROOT PLUGIN_DIR FIXTURES_DIR SYNC_REPO SYNC HOOK DISCOVER

# shellcheck source=../fixtures/gh/fixtures.sh
. "$FIXTURES_DIR/fixtures.sh"

# Every example gets its own sandbox, its own canned pull-request set, and the
# stub gh ahead of any real one on PATH.
setup_sandbox() {
  SANDBOX="$(mktemp -d)"
  export SANDBOX
  export GH_FIXTURE_PRS="$SANDBOX/prs.json"
  unset GH_FIXTURE_FAIL
  fixture_no_prs "$GH_FIXTURE_PRS"
  export PATH="$FIXTURES_DIR/bin:$PATH"
  REPO="$(fixture_create "$SANDBOX/r")"
  export REPO
}

cleanup_sandbox() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  return 0
}

# Convenience assertions used across specs.
branches() { fixture_git "$1" for-each-ref --format='%(refname:short)' refs/heads/ | tr '\n' ' '; }
head_sha()  { fixture_git "$1" rev-parse HEAD; }
current_branch() { fixture_git "$1" rev-parse --abbrev-ref HEAD; }

