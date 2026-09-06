# shellcheck shell=bash
Describe 'ft-preflight.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  with_plugins() {
    jq --arg p "$FT_INSTALL_DIR" '.plugins["workstreams@bje"] = [{scope: "user", installPath: $p, version: "0.1.0"}]' \
      "$FT_INSTALLED_PLUGINS" > "$FT_SANDBOX/x" && mv "$FT_SANDBOX/x" "$FT_INSTALLED_PLUGINS"
  }

  It 'passes when everything is installed'
    with_plugins
    When run script "$FT_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
    The output should include '"missing": []'
  End

  It 'prints usage for --help'
    When run script "$FT_PREFLIGHT" --help
    The status should be success
    The output should include 'Usage:'
  End

  It 'rejects stray arguments'
    When run script "$FT_PREFLIGHT" --verbose
    The status should equal 2
    The stderr should include 'unexpected argument'
  End

  It 'reports the workstreams plugin, which harden dispatches its worker from'
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "workstreams"'
    The output should include '/plugin install workstreams@bje'
  End

  It 'reports pr-review-toolkit, which the review pass runs'
    with_plugins
    jq 'del(.plugins["pr-review-toolkit@official"])' "$FT_INSTALLED_PLUGINS" > "$FT_SANDBOX/x"
    mv "$FT_SANDBOX/x" "$FT_INSTALLED_PLUGINS"
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "pr-review-toolkit"'
  End

  It 'reports both plugins when there is no registry at all'
    rm -f "$FT_INSTALLED_PLUGINS"
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "workstreams"'
    The output should include '"id": "pr-review-toolkit"'
  End

  It 'reports an unreadable registry as itself, not as two missing plugins'
    printf 'nope' > "$FT_INSTALLED_PLUGINS"
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "registry-unreadable"'
    The output should not include '"id": "workstreams"'
  End

  It 'reports a failed gh login check with the login command and what gh said'
    with_plugins
    export FT_GH_FIXTURE_FAIL=1
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh-auth"'
    The output should include '"hint": "gh auth login"'
    The output should include '"detail": "gh: simulated failure"'
  End

  It 'reports a registry whose plugins is not an object as unreadable, not as two missing plugins'
    printf '{"version": 2, "plugins": []}' > "$FT_INSTALLED_PLUGINS"
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "registry-unreadable"'
    The output should include 'no plugins object'
    The output should not include '"id": "workstreams"'
  End

  It 'accepts workstreams installed from another marketplace'
    jq --arg p "$FT_INSTALL_DIR" '.plugins["workstreams@fork"] = [{scope: "user", installPath: $p, version: "0.1.0"}]' \
      "$FT_INSTALLED_PLUGINS" > "$FT_SANDBOX/x" && mv "$FT_SANDBOX/x" "$FT_INSTALLED_PLUGINS"
    When run script "$FT_PREFLIGHT"
    The status should be success
    The output should include '"ok": true'
  End

  It 'reports gh itself when it is not installed'
    with_plugins
    export PATH="$(ft_path_without gh)"
    When run script "$FT_PREFLIGHT"
    The status should equal 1
    The output should include '"id": "gh"'
    The output should include 'brew install gh'
  End

  It 'exits 4 in plain text when jq is missing, since no JSON can be built'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_PREFLIGHT"
    The status should equal 4
    The stderr should include 'jq is required'
  End
End
