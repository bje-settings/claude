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

  It 'leaves a squash-merged branch OUT of the ancestry set'
    # This is the whole reason the pull-request signal exists.
    fixture_branch_with_work "$REPO" sq
    fixture_merge_squash "$REPO" sq
    When call fixture_git "$REPO" branch --merged refs/remotes/origin/main --format='%(refname:short)'
    The status should be success
    The output should not include sq
  End

  It 'leaves a merge-committed branch IN the ancestry set'
    fixture_branch_with_work "$REPO" mc
    fixture_merge_commit "$REPO" mc
    When call fixture_git "$REPO" branch --merged refs/remotes/origin/main --format='%(refname:short)'
    The status should be success
    The output should include mc
  End

  It 'leaves a fast-forwarded branch sitting exactly on the default tip'
    fixture_branch_with_work "$REPO" ff
    fixture_merge_ff "$REPO" ff
    When call fixture_git "$REPO" rev-parse ff refs/remotes/origin/main
    The status should be success
    The lines of output should equal 2
    The line 1 of output should equal "$(fixture_git "$REPO" rev-parse refs/remotes/origin/main)"
  End

  It 'makes git status fail with empty stdout when the index is corrupt'
    # The precise shape the fail-closed preflight guards against.
    fixture_corrupt_index "$REPO"
    When run git -C "$REPO" status --porcelain --untracked-files=no
    The status should not be success
    The stdout should equal ''
    The stderr should be present
  End

  It 'leaves the default branch behind origin after a remote advance'
    fixture_remote_advance "$REPO"
    fixture_git "$REPO" fetch -q origin
    When call fixture_git "$REPO" rev-list --count HEAD..refs/remotes/origin/main
    The status should be success
    The output should equal 1
  End

  It 'produces a genuinely diverged branch'
    fixture_diverge "$REPO"
    fixture_git "$REPO" fetch -q origin
    When call fixture_git "$REPO" rev-list --count --left-right HEAD...refs/remotes/origin/main
    The status should be success
    The output should equal "$(printf '1\t1')"
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
    It 'excludes pull requests from forks'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr mine abc123)" "$(fixture_pr theirs def456 main true)"
      When run gh pr list --state merged --base main --limit 200 --json headRefName,headRefOid,isCrossRepository --jq '.[] | select(.isCrossRepository == false) | .headRefName'
      The status should be success
      The output should equal 'mine'
    End

    It 'excludes pull requests merged into another base'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr onto-main abc123)" "$(fixture_pr onto-release def456 release)"
      When run gh pr list --state merged --base main --limit 200 --json headRefName --jq '.[].headRefName'
      The status should be success
      The output should equal 'onto-main'
    End

    It 'honours --limit, so the bulk lookup window can be exercised'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr a 1)" "$(fixture_pr b 2)" "$(fixture_pr c 3)"
      When run gh pr list --state merged --base main --limit 2 --json headRefName --jq '.[].headRefName'
      The status should be success
      The lines of output should equal 2
    End

    It 'filters by --head, as the real gh does'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr wanted aaa)" "$(fixture_pr other bbb)"
      When run gh pr list --state merged --base main --head wanted --limit 5 --json headRefName --jq '.[].headRefName'
      The status should be success
      The output should equal 'wanted'
    End

    It 'places explicit pull requests past the lookup limit' 
      # The spec that proves the per-branch fallback works is only meaningful if
      # this holds. Verified by mutation: appending at the front instead leaves
      # every fallback spec passing without the fallback ever running.
      fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr late abc123)"
      When run gh pr list --state merged --base main --limit 200 --json headRefName --jq '.[].headRefName'
      The status should be success
      The output should not include late
    End

    It 'still reaches a past-the-limit pull request by branch'
      fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr late abc123)"
      When run gh pr list --state merged --base main --head late --limit 100 --json headRefName --jq '.[].headRefName'
      The status should be success
      The output should equal 'late'
    End

    It 'rejects a flag it does not emulate, rather than ignoring it'
      # Silently accepting an unknown filter would let specs pass against a
      # query the real gh answers differently.
      When run gh pr list --state merged --author someone
      The status should equal 64
      The stderr should include 'unhandled flag'
    End

    It 'can fail only the per-branch query'
      export GH_FIXTURE_FAIL_HEAD=1
      When run gh pr list --state merged --base main --head x --limit 5 --json headRefName --jq '.[].headRefName'
      The status should not be success
      The stderr should include 'simulated per-branch failure'
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
