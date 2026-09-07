# shellcheck shell=bash
# Shared setup for the plugin specs. One section per plugin: gh, field-test.
# Each brings its own fixtures and its own sandbox helpers. workstreams has no
# section any more: its scripts are Python and its whole suite is pytest, under
# tests/workstreams/.

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


# --- field-test plugin --------------------------------------------------------
# The run side of this plugin is Python; its tests and fixtures are under
# tests/field-test/. What is left here is the harden side, which is still bash.
FT_PLUGIN_DIR="$ROOT/plugins/field-test"
FT_FIXTURES_DIR="$ROOT/fixtures/field-test"
FT_PREFLIGHT="$FT_PLUGIN_DIR/scripts/ft-preflight.sh"
FT_HARDEN_STATE="$FT_PLUGIN_DIR/scripts/ft-harden-state.sh"
FT_VERIFY_REPORT="$FT_PLUGIN_DIR/scripts/ft-verify-report.sh"
FT_WAIT_PR="$FT_PLUGIN_DIR/scripts/ft-wait-pr.sh"
export FT_PLUGIN_DIR FT_FIXTURES_DIR
export FT_PREFLIGHT FT_HARDEN_STATE FT_VERIFY_REPORT FT_WAIT_PR

# shellcheck source=../fixtures/field-test/fixtures.sh
. "$FT_FIXTURES_DIR/fixtures.sh"

# Every field-test example gets its own sandbox: an empty state dir, a fake HOME
# holding Claude's plugin registry, the canned pull requests, and the field-test
# gh stub ahead of any real gh. Specs replace individual pieces to build the
# negative cases.
setup_ft_sandbox() {
  FT_SANDBOX="$(mktemp -d)"
  export FT_SANDBOX
  export FT_STATE_DIR="$FT_SANDBOX/state"
  export HOME="$FT_SANDBOX/home"
  export FT_GH_FIXTURE_DIR="$FT_SANDBOX/gh"
  export FT_INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"
  export FT_INSTALL_DIR="$FT_SANDBOX/installed/gh"
  unset FT_GH_FIXTURE_FAIL CLAUDE_PLUGIN_DATA FT_GH
  mkdir -p "$FT_GH_FIXTURE_DIR" "$HOME/.claude/plugins" "$FT_STATE_DIR"
  ft_fixture_prs "$FT_GH_FIXTURE_DIR/prs.json"
  ft_fixture_installed_plugins "$FT_INSTALLED_PLUGINS" "$FT_INSTALL_DIR"
  export PATH="$FT_FIXTURES_DIR/bin:$PATH"
}

cleanup_ft_sandbox() {
  [ -n "${FT_SANDBOX:-}" ] && { chmod -R u+w "$FT_SANDBOX" 2>/dev/null; rm -rf "$FT_SANDBOX"; }
  return 0
}

# ft_path_without <tool>...: a PATH holding the field-test gh stub and the handful
# of tools the scripts call, minus the named ones, for the "tool is not installed"
# branches.
ft_path_without() {
  local dir="$FT_SANDBOX/bin-without" t real
  mkdir -p "$dir"
  for t in bash sh jq git grep sed awk tr cat cut head mkdir mv rm date find dirname basename env id chmod python3; do
    case " $* " in *" $t "*) continue ;; esac
    real="$(command -v "$t" 2>/dev/null)" || continue
    [ -e "$dir/$t" ] || ln -s "$real" "$dir/$t"
  done
  case " $* " in
    *" gh "*) : ;;
    *) [ -e "$dir/gh" ] || ln -s "$FT_FIXTURES_DIR/bin/gh" "$dir/gh" ;;
  esac
  printf '%s' "$dir"
}
