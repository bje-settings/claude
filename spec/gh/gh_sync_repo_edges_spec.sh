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
    npm_unavailable() { ! npm --version >/dev/null 2>&1; }
    # Berry is resolved from the project's packageManager field, which only the
    # corepack shim honours. A globally installed yarn 1 ignores it and would
    # fail the example rather than skip it, so probe what yarn actually resolves
    # to in a project that asks for Berry.
    yarn_berry_unavailable() {
      command -v yarn >/dev/null 2>&1 || return 0
      local probe version
      probe="$(mktemp -d)"
      _fixture_write_package_json "$probe" yarn probe
      version="$(cd "$probe" && yarn --version 2>/dev/null)"
      rm -rf "$probe"
      case "$version" in
        [2-9].* | [1-9][0-9].*) return 1 ;;
        *) return 0 ;;
      esac
    }

    It 'runs pnpm when the pull changed pnpm-lock.yaml'
      Skip if 'pnpm is unavailable or not working' install_unavailable
      fixture_js_project "$REPO" pnpm
      fixture_remote_update_lock "$REPO" pnpm
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'dependencies installed'
      The stderr should be defined
    End

    It 'runs yarn when the project uses Yarn Berry'
      Skip if 'yarn berry is unavailable' yarn_berry_unavailable
      fixture_js_project "$REPO" yarn
      fixture_remote_update_lock "$REPO" yarn
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'dependencies installed'
      The stderr should be defined
    End

    It 'runs npm when the project uses package-lock.json'
      Skip if 'npm is unavailable' npm_unavailable
      fixture_js_project "$REPO" npm
      fixture_remote_update_lock "$REPO" npm
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

Describe 'gh-sync-repo.sh failure branches'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  It 'offers to create the default branch when the checkout has never had it'
    fixture_git "$REPO" checkout -q -b side
    fixture_git "$REPO" branch -D main
    When run script "$SYNC_REPO" --dry-run "$REPO"
    The status should be success
    The output should include 'would create main from origin/main'
  End

  It 'reports a fast-forward that git refuses'
    # An index lock is tolerated by git status but refused by anything that
    # updates refs, so the merge fails after the preflight has passed.
    fixture_remote_advance "$REPO"
    fixture_lock_index "$REPO"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'could not fast-forward main'
  End

  It 'uses ancestry alone when gh is not installed at all'
    fixture_branch_with_work "$REPO" landed
    fixture_merge_commit "$REPO" landed
    # A PATH with no gh on it, as opposed to a gh that fails.
    export PATH="/usr/bin:/bin"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'could not read merged pull requests'
    The output should include 'deleted landed'
  End

  It 'says the pull-request list was truncated rather than blaming the branch'
    fixture_many_prs "$GH_FIXTURE_PRS" 200
    fixture_branch_with_work "$REPO" wip
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'PR list truncated at 200'
  End

  It 'keeps a branch whose worktree cannot be read'
    fixture_branch_with_work "$REPO" wt
    fixture_merge_commit "$REPO" wt
    fixture_worktree "$REPO" "$SANDBOX/wt" wt
    fixture_corrupt_index "$SANDBOX/wt"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'cannot read worktree'
    The value "$(branches "$REPO")" should include wt
  End

  It 'keeps a branch when its worktree cannot be removed'
    # An untracked file passes the cleanliness guard but makes git worktree
    # remove refuse without --force, which this deliberately never passes.
    fixture_branch_with_work "$REPO" wt
    fixture_merge_commit "$REPO" wt
    fixture_worktree "$REPO" "$SANDBOX/wt" wt
    printf 'scratch\n' > "$SANDBOX/wt/notes.txt"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'could not remove worktree'
    The value "$(branches "$REPO")" should include wt
    The path "$SANDBOX/wt" should be exist
  End

  It 'describes a worktree removal in --dry-run without doing it'
    fixture_branch_with_work "$REPO" wt
    fixture_merge_commit "$REPO" wt
    fixture_worktree "$REPO" "$SANDBOX/wt" wt
    When run script "$SYNC_REPO" --dry-run "$REPO"
    The status should be success
    The output should include 'would remove worktree'
    The path "$SANDBOX/wt" should be exist
    The value "$(branches "$REPO")" should include wt
  End
End

Describe 'a branch that cannot be deleted'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  It 'reports the branch it could not delete rather than claiming success'
    # With main held by another worktree the sync cannot switch away, so it is
    # still standing on the very branch it has proof to delete. git refuses,
    # which is the right outcome; the report has to say so.
    fixture_branch_with_work "$REPO" side
    fixture_merge_commit "$REPO" side
    fixture_git "$REPO" checkout -q side
    fixture_worktree "$REPO" "$SANDBOX/wt-main" main
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'cannot switch to main'
    The output should include 'could not delete side'
    The value "$(branches "$REPO")" should include side
  End
End
