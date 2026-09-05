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

    It 'honours --limit, so truncation can be exercised'
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr a 1)" "$(fixture_pr b 2)" "$(fixture_pr c 3)"
      When run gh pr list --state merged --base main --limit 2 --json headRefName --jq '.[].headRefName'
      The status should be success
      The lines of output should equal 2
    End

    It 'fails on demand, to exercise the degraded path'
      export GH_FIXTURE_FAIL=1
      When run gh pr list --state merged
      The status should not be success
      The stderr should include 'simulated failure'
    End
  End
End
