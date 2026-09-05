# shellcheck shell=bash
# Claims the workstreams fixtures make about themselves. The other specs rely on
# these shapes, so they are asserted here rather than assumed there.
Describe 'workstreams fixtures'
  BeforeEach 'setup_ws_sandbox'
  AfterEach 'cleanup_ws_sandbox'

  Describe 'issues.json'
    It 'holds six issues, one of them closed'
      When call jq -r '[length, ([.[] | select(.state == "CLOSED")] | length)] | @tsv' "$WS_GH_FIXTURE_DIR/issues.json"
      The output should equal "$(printf '6\t1')"
    End

    It 'gives issue 1 references to #2 and #4, and issue 2 a null body'
      When call jq -c '[(.[0].body | test("#2") and test("#4")), .[1].body]' "$WS_GH_FIXTURE_DIR/issues.json"
      The output should equal '[true,null]'
    End

    It 'puts only issue 4 in the observe milestone'
      When call jq -c '[.[] | select(.milestone.title == "observe") | .number]' "$WS_GH_FIXTURE_DIR/issues.json"
      The output should equal '[4]'
    End
  End

  Describe 'prs.json'
    It 'covers open drafts, a ready PR, and a merged PR'
      When call jq -c '[.[] | [.state, .isDraft]]' "$WS_GH_FIXTURE_DIR/prs.json"
      The output should equal '[["OPEN",true],["OPEN",true],["OPEN",true],["OPEN",false],["MERGED",false]]'
    End

    It 'stacks PR 12 on the branch of PR 10'
      When call jq -r '(.[] | select(.number == 12) | .baseRefName) == (.[] | select(.number == 10) | .headRefName)' "$WS_GH_FIXTURE_DIR/prs.json"
      The output should equal 'true'
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

    It 'accepts a pull request by number, #number, or url'
      When run command gh pr view https://example.invalid/p/13 --json number --jq .number
      The output should equal '13'
    End
  End

  Describe 'home and plugin fixtures'
    It 'lays out the gh-stack skill where gh skill install puts it'
      The path "$HOME/.claude/skills/gh-stack/SKILL.md" should be file
    End

    jq_keys() { jq -c '.plugins | keys' "$WS_SANDBOX/bare.json"; }
    It 'can omit the skill and the review plugin'
      ws_fixture_home "$WS_SANDBOX/bare" without-skill
      ws_fixture_installed_plugins "$WS_SANDBOX/bare.json" without-review
      ws_fixture_extensions "$WS_SANDBOX/ext.txt" without-stack
      The path "$WS_SANDBOX/bare/.claude/skills/gh-stack" should not be exist
      The result of function jq_keys should equal '["gh@bje"]'
      The contents of file "$WS_SANDBOX/ext.txt" should not include 'gh-stack'
    End
  End
End
