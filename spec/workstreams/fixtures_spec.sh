# shellcheck shell=bash
# Claims the workstreams fixtures make about themselves. The other specs rely on
# these shapes, so they are asserted here rather than assumed there.
Describe 'workstreams fixtures'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  issues() { jq -c "$1" "$WS_GH_FIXTURE_DIR/issues.json"; }
  prs() { jq -c "$1" "$WS_GH_FIXTURE_DIR/prs.json"; }

  Describe 'issues.json'
    It 'holds seven records: six issues, one of them closed, and one pull request'
      When call issues '[length, ([.[] | select(.state == "CLOSED")] | length), ([.[] | select(.url | test("/pull/"))] | map(.number))]'
      The output should equal '[7,1,[7]]'
    End

    It 'gives issue 1 references to #2 and #4, and issue 2 a null body'
      When call issues '[(.[0].body | test("#2") and test("#4")), .[1].body]'
      The output should equal '[true,null]'
    End

    It 'has issue 3 mention itself and mention #1 twice'
      When call issues '.[2].body | [test("#3"), ([scan("#1\\b")] | length)]'
      The output should equal '[true,2]'
    End

    It 'puts only issue 4 in the observe milestone'
      When call issues '[.[] | select(.milestone.title == "observe") | .number]'
      The output should equal '[4]'
    End

    It 'gives issue 6 a #7 only inside a url'
      When call issues '.[5].body | [test("/#7"), test("(^|[^A-Za-z0-9/])#7")]'
      The output should equal '[true,false]'
    End
  End

  Describe 'prs.json'
    It 'covers open drafts, a ready PR, and a merged PR'
      When call prs '[.[] | select(.number <= 14) | [.state, .isDraft]]'
      The output should equal '[["OPEN",true],["OPEN",true],["OPEN",true],["OPEN",false],["MERGED",false]]'
    End

    It 'stacks PR 12 on the branch of PR 10'
      When call prs '(.[] | select(.number == 12) | .baseRefName) == (.[] | select(.number == 10) | .headRefName)'
      The output should equal 'true'
    End

    It 'carries one PR per check conclusion the fold distinguishes'
      When call prs '[.[] | .statusCheckRollup[]? | (.conclusion // .state // "null")] | unique'
      The output should equal '["CANCELLED","FAILURE","NEUTRAL","PENDING","SKIPPED","STALE","SUCCESS","null"]'
    End

    It 'has PR 13 with no checks and PR 14 with only a StatusContext'
      When call prs '[(.[] | select(.number == 13) | .statusCheckRollup | length), (.[] | select(.number == 14) | .statusCheckRollup | map(.__typename))]'
      The output should equal '[0,["StatusContext"]]'
    End
  End

  Describe 'gh stub'
    It 'reports the fixture repository by default'
      When run command gh repo view --json nameWithOwner --jq .nameWithOwner
      The output should equal 'bje-settings/example'
    End

    It 'honours WS_GH_FIXTURE_REPO'
      export WS_GH_FIXTURE_REPO=acme/widgets
      When run command gh repo view --json nameWithOwner --jq .nameWithOwner
      The output should equal 'acme/widgets'
    End

    It 'filters issue list by state, label, and milestone the way gh does'
      When run command gh issue list --state open --label bug --json number --jq 'map(.number)'
      The output should equal '[1]'
    End

    It 'matches --search against title and body, case-insensitively'
      When run command gh issue list --state open --search LINTER --json number --jq 'map(.number)'
      The output should equal '[2]'
    End

    It 'applies --limit'
      When run command gh issue list --state all --limit 2 --json number --jq 'map(.number)'
      The output should equal '[1,2]'
    End

    It 'rejects a flag it does not emulate rather than ignoring it'
      When run command gh issue list --assignee me --json number
      The status should equal 64
      The stderr should include 'unhandled flag: --assignee'
    End

    It 'projects to exactly the --json fields asked for'
      When run command gh issue view 1 --json number,title --jq 'keys'
      The output should equal '["number","title"]'
    End

    It 'rejects a --json field that does not exist, like real gh'
      When run command gh pr view 10 --json number,isDrft
      The status should equal 1
      The stderr should include 'Unknown JSON field: "isDrft"'
    End

    It 'fails when the --jq expression fails'
      When run command gh repo view --json nameWithOwner --jq 'bad('
      The status should equal 1
      The stderr should include 'compile error'
    End

    It 'rejects a second positional argument'
      When run command gh issue view 1 2 --json number
      The status should equal 1
      The stderr should include 'unexpected second argument: 2'
    End

    It 'rejects a subcommand it does not emulate'
      When run command gh api graphql
      The status should equal 1
      The stderr should include 'unsupported: api graphql'
    End

    It 'fails every call when WS_GH_FIXTURE_FAIL is set'
      export WS_GH_FIXTURE_FAIL=1
      When run command gh auth status
      The status should equal 1
      The stderr should include 'simulated failure'
    End

    It 'serves empty sets when the fixture directory is missing a file'
      rm "$WS_GH_FIXTURE_DIR/extensions.txt"
      When run command gh extension list
      The status should be success
      The output should equal ''
    End

    It 'reports a corrupt fixture as a jq failure, not as not-found'
      printf '{oops' > "$WS_GH_FIXTURE_DIR/issues.json"
      When run command gh issue view 1 --json number
      The status should equal 1
      The stderr should include 'jq failed reading issues.json'
    End

    It 'accepts a pull request by number, #number, or url'
      When run command gh pr view https://example.invalid/p/13 --json number --jq .number
      The output should equal '13'
    End
  End

  Describe 'home and plugin fixtures'
    It 'lays out the gh-stack skill where gh skill install puts it'
      The path "$HOME/.claude/skills/gh-stack/SKILL.md" should be file
    End

    It 'lists extensions tab-separated with the repo in the second column'
      When call awk -F'\t' '{ print $2 }' "$WS_GH_FIXTURE_DIR/extensions.txt"
      The output should equal "$(printf 'github/gh-stack\ndlvhdr/gh-dash')"
    End

    jq_keys() { jq -c '.plugins | keys' "$WS_SANDBOX/bare.json"; }
    It 'can omit the skill and the review plugin, and offers a near-miss extension name'
      ws_fixture_home "$WS_SANDBOX/bare" without-skill
      ws_fixture_installed_plugins "$WS_SANDBOX/bare.json" without-review
      ws_fixture_extensions "$WS_SANDBOX/ext.txt" without-stack
      The path "$WS_SANDBOX/bare/.claude/skills/gh-stack" should not be exist
      The result of function jq_keys should equal '["gh@bje"]'
      The contents of file "$WS_SANDBOX/ext.txt" should include 'github/gh-stack-anything'
      The contents of file "$WS_SANDBOX/ext.txt" should not include "$(printf '\tgithub/gh-stack\t')"
    End
  End
End
