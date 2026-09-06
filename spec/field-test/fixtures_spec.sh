# shellcheck shell=bash
# The other specs in this directory read claims off these fixtures: which check
# verdict every fixture pull request folds to, what the gh stub refuses to answer,
# which claims each report case makes. Asserting those claims here is what stops
# the rest of the suite passing for the wrong reason.
#
# Only the harden side is left here. The run side of the plugin is Python and its
# fixtures are asserted in tests/field-test/test_fixtures.py.
Describe 'field-test fixtures'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  Describe 'the gh stub'
    It 'refuses a flag it does not emulate, so a spec cannot pass on a fake answer'
      When run command gh pr view 50 --repo acme-org/plugins --author someone
      The status should equal 64
      The stderr should include 'unhandled flag'
    End

    It 'refuses a subcommand it does not emulate'
      When run command gh pr merge 11
      The status should equal 1
      The stderr should include 'unsupported'
    End

    It 'refuses an unknown --json field the way gh does'
      When run command gh pr view 50 --repo acme-org/plugins --json nosuchfield
      The status should equal 1
      The stderr should include 'Unknown JSON field'
    End

    It 'answers gh auth status, which the preflight reads'
      When run command gh auth status
      The status should be success
      The output should include 'Logged in'
    End

    It 'fails every call when told to'
      export FT_GH_FIXTURE_FAIL=1
      When run command gh auth status
      The status should equal 1
      The stderr should include 'simulated failure'
    End
  End

  Describe 'ft_fixture_installed_plugins'
    It 'names the plugin the preflight requires and one it does not'
      keys() { jq -r '.plugins | keys | join(",")' "$FT_INSTALLED_PLUGINS"; }
      When call keys
      The status should be success
      The output should equal 'gh@bje,pr-review-toolkit@official'
    End
  End

  Describe 'ft_fixture_prs and ft_fixture_report'
    It 'covers every check verdict the wait script can reach'
      verdicts() {
        local n
        for n in 50 51 52 53 56 57 59 60; do
          gh pr view "$n" --repo acme-org/plugins --json state,isDraft,statusCheckRollup \
            | jq -r -f "$FT_PLUGIN_DIR/scripts/lib/checks.jq" \
            | jq -r '.checks'
        done | tr '\n' ' '
      }
      When call verdicts
      The status should be success
      The output should equal 'pass fail pending none pending fail fail fail '
    End

    It 'has one merged and one closed pull request for the state arms'
      states() {
        gh pr view 54 --repo acme-org/plugins --json state --jq .state
        gh pr view 55 --repo acme-org/plugins --json state --jq .state
      }
      When call states
      The status should be success
      The output should equal 'MERGED
CLOSED'
    End

    It 'moves a sequenced pull request from in progress to complete across calls, and stays there'
      poll() {
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
        gh pr view 58 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup[0].status'
      }
      When call poll
      The status should be success
      The output should equal 'IN_PROGRESS
COMPLETED
COMPLETED'
    End

    It 'has a pull request with no checks on the first look and a run on the next'
      poll() {
        gh pr view 61 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup | length'
        gh pr view 61 --repo acme-org/plugins --json statusCheckRollup --jq '.statusCheckRollup | length'
      }
      When call poll
      The status should be success
      The output should equal '0
1'
    End

    It 'refuses a pull request it does not have, the way gh does'
      When run command gh pr view 999 --repo acme-org/plugins --json state
      The status should equal 1
      The stderr should include 'Could not resolve to a PullRequest'
    End

    It 'writes an accurate report whose every claim holds'
      claims() { ft_fixture_report "$FT_SANDBOX/r.json" accurate; jq -r '[.prs[] | .claimed] | join(",")' "$FT_SANDBOX/r.json"; }
      When call claims
      The status should be success
      The output should equal 'merged,skipped,closed'
    End

    It 'refuses a report case it does not have'
      When call ft_fixture_report "$FT_SANDBOX/r.json" nosuchcase
      The status should equal 1
      The stderr should include 'unknown case'
    End
  End

End
