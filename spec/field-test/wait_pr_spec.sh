# shellcheck shell=bash
# One example per arm of scripts/lib/checks.jq, plus the loop around it. A wrong
# arm here is a loop that waits forever on a run that already ended, or merges on
# an answer that never arrived.
Describe 'ft-wait-pr.sh'
  BeforeEach 'setup_ft_sandbox'
  AfterEach 'cleanup_ft_sandbox'

  Describe 'usage'
    It 'prints usage for --help'
      When run script "$FT_WAIT_PR" --help
      The status should be success
      The output should include 'ft-wait-pr.sh <repo> <pr>'
    End

    It 'exits 2 with usage when given nothing'
      When run script "$FT_WAIT_PR"
      The status should equal 2
      The stderr should include 'ft-wait-pr.sh <repo> <pr>'
    End

    It 'rejects a repository that is not owner/name'
      When run script "$FT_WAIT_PR" plugins 50
      The status should equal 2
      The stderr should include 'owner/name'
    End

    It 'rejects a pull request that is not a number'
      When run script "$FT_WAIT_PR" acme-org/plugins fifty
      The status should equal 2
      The stderr should include 'must be a number'
    End

    It 'rejects an unknown argument'
      When run script "$FT_WAIT_PR" acme-org/plugins 50 --forever
      The status should equal 2
      The stderr should include 'unknown argument'
    End

    It 'rejects a timeout that is not a number'
      When run script "$FT_WAIT_PR" acme-org/plugins 50 --timeout soon
      The status should equal 2
      The stderr should include '--timeout needs a number'
    End

    It 'refuses an interval of zero, which would spin without ever timing out'
      When run script "$FT_WAIT_PR" acme-org/plugins 50 --interval 0
      The status should equal 2
      The stderr should include 'from 1'
    End

    It 'requires jq'
      export PATH="$(ft_path_without jq)"
      When run script "$FT_WAIT_PR" acme-org/plugins 50
      The status should equal 1
      The stderr should include 'jq is required'
    End
  End

  Describe 'the answer'
    It 'says merged for a merged pull request, without waiting'
      When run script "$FT_WAIT_PR" acme-org/plugins 54 --timeout 1 --interval 1
      The status should be success
      The output should equal 'merged'
    End

    It 'says failed for a pull request closed without merging'
      When run script "$FT_WAIT_PR" acme-org/plugins 55 --timeout 1 --interval 1
      The status should equal 1
      The output should equal 'failed'
    End

    It 'says passed when every check is green or skipped'
      When run script "$FT_WAIT_PR" acme-org/plugins 50 --timeout 1 --interval 1
      The status should be success
      The output should equal 'passed'
    End

    It 'says failed on a failing check'
      When run script "$FT_WAIT_PR" acme-org/plugins 51 --timeout 1 --interval 1
      The status should equal 1
      The output should equal 'failed'
    End

    It 'says failed on a cancelled run rather than waiting for it forever'
      When run script "$FT_WAIT_PR" acme-org/plugins 57 --timeout 1 --interval 1
      The status should equal 1
      The output should equal 'failed'
    End

    It 'gives up with pending when the checks are still running'
      When run script "$FT_WAIT_PR" acme-org/plugins 52 --timeout 1 --interval 1
      The status should equal 3
      The output should equal 'pending'
    End

    It 'treats a completed run with no conclusion as pending, not as a pass'
      When run script "$FT_WAIT_PR" acme-org/plugins 56 --timeout 1 --interval 1
      The status should equal 3
      The output should equal 'pending'
    End

    It 'says passed for a pull request with no checks, once it has looked twice'
      When run script "$FT_WAIT_PR" acme-org/plugins 53 --timeout 5 --interval 1
      The status should be success
      The output should equal 'passed'
    End

    It 'keeps polling until a run that was in progress goes green'
      When run script "$FT_WAIT_PR" acme-org/plugins 58 --timeout 5 --interval 1
      The status should be success
      The output should equal 'passed'
    End
  End

  Describe 'when gh cannot answer'
    It 'exits 4 with the error rather than reporting a state it does not have'
      When run script "$FT_WAIT_PR" acme-org/plugins 999 --timeout 1 --interval 1
      The status should equal 4
      The stderr should include 'cannot read pull request 999'
      The stderr should include 'Could not resolve to a PullRequest'
    End

    It 'exits 4 when gh answers with something unreadable'
      export FT_GH_FIXTURE_FAIL=1
      When run script "$FT_WAIT_PR" acme-org/plugins 50 --timeout 1 --interval 1
      The status should equal 4
      The stderr should include 'simulated failure'
    End
  End
End
