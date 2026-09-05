# shellcheck shell=bash
Describe 'ws-issues.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  numbers() { "$WS_ISSUES" "$@" | jq -c 'map(.number)'; }

  Describe 'selectors'
    It 'resolves plain numbers and #numbers'
      When call numbers 2 '#1'
      The output should equal '[1,2]'
    End

    It 'expands an inclusive range'
      When call numbers 1-3
      The output should equal '[1,2,3]'
    End

    It 'resolves label: to open issues with that label'
      When call numbers label:bug
      The output should equal '[1]'
    End

    It 'resolves milestone: to open issues in that milestone'
      When call numbers milestone:observe
      The output should equal '[4]'
    End

    It 'joins everything else into one search query'
      When call numbers pin the linter
      The output should equal '[2]'
    End

    It 'merges selectors and removes duplicates'
      When call numbers 1 label:bug 1-2
      The output should equal '[1,2]'
    End

    It 'rejects a range that runs backwards'
      When run script "$WS_ISSUES" 3-1
      The status should equal 2
      The stderr should include 'bad range'
    End

    It 'rejects an empty label value'
      When run script "$WS_ISSUES" label:
      The status should equal 2
      The stderr should include 'empty value'
    End

    It 'needs at least one selector'
      When run script "$WS_ISSUES"
      The status should equal 2
      The stderr should include 'at least one selector'
    End

    It 'prints usage for --help'
      When run script "$WS_ISSUES" --help
      The status should be success
      The output should include 'Selectors, in any mix'
    End
  End

  Describe 'output shape'
    labels_and_body() { "$WS_ISSUES" 1 2 | jq -c '[.[0].labels, .[1].body, .[1].labels]'; }
    It 'projects labels to names and normalises a null body'
      When run script "$WS_ISSUES" 1 2
      The status should be success
      The result of function labels_and_body should equal '[["bug"],"",["chore"]]'
    End

    refs() { "$WS_ISSUES" "$@" | jq -c 'map(.refs)'; }
    It 'extracts #N references from the body, excluding the issue itself'
      When call refs 1 3
      The output should equal '[[2,4],[1]]'
    End

    It 'does not treat a #N inside a url as a reference'
      When call refs 6
      The output should equal '[[]]'
    End

    state() { "$WS_ISSUES" "$@" | jq -c 'map(.state)'; }
    It 'includes a closed issue when asked for it by number'
      When call state 5
      The output should equal '["CLOSED"]'
    End
  End

  Describe 'failure handling'
    It 'exits 3 with an empty array when nothing matched'
      When run script "$WS_ISSUES" label:nothing-here
      The status should equal 3
      The output should equal '[]'
      The stderr should include 'no issues matched'
    End

    It 'fails when a number does not resolve'
      When run script "$WS_ISSUES" 99
      The status should equal 1
      The stderr should include 'gh issue view failed for #99'
    End

    It 'fails when gh issue list fails for a label'
      export WS_GH_FIXTURE_FAIL=1
      When run script "$WS_ISSUES" label:bug
      The status should equal 1
      The stderr should include 'gh issue list failed for label:bug'
    End

    It 'fails when gh issue list fails for a search'
      export WS_GH_FIXTURE_FAIL=1
      When run script "$WS_ISSUES" parser
      The status should equal 1
      The stderr should include 'failed for search: parser'
    End
  End
End
