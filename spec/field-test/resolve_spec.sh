# shellcheck shell=bash
Describe 'ft-resolve.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_RESOLVE" --help
      The status should be success
      The output should include 'ft-resolve.sh <target>'
    End

    It 'exits 2 with usage when given nothing'
      When run script "$FT_RESOLVE"
      The status should equal 2
      The stderr should include 'ft-resolve.sh <target>'
    End

    It 'rejects more than one target'
      When run script "$FT_RESOLVE" gh:sync gh:shepherd
      The status should equal 2
      The stderr should include 'expected one target'
    End

    It 'rejects a target that is not plugin:skill'
      When run script "$FT_RESOLVE" gh:shepherd:extra
      The status should equal 2
      The stderr should include 'must be plugin:skill'
    End
  End

  Describe 'workflow targets'
    It 'refuses a workflow target with exit 5 rather than guessing'
      When run script "$FT_RESOLVE" workflow:nightly-release
      The status should equal 5
      The stderr should include 'not supported yet'
    End

    It 'refuses it however it is capitalised'
      When run script "$FT_RESOLVE" Workflow:NightlyRelease
      The status should equal 5
      The stderr should include 'not supported yet'
    End
  End

  Describe 'a plugin skill'
    It 'resolves it through the installed plugin registry'
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"kind":"plugin-skill"'
      The output should include '"plugin":"gh"'
      The output should include '"skill":"shepherd"'
      The output should include '"version":"0.2.0"'
      The output should include "$FT_INSTALL_DIR/skills/shepherd/SKILL.md"
    End

    It 'names the marketplace the copy came from'
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"marketplace":"bje"'
    End

    It 'reports the commit and repo when the marketplace is a local checkout'
      ft_fixture_repo "$FT_PLUGIN_CHECKOUT" acme-org/plugins >/dev/null
      sha="$(ft_fixture_git "$FT_PLUGIN_CHECKOUT" rev-parse HEAD)"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include "\"commit\":\"$sha\""
      The output should include '"repo":"acme-org/plugins"'
    End

    It 'reads an https remote as well as an ssh one'
      ft_fixture_repo "$FT_PLUGIN_CHECKOUT" acme-org/plugins https >/dev/null
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"repo":"acme-org/plugins"'
    End

    It 'leaves the commit and repo null when the local marketplace path is gone'
      rm -rf "$FT_PLUGIN_CHECKOUT"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"commit":null'
      The output should include '"repo":null'
    End

    It 'leaves the commit and repo null when the marketplace came from github'
      ft_fixture_marketplaces "$FT_MARKETPLACES" "$FT_PLUGIN_CHECKOUT" github
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"marketplace_path":null'
      The output should include '"commit":null'
      The output should include '"repo":null'
    End

    It 'leaves them null when there is no marketplace file at all'
      rm -f "$FT_MARKETPLACES"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"commit":null'
    End

    It 'leaves the repo null when the local checkout has no origin'
      ft_fixture_repo "$FT_PLUGIN_CHECKOUT" acme-org/plugins none >/dev/null
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"repo":null'
    End

    It 'refuses a plugin that is not installed'
      When run script "$FT_RESOLVE" nosuch:skill
      The status should equal 3
      The stderr should include 'no installed plugin provides nosuch:skill'
    End

    It 'refuses a plugin that is installed without that skill'
      When run script "$FT_RESOLVE" gh:nosuch
      The status should equal 3
      The stderr should include 'no installed plugin provides gh:nosuch'
    End

    # A registry whose shape has changed is not a plugin that is not installed, and
    # "install it and try again" is advice that cannot fix it.
    It 'says the registry shape is wrong rather than blaming a missing plugin'
      printf '{"plugins": [{"name": "gh"}]}' > "$FT_INSTALLED_PLUGINS"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should equal 3
      The stderr should include 'its shape is not what this expects'
    End

    It 'refuses when the registry is missing'
      rm -f "$FT_INSTALLED_PLUGINS"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should equal 3
      The stderr should include 'no installed plugins file'
    End

    It 'refuses when the registry is not JSON'
      printf 'nope' > "$FT_INSTALLED_PLUGINS"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should equal 3
      The stderr should include 'not valid JSON'
    End

    It 'skips a copy that does not carry the skill and takes one that does'
      ft_fixture_installed_plugins "$FT_INSTALLED_PLUGINS" "$FT_INSTALL_DIR"
      jq --arg p "$FT_SANDBOX/stale" '.plugins["gh@bje"] = ([{scope: "user", installPath: $p, version: "0.1.0"}] + .plugins["gh@bje"])' \
        "$FT_INSTALLED_PLUGINS" > "$FT_SANDBOX/x" && mv "$FT_SANDBOX/x" "$FT_INSTALLED_PLUGINS"
      When run script "$FT_RESOLVE" gh:shepherd
      The status should be success
      The output should include '"version":"0.2.0"'
    End
  End

  Describe 'a command or skill by bare name'
    setup_project() {
      ft_fixture_repo "$FT_SANDBOX/project" acme-org/widgets >/dev/null
      cd "$FT_SANDBOX/project" || return 1
    }

    It 'finds a project command first'
      setup_project
      mkdir -p .claude/commands
      : > .claude/commands/tidy.md
      When run script "$FT_RESOLVE" tidy
      The status should be success
      The output should include '"kind":"command"'
      The output should include "$FT_SANDBOX/project/.claude/commands/tidy.md"
    End

    It 'falls back to a user command'
      setup_project
      mkdir -p "$FT_USER_DIR/commands"
      : > "$FT_USER_DIR/commands/tidy.md"
      When run script "$FT_RESOLVE" tidy
      The status should be success
      The output should include "$FT_USER_DIR/commands/tidy.md"
    End

    It 'falls back to a project skill'
      setup_project
      mkdir -p .claude/skills/tidy
      : > .claude/skills/tidy/SKILL.md
      When run script "$FT_RESOLVE" tidy
      The status should be success
      The output should include '"kind":"skill"'
      The output should include "$FT_SANDBOX/project/.claude/skills/tidy/SKILL.md"
    End

    It 'falls back to a user skill'
      setup_project
      mkdir -p "$FT_USER_DIR/skills/tidy"
      : > "$FT_USER_DIR/skills/tidy/SKILL.md"
      When run script "$FT_RESOLVE" tidy
      The status should be success
      The output should include "$FT_USER_DIR/skills/tidy/SKILL.md"
    End

    It 'refuses a name it cannot place, rather than guessing'
      setup_project
      When run script "$FT_RESOLVE" tidy
      The status should equal 3
      The stderr should include 'cannot resolve tidy'
    End
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_RESOLVE" gh:shepherd
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
