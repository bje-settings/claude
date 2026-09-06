# shellcheck shell=bash
# The answer here decides whether a repository's name is published, so every arm
# that can produce `inside: false` gets its own example: an outright failure, a
# token without the scope, a missing remote, and a genuine no.
Describe 'ft-enterprise.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  plugin_repo() { ft_fixture_repo "$FT_SANDBOX/plugin" "acme-org/plugins" "${1:-ssh}" >/dev/null; }
  target_repo() { ft_fixture_repo "$FT_SANDBOX/target" "${1:-acme-tools/widgets}" "${2:-ssh}" >/dev/null; }

  It 'prints usage for --help'
    When run script "$FT_ENTERPRISE" --help
    The status should be success
    The output should include 'ft-enterprise.sh <plugin-repo-dir>'
  End

  It 'needs both directories'
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX"
    The status should equal 2
    The stderr should include 'expected <plugin-repo-dir> <target-repo-dir>'
  End

  It 'says inside when both owners are organizations in one enterprise'
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":true'
    The output should include '"enterprise":"acme"'
    The output should include 'both organizations in the acme enterprise'
  End

  It 'reads https remotes as well as ssh ones'
    plugin_repo https; target_repo acme-tools/widgets https
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":true'
  End

  It 'follows a second page of organizations rather than answering from the first'
    ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" paged
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":true'
  End

  It 'keeps looking past an enterprise that holds only one of the owners'
    ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" second
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":true'
    The output should include '"enterprise":"acme"'
  End

  It 'says outside when the target owner is in no enterprise of yours'
    plugin_repo; target_repo someone-else/thing
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
    The output should include '"enterprise":null'
    The output should include 'not both organizations'
  End

  It 'says outside when the enterprise holds only one of the two owners'
    ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" neither
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
  End

  It 'fails closed when gh fails, and keeps the error'
    ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" error
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
    The output should include 'could not read the enterprise list'
    The output should include 'required scopes'
  End

  It 'fails closed when the query answers without an enterprises node'
    ft_fixture_enterprise "$FT_GH_FIXTURE_DIR" empty
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
    The output should include 'read:enterprise'
  End

  It 'fails closed when the plugin checkout has no github remote'
    plugin_repo none; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
    The output should include 'no github origin remote in the plugin checkout'
  End

  It 'fails closed when the repository under test has no github remote'
    plugin_repo; target_repo acme-tools/widgets none
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"inside":false'
    The output should include 'no github origin remote in the repository under test'
  End

  It 'reports both owners so the reason can be read without the repositories'
    plugin_repo; target_repo
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX/plugin" "$FT_SANDBOX/target"
    The status should be success
    The output should include '"plugin_owner":"acme-org"'
    The output should include '"target_owner":"acme-tools"'
  End
  It 'requires jq'
    export PATH="$(ft_path_without jq)"
    When run script "$FT_ENTERPRISE" "$FT_SANDBOX" "$FT_SANDBOX"
    The status should equal 1
    The stderr should include 'jq is required'
  End

End
