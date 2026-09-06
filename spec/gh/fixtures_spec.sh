# shellcheck shell=bash
# The specs elsewhere are only meaningful if the fixtures really produce the
# states they claim. A fixture that quietly stopped doing so would make those
# specs pass for the wrong reason, so the claims are asserted here directly.
Describe 'fixtures'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  It 'creates a repo with a real origin and a resolvable default branch'
    When call fixture_git "$REPO" symbolic-ref refs/remotes/origin/HEAD
    The status should be success
    The output should equal 'refs/remotes/origin/main'
  End

  It 'leaves a merge-committed branch IN the ancestry set'
    fixture_branch_with_work "$REPO" mc
    fixture_merge_commit "$REPO" mc
    When call fixture_git "$REPO" branch --merged refs/remotes/origin/main --format='%(refname:short)'
    The status should be success
    The output should include mc
  End

  It 'places fan-out repos directly under the scanned directory'
    fixture_create_at "$SANDBOX/fan" one >/dev/null
    When call git -C "$SANDBOX/fan/one" rev-parse --show-toplevel
    The status should be success
    The output should equal "$(cd "$SANDBOX/fan/one" && pwd -P)"
  End

  It 'hides fan-out origins from the non-recursive scan'
    fixture_create_at "$SANDBOX/fan" one >/dev/null
    When call ls "$SANDBOX/fan"
    The status should be success
    The output should equal 'one'
  End

  Describe 'the gh stub'
    It 'rejects a flag it does not emulate, rather than ignoring it'
      # Silently accepting an unknown filter would let specs pass against a
      # query the real gh answers differently.
      When run gh pr list --state merged --author someone
      The status should equal 64
      The stderr should include 'unhandled flag'
    End

    It 'fails on demand, to exercise the degraded path'
      export GH_FIXTURE_FAIL=1
      When run gh pr list --state merged
      The status should not be success
      The stderr should include 'simulated failure'
    End
  End

  Describe 'fixture_dep_pr'
    It 'produces the check shapes it names, as the stub reads them'
      # Every arm of the fold gets a fixture, because coverage cannot see inside
      # a jq program: one statement scores as covered whichever branch is wrong.
      fixture_prs "$GH_FIXTURE_PRS" \
        "$(fixture_dep_pr 1 checks=passed)" "$(fixture_dep_pr 2 checks=failed)" \
        "$(fixture_dep_pr 3 checks=pending)" "$(fixture_dep_pr 4 checks=none)" \
        "$(fixture_dep_pr 5 checks=status-failed)" "$(fixture_dep_pr 6 checks=mixed)" \
        "$(fixture_dep_pr 7 checks=neutral)" "$(fixture_dep_pr 8 checks=cancelled)" \
        "$(fixture_dep_pr 9 checks=null-conclusion)" "$(fixture_dep_pr 10 checks=status-pending)" \
        "$(fixture_dep_pr 11 checks=status-passed)"
      codes() { local n; for n in 1 2 3 4 5 6 7 8 9 10 11; do gh pr checks "$n"; printf '%s ' "$?"; done; }
      When call codes
      The output should equal '0 1 8 0 1 1 0 1 1 8 0 '
    End

    It 'defaults to an open, auto-merge, Dependabot pull request with no risk label'
      When call fixture_dep_pr 7
      The output should include '"state":"OPEN"'
      The output should include '"autoMergeRequest":{"mergeMethod":"MERGE"}'
      The output should include '"login":"app/dependabot"'
      The output should not include 'merge-risk'
    End

    It 'honours every key and rejects one it does not know'
      When call fixture_dep_pr 8 state=MERGED merge=DIRTY auto=false bot=false draft=true risk=high created=2020-01-01T00:00:00Z head=abc
      The output should include '"state":"MERGED"'
      The output should include '"mergeStateStatus":"DIRTY"'
      The output should include '"autoMergeRequest":null'
      The output should include '"is_bot":false'
      The output should include '"isDraft":true'
      The output should include '"name":"merge-risk:high"'
      The output should include '"createdAt":"2020-01-01T00:00:00Z"'
      The output should include '"headRefOid":"abc"'
      The output should include '"mergeCommit":{"oid":"merged8"}'
    End

    It 'rejects a key it does not know rather than ignoring it'
      When call fixture_dep_pr 9 colour=blue
      The status should equal 1
      The stderr should include 'unknown key colour=blue'
    End
  End

  Describe 'gh stub mutations'
    It 'rewrites the head on update-branch and records comments'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_dep_pr 1 merge=BEHIND)"
      gh pr update-branch 1 --rebase >/dev/null
      gh pr comment 1 --body "hello" >/dev/null
      When call jq -r '.[0] | "\(.headRefOid) \(.mergeStateStatus)"' "$GH_FIXTURE_PRS"
      The output should equal 'rebased-sha1 BLOCKED'
      The contents of file "$GH_FIXTURE_PRS.comments" should include 'hello'
    End

    It 'fails an unknown pull request number the way gh does'
      When run script "$FIXTURES_DIR/bin/gh" pr view 42 --json number
      The status should equal 1
      The stderr should include 'Could not resolve to a PullRequest'
    End
  End
End
