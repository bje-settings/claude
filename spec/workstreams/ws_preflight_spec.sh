# shellcheck shell=bash
Describe 'ws-preflight.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  ids() { "$WS_PREFLIGHT" | jq -r '[.missing[].id] | join(" ")'; }

  It 'passes when everything is installed'
    When run script "$WS_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
    The output should include '"missing": []'
  End

  It 'prints usage for --help'
    When run script "$WS_PREFLIGHT" --help
    The status should be success
    The output should include 'Usage:'
  End

  It 'rejects stray arguments'
    When run script "$WS_PREFLIGHT" --verbose
    The status should equal 2
    The stderr should include 'unexpected argument'
  End

  It 'reports a missing gh login with the login command'
    export WS_GH_FIXTURE_NOAUTH=1
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh-auth"'
    The output should include '"hint": "gh auth login"'
  End

  It 'reports the gh-stack extension when gh does not list it, exactly by repo'
    ws_fixture_extensions "$WS_GH_FIXTURE_DIR/extensions.txt" without-stack
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh-stack-extension"'
    The output should include 'gh extension install github/gh-stack'
  End

  It 'reports a broken gh apart from a missing extension, keeping the error'
    export WS_GH_FIXTURE_FAIL=1
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh-broken"'
    The output should include 'gh extension list failed: gh: simulated failure'
    The output should not include 'gh-stack-extension'
  End

  It 'reports the gh-stack skill when neither the user nor the repo has it'
    rm -rf "$HOME/.claude/skills/gh-stack"
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh-stack-skill"'
    The output should include 'gh skill install github/gh-stack'
  End

  It 'accepts a repo-local gh-stack skill from any directory in the repo'
    rm -rf "$HOME/.claude/skills/gh-stack"
    mkdir -p "$WS_SANDBOX/repo/.claude/skills/gh-stack" "$WS_SANDBOX/repo/deep/er"
    : > "$WS_SANDBOX/repo/.claude/skills/gh-stack/SKILL.md"
    git init -q "$WS_SANDBOX/repo"
    cd "$WS_SANDBOX/repo/deep/er" || return 1
    When run script "$WS_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
  End

  It 'accepts a gh-stack skill delivered by an installed plugin'
    rm -rf "$HOME/.claude/skills/gh-stack"
    jq '.plugins["gh-stack@some-marketplace"] = [{"scope": "user"}]' "$WS_INSTALLED_PLUGINS" > "$WS_INSTALLED_PLUGINS.new"
    mv "$WS_INSTALLED_PLUGINS.new" "$WS_INSTALLED_PLUGINS"
    When run script "$WS_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
  End

  It 'honours WS_SKILLS_DIR'
    rm -rf "$HOME/.claude/skills/gh-stack"
    mkdir -p "$WS_SANDBOX/elsewhere/gh-stack"
    : > "$WS_SANDBOX/elsewhere/gh-stack/SKILL.md"
    export WS_SKILLS_DIR="$WS_SANDBOX/elsewhere"
    When run script "$WS_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
  End

  It 'reports pr-review-toolkit when the plugin list lacks it'
    ws_fixture_installed_plugins "$WS_INSTALLED_PLUGINS" without-review
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "pr-review-toolkit"'
    The output should include '/plugin install pr-review-toolkit@claude-plugins-official'
  End

  It 'reports pr-review-toolkit when the plugin list does not exist'
    rm "$WS_INSTALLED_PLUGINS"
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "pr-review-toolkit"'
  End

  It 'says the plugin list is corrupt rather than telling the user to install again'
    printf '{bad' > "$WS_INSTALLED_PLUGINS"
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include 'installed plugins file is not valid JSON'
    The output should not include '/plugin install'
  End

  It 'lists every missing item at once, in check order'
    export WS_GH_FIXTURE_NOAUTH=1
    ws_fixture_extensions "$WS_GH_FIXTURE_DIR/extensions.txt" without-stack
    rm -rf "$HOME/.claude/skills/gh-stack"
    ws_fixture_installed_plugins "$WS_INSTALLED_PLUGINS" without-review
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The result of function ids should equal 'gh-auth gh-stack-extension gh-stack-skill pr-review-toolkit'
  End

  It 'reports gh itself when it is not on PATH, and skips the checks that need it'
    export PATH="$(ws_path_without gh)"
    When run script "$WS_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh"'
    The output should include 'brew install gh'
    The output should not include 'gh-auth'
    The output should not include 'gh-stack-extension'
  End

  It 'exits 4 in plain text when jq is missing, since it cannot build JSON'
    export PATH="$(ws_path_without jq)"
    When run script "$WS_PREFLIGHT"
    The status should equal 4
    The stderr should include 'jq is required'
    The output should equal ''
  End
End
