# shellcheck shell=bash
# The paths a happy-path run never reaches: argument handling, the default-branch
# resolution fallbacks, a failing remote, and the real dependency install.
Describe 'gh-sync-repo.sh edge paths'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  Describe 'arguments'
    It 'prints usage for --help without touching anything'
      When run script "$SYNC_REPO" --help
      The status should be success
      The output should include 'Usage:'
      The output should not include 'set -uo pipefail'
    End

    It 'rejects an unknown flag'
      When run script "$SYNC_REPO" --wat "$REPO"
      The status should equal 2
      The stderr should include 'unknown flag: --wat'
    End

    It 'requires a repository path'
      When run script "$SYNC_REPO"
      The status should equal 2
      The stderr should include 'usage:'
    End
  End

  Describe 'resolving the default branch'
    It 'repairs a missing origin/HEAD from the remote'
      fixture_forget_origin_head "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'already up to date'
      The value "$(fixture_git "$REPO" symbolic-ref refs/remotes/origin/HEAD)" \
        should equal 'refs/remotes/origin/main'
    End

    It 'asks gh for the default branch when the remote cannot be reached'
      fixture_forget_origin_head "$REPO"
      fixture_break_origin "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      # gh answered, so we got as far as the fetch before failing
      The output should include 'fetch failed'
      The stderr should be defined
    End

    It 'falls back to a local main/master ref when gh cannot answer either'
      export GH_FIXTURE_FAIL=1
      fixture_forget_origin_head "$REPO"
      fixture_break_origin "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'fetch failed'
      The stderr should be defined
    End

    It 'skips when no default branch can be determined at all'
      export GH_FIXTURE_FAIL=1
      fixture_forget_origin_head "$REPO"
      fixture_drop_remote_branches "$REPO"
      fixture_break_origin "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'cannot determine the default branch'
      The stderr should be defined
    End
  End

  Describe 'a remote that cannot be reached'
    It 'reports a failed fetch and changes nothing'
      fixture_branch_with_work "$REPO" wip
      fixture_break_origin "$REPO"
      before="$(branches "$REPO")"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'fetch failed; nothing changed'
      The value "$(branches "$REPO")" should equal "$before"
      The stderr should be defined
    End
  End

  Describe 'the default branch checked out elsewhere'
    It 'prunes anyway but does not try to advance'
      # A linked worktree holds main, so this checkout cannot switch to it.
      # Build and merge the branch first: once a worktree holds main, this
      # checkout can no longer switch to it, which is the point of the test.
      fixture_branch_with_work "$REPO" gone
      fixture_merge_commit "$REPO" gone
      fixture_git "$REPO" checkout -q -b side
      fixture_worktree "$REPO" "$SANDBOX/wt-main" main
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'cannot switch to main'
      The output should include 'pruning only'
      The output should include 'deleted gone'
    End
  End

  Describe 'the real dependency install'
    # Checks that pnpm actually runs, not merely that something named pnpm is on
    # PATH: a corepack shim for a Node version it does not support resolves fine
    # and then fails, which would surface as a confusing spec failure.
    install_unavailable() { ! pnpm --version >/dev/null 2>&1; }

    It 'runs pnpm when the pull changed pnpm-lock.yaml'
      Skip if 'pnpm is unavailable or not working' install_unavailable
      fixture_js_project "$REPO" pnpm
      fixture_remote_update_lock "$REPO" pnpm
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'dependencies installed'
      The stderr should be defined
    End

    It 'says so when the lock file was removed by the pull, rather than claiming an install'
      Skip if 'pnpm is unavailable or not working' install_unavailable
      fixture_js_project "$REPO" pnpm
      fixture_remote_drop_lockfile "$REPO" pnpm-lock.yaml
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'no recognised lock file remains'
    End

    It 'reports the reason when an install fails'
      Skip if 'pnpm is unavailable or not working' install_unavailable
      fixture_js_project "$REPO" pnpm
      # Broken on the remote side, so the default branch still fast-forwards and
      # the install is what fails, for a real and reportable reason.
      fixture_remote_break_lock "$REPO" pnpm-lock.yaml
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'install failed'
      The stderr should be defined
    End
  End
End
