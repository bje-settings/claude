# shellcheck shell=bash
# Every example runs the script through `When run script` so kcov traces it.
Describe 'ws-pr-status.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  Describe 'checks fold'
    Parameters
      10 pass    'successes and skips'
      11 fail    'one failure beside a success'
      12 pending 'an in-progress CheckRun and a pending StatusContext'
      13 none    'no checks at all'
      14 pass    'a StatusContext SUCCESS'
      15 fail    'a cancelled run'
      16 pass    'a neutral run beside a success'
      17 pending 'a completed CheckRun with no conclusion'
      18 fail    'a stale run that needs a rerun'
    End

    It "folds $3 to $2"
      When run script "$WS_PR_STATUS" "$1"
      The status should be success
      The output should include "\"checks\": \"$2\""
    End
  End

  fields() { "$WS_PR_STATUS" 10 | jq -c '[.number, .draft, .state, .base, .head, .headSha, .mergeable, .reviewDecision]'; }
  It 'reports the fields the run loop decides on'
    When run script "$WS_PR_STATUS" 10
    The status should be success
    The result of function fields should equal '[10,true,"OPEN","main","wktr-1-parser-fix","aaa111","MERGEABLE",""]'
  End

  m13() { "$WS_PR_STATUS" 13 | jq -c '[.mergeable, .reviewDecision, .draft]'; }
  It 'defaults a null mergeable to UNKNOWN and passes the review decision through'
    When run script "$WS_PR_STATUS" '#13'
    The status should be success
    The result of function m13 should equal '["UNKNOWN","APPROVED",false]'
  End

  It 'accepts a url'
    When run script "$WS_PR_STATUS" https://example.invalid/p/14
    The status should be success
    The output should include '"state": "MERGED"'
  End

  It 'fails when the pull request does not exist'
    When run script "$WS_PR_STATUS" 99
    The status should equal 1
    The stderr should include 'gh pr view failed for 99'
  End

  It 'requires exactly one argument'
    When run script "$WS_PR_STATUS" 10 11
    The status should equal 2
    The stderr should include 'exactly one pull request'
  End

  It 'requires an argument'
    When run script "$WS_PR_STATUS"
    The status should equal 2
    The stderr should include 'required'
  End

  It 'rejects unknown flags'
    When run script "$WS_PR_STATUS" --web
    The status should equal 2
    The stderr should include 'unknown flag'
  End

  It 'prints usage for --help'
    When run script "$WS_PR_STATUS" --help
    The status should be success
    The output should include 'checks folds the status rollup'
  End

  It 'requires jq'
    export PATH="$(ws_path_without jq)"
    When run script "$WS_PR_STATUS" 10
    The status should equal 1
    The stderr should include 'jq is required'
  End
End
