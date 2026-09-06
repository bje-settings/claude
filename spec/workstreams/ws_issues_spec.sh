# shellcheck shell=bash
# Every example runs the script through `When run script` so kcov traces it; the
# reader functions re-run it only to parse the JSON.
Describe 'ws-issues.sh'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  numbers() { "$WS_ISSUES" "$@" 2>/dev/null | jq -c 'map(.number)'; }

  Describe 'selectors'
    n1() { numbers 2 '#1'; }
    It 'resolves plain numbers and #numbers'
      When run script "$WS_ISSUES" 2 '#1'
      The status should be success
      The result of function n1 should equal '[1,2]'
    End

    n2() { numbers 1-3; }
    It 'expands an inclusive range'
      When run script "$WS_ISSUES" 1-3
      The status should be success
      The result of function n2 should equal '[1,2,3]'
    End

    n3() { numbers label:bug; }
    It 'resolves label: to open issues with that label'
      When run script "$WS_ISSUES" label:bug
      The status should be success
      The result of function n3 should equal '[1]'
    End

    n4() { numbers milestone:observe; }
    It 'resolves milestone: to open issues in that milestone'
      When run script "$WS_ISSUES" milestone:observe
      The status should be success
      The result of function n4 should equal '[4]'
    End

    n5() { numbers pin the linter; }
    It 'joins everything else into one search query and says so'
      When run script "$WS_ISSUES" pin the linter
      The status should be success
      The stderr should include 'treating as search text: pin'
      The stderr should include 'treating as search text: linter'
      The result of function n5 should equal '[2]'
    End

    n6() { numbers 1 label:bug 1-2; }
    It 'merges selectors and removes duplicates'
      When run script "$WS_ISSUES" 1 label:bug 1-2
      The status should be success
      The result of function n6 should equal '[1,2]'
    End

    It 'rejects a range that runs backwards'
      When run script "$WS_ISSUES" 3-1
      The status should equal 2
      The stderr should include 'bad range'
    End

    It 'rejects a selector that starts like a number but is not one'
      When run script "$WS_ISSUES" 1,3
      The status should equal 2
      The stderr should include 'not a number, range, label:, or milestone: selector: 1,3'
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

    refs13() { "$WS_ISSUES" 1 3 | jq -c 'map(.refs)'; }
    It 'extracts #N references from the body once each, excluding the issue itself'
      When run script "$WS_ISSUES" 1 3
      The status should be success
      The result of function refs13 should equal '[[2,4],[1]]'
    End

    refs6() { "$WS_ISSUES" 6 | jq -c 'map(.refs)'; }
    It 'does not treat a #N inside a url as a reference'
      When run script "$WS_ISSUES" 6
      The status should be success
      The result of function refs6 should equal '[[]]'
    End

    It 'includes a closed issue when asked for it by number'
      When run script "$WS_ISSUES" 5
      The status should be success
      The output should include '"state": "CLOSED"'
    End
  End

  Describe 'failure handling'
    It 'exits 3 with an empty array, naming the selectors, when nothing matched'
      When run script "$WS_ISSUES" label:nothing-here
      The status should equal 3
      The output should equal '[]'
      The stderr should include 'no issues matched: label:nothing-here'
    End

    It 'fails when a number does not resolve'
      When run script "$WS_ISSUES" 99
      The status should equal 1
      The stderr should include 'gh issue view failed for #99'
    End

    It 'refuses a number that is a pull request'
      When run script "$WS_ISSUES" 7
      The status should equal 1
      The stderr should include '#7 is a pull request, not an issue'
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

    It 'warns when a list fills the limit, since more may be hidden'
      export WS_ISSUE_LIMIT=2
      When run script "$WS_ISSUES" parser
      The status should be success
      The stderr should include 'returned 2 issues, the limit'
      The output should include '"number": 1'
    End

    It 'requires jq'
      export PATH="$(ws_path_without jq)"
      When run script "$WS_ISSUES" 1
      The status should equal 1
      The stderr should include 'jq is required'
    End
  End
End
