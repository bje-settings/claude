# shellcheck shell=bash
# Shared setup for the plugin specs. One section per plugin: gh and workstreams.
# Each brings its own fixtures and its own sandbox helpers. The field-test plugin
# is Python throughout; its tests and fixtures are under tests/field-test/.

ROOT="${SHELLSPEC_PROJECT_ROOT:-$PWD}"
PLUGIN_DIR="$ROOT/plugins/gh"
FIXTURES_DIR="$ROOT/fixtures/gh"
SYNC_REPO="$PLUGIN_DIR/scripts/gh-sync-repo.sh"
SYNC="$PLUGIN_DIR/scripts/gh-sync.sh"
HOOK="$PLUGIN_DIR/hooks/session-start.sh"
DISCOVER="$PLUGIN_DIR/scripts/lib/discover.sh"
SHEPHERD_STATUS="$PLUGIN_DIR/scripts/gh-shepherd-status.sh"
SHEPHERD_PR="$PLUGIN_DIR/scripts/gh-shepherd-pr.sh"
export ROOT PLUGIN_DIR FIXTURES_DIR SYNC_REPO SYNC HOOK DISCOVER SHEPHERD_STATUS SHEPHERD_PR

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


# --- workstreams plugin -------------------------------------------------------
WS_PLUGIN_DIR="$ROOT/plugins/workstreams"
WS_FIXTURES_DIR="$ROOT/fixtures/workstreams"
WS_PREFLIGHT="$WS_PLUGIN_DIR/scripts/ws-preflight.sh"
WS_ISSUES="$WS_PLUGIN_DIR/scripts/ws-issues.sh"
WS_STATE="$WS_PLUGIN_DIR/scripts/ws-state.sh"
WS_PR_STATUS="$WS_PLUGIN_DIR/scripts/ws-pr-status.sh"
export WS_PLUGIN_DIR WS_FIXTURES_DIR WS_PREFLIGHT WS_ISSUES WS_STATE WS_PR_STATUS

# shellcheck source=../fixtures/workstreams/fixtures.sh
. "$WS_FIXTURES_DIR/fixtures.sh"

# Every workstreams example gets a sandbox holding the canned gh data, an empty
# state dir, a fake HOME with the gh-stack skill and pr-review-toolkit present, and
# the workstreams gh stub ahead of any real gh on PATH. Specs flip individual
# pieces to build the negative cases.
setup_ws_sandbox() {
  WS_SANDBOX="$(mktemp -d)"
  export WS_SANDBOX
  export WS_GH_FIXTURE_DIR="$WS_SANDBOX/gh"
  export WS_STATE_DIR="$WS_SANDBOX/state"
  export HOME="$WS_SANDBOX/home"
  export WS_INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"
  unset WS_GH_FIXTURE_FAIL WS_GH_FIXTURE_NOAUTH WS_GH_FIXTURE_REPO WS_REPO WS_SKILLS_DIR CLAUDE_PLUGIN_DATA
  mkdir -p "$WS_GH_FIXTURE_DIR"
  ws_fixture_issues "$WS_GH_FIXTURE_DIR/issues.json"
  ws_fixture_prs "$WS_GH_FIXTURE_DIR/prs.json"
  ws_fixture_extensions "$WS_GH_FIXTURE_DIR/extensions.txt"
  ws_fixture_home "$HOME"
  ws_fixture_installed_plugins "$WS_INSTALLED_PLUGINS"
  export PATH="$WS_FIXTURES_DIR/bin:$PATH"
}

cleanup_ws_sandbox() {
  # Some examples make the state dir read-only; give it back before removing.
  [ -n "${WS_SANDBOX:-}" ] && { chmod -R u+w "$WS_SANDBOX" 2>/dev/null; rm -rf "$WS_SANDBOX"; }
  return 0
}

# ws_path_without <tool>...: a PATH holding the gh stub and the handful of tools
# the scripts call, minus the named ones, for the "tool is not installed" branches.
ws_path_without() {
  local dir="$WS_SANDBOX/bin-without" t real
  mkdir -p "$dir"
  for t in bash sh jq gh grep sed awk tr cat mkdir mv rm date find dirname basename env id chmod; do
    case " $* " in *" $t "*) continue ;; esac
    real="$(command -v "$t" 2>/dev/null)" || continue
    [ -e "$dir/$t" ] || ln -s "$real" "$dir/$t"
  done
  printf '%s' "$dir"
}
