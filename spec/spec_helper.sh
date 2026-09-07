# shellcheck shell=bash
# Shared setup for the plugin specs. One section remains, field-test: it brings its
# own fixtures and its own sandbox helpers. gh and workstreams have no section any
# more; their scripts are Python and their suites are pytest, under tests/gh/ and
# tests/workstreams/.

ROOT="${SHELLSPEC_PROJECT_ROOT:-$PWD}"
export ROOT

# --- field-test plugin --------------------------------------------------------
FT_PLUGIN_DIR="$ROOT/plugins/field-test"
FT_FIXTURES_DIR="$ROOT/fixtures/field-test"
FT_RUN="$FT_PLUGIN_DIR/scripts/ft-run.sh"
FT_RESOLVE="$FT_PLUGIN_DIR/scripts/ft-resolve.sh"
FT_COLLECT="$FT_PLUGIN_DIR/scripts/ft-collect.sh"
FT_ENTERPRISE="$FT_PLUGIN_DIR/scripts/ft-enterprise.sh"
FT_REDACT="$FT_PLUGIN_DIR/scripts/ft-redact.sh"
FT_ISSUE="$FT_PLUGIN_DIR/scripts/ft-issue.sh"
FT_PREFLIGHT="$FT_PLUGIN_DIR/scripts/ft-preflight.sh"
FT_HARDEN_STATE="$FT_PLUGIN_DIR/scripts/ft-harden-state.sh"
FT_VERIFY_REPORT="$FT_PLUGIN_DIR/scripts/ft-verify-report.sh"
FT_WAIT_PR="$FT_PLUGIN_DIR/scripts/ft-wait-pr.sh"
FT_HOOK="$FT_PLUGIN_DIR/hooks/ft-hook.sh"
FT_HOOK_IO="$FT_PLUGIN_DIR/hooks/hook-io.py"
FT_DENY_LIST_FILE="$FT_PLUGIN_DIR/hooks/deny-list.txt"
export FT_PLUGIN_DIR FT_FIXTURES_DIR FT_RUN FT_RESOLVE FT_COLLECT FT_ENTERPRISE
export FT_REDACT FT_ISSUE FT_HOOK FT_HOOK_IO FT_DENY_LIST_FILE
export FT_PREFLIGHT FT_HARDEN_STATE FT_VERIFY_REPORT FT_WAIT_PR

# shellcheck source=../fixtures/field-test/fixtures.sh
. "$FT_FIXTURES_DIR/fixtures.sh"

# Every field-test example gets its own sandbox: an empty state dir with a live run
# marker for session ft-session, a fake HOME holding Claude's plugin registry, the
# canned enterprise answer, and the field-test gh stub ahead of any real gh. Specs
# replace individual pieces to build the negative cases.
setup_ft_sandbox() {
  FT_SANDBOX="$(mktemp -d)"
  export FT_SANDBOX
  export FT_STATE_DIR="$FT_SANDBOX/state"
  export HOME="$FT_SANDBOX/home"
  export FT_GH_FIXTURE_DIR="$FT_SANDBOX/gh"
  export FT_INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"
  export FT_MARKETPLACES="$HOME/.claude/plugins/known_marketplaces.json"
  export FT_USER_DIR="$HOME/.claude"
  export CLAUDE_CODE_SESSION_ID="ft-session"
  export FT_RUN_DIR="$FT_STATE_DIR/runs/ft-session"
  export FT_PLUGIN_CHECKOUT="$FT_SANDBOX/plugin-repo"
  export FT_INSTALL_DIR="$FT_SANDBOX/installed/gh"
  unset FT_GH_FIXTURE_FAIL CLAUDE_PLUGIN_DATA FT_GH FT_DENY_LIST
  mkdir -p "$FT_GH_FIXTURE_DIR" "$HOME/.claude/plugins" "$FT_RUN_DIR"
  ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" both
  ft_fixture_issues "$FT_GH_FIXTURE_DIR/issues.json"
  ft_fixture_prs "$FT_GH_FIXTURE_DIR/prs.json"
  ft_fixture_installed_plugins "$FT_INSTALLED_PLUGINS" "$FT_INSTALL_DIR"
  ft_fixture_marketplaces "$FT_MARKETPLACES" "$FT_PLUGIN_CHECKOUT"
  ft_fixture_run "$FT_RUN_DIR/run.json"
  : > "$FT_RUN_DIR/events.jsonl"
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
