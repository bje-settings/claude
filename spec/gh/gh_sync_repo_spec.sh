# shellcheck shell=bash
Describe 'gh-sync-repo.sh'
  BeforeEach 'setup_sandbox'
  AfterEach 'cleanup_sandbox'

  Describe 'preflight, which must refuse before touching anything'
    It 'skips a directory that is not a git repository'
      mkdir -p "$SANDBOX/plain"
      When run script "$SYNC_REPO" "$SANDBOX/plain"
      The status should be success
      The output should include 'skipped: not a git repository'
    End

    It 'skips a repository with no origin remote'
      fixture_remove_origin "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include "skipped: no 'origin' remote"
    End

    It 'skips a repository with uncommitted changes to tracked files'
      fixture_dirty "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'skipped: uncommitted changes'
    End

    It 'does NOT skip for untracked files alone'
      fixture_untracked "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should not include 'skipped'
    End

    It 'fails closed when the working tree cannot be read at all'
      # A corrupt index makes git status exit non-zero with EMPTY stdout, which
      # a naive check reads as "clean" and proceeds to delete branches on.
      fixture_corrupt_index "$REPO"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'cannot read the working tree state'
      The stderr should be defined
    End

    It 'skips when an operation is in progress in the main worktree'
      fixture_in_progress "$REPO" rebase-merge
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'operation in progress'
    End

    It 'skips when an operation is in progress in a LINKED worktree'
      # A rebasing linked worktree has a detached HEAD, so it maps to no branch
      # and its work would otherwise be invisible to the deletion guards.
      fixture_branch_with_work "$REPO" wt-branch
      fixture_worktree "$REPO" "$SANDBOX/wt" wt-branch
      fixture_in_progress "$SANDBOX/wt" rebase-merge
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'operation in progress in'
    End
  End

  Describe 'advancing the default branch'
    It 'reports an up-to-date default branch'
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'already up to date'
    End

    It 'fast-forwards a default branch that is behind'
      fixture_remote_advance "$REPO"
      before="$(head_sha "$REPO")"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'fast-forwarded'
      The variable before should not equal "$(head_sha "$REPO")"
    End

    It 'switches to the default branch from a feature branch'
      fixture_git "$REPO" checkout -q -b side
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'switched from side to main'
      The value "$(current_branch "$REPO")" should equal main
    End

    It 'refuses to merge a diverged default branch and keeps the local commit'
      fixture_diverge "$REPO"
      local_sha="$(head_sha "$REPO")"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'has diverged'
      The value "$(head_sha "$REPO")" should equal "$local_sha"
    End
  End

  Describe 'proving a branch has merged'
    It 'deletes a branch merged with a merge commit, on ancestry alone'
      fixture_branch_with_work "$REPO" ff-done
      fixture_merge_commit "$REPO" ff-done
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'deleted ff-done'
      The output should include 'merged into main'
      The value "$(branches "$REPO")" should not include ff-done
    End

    It 'keeps a branch with no merge proof'
      fixture_branch_with_work "$REPO" wip
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'kept wip (no merge proof)'
      The value "$(branches "$REPO")" should include wip
    End

    It 'deletes a squash-merged branch on pull-request proof, which ancestry cannot see'
      fixture_branch_with_work "$REPO" squashed
      sha="$(fixture_sha "$REPO" squashed)"
      fixture_merge_squash "$REPO" squashed
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr squashed "$sha")"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'deleted squashed'
      The output should include 'merged PR'
      The value "$(branches "$REPO")" should not include squashed
    End

    It 'KEEPS a branch whose name matches a merged PR but whose tip has moved'
      # The regression that mattered: a reused branch name, or work committed
      # after the PR merged, was force-deleted on a name match alone.
      fixture_branch_with_work "$REPO" reused
      merged_sha="$(fixture_sha "$REPO" reused)"
      fixture_merge_squash "$REPO" reused
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr reused "$merged_sha")"
      # now carry on working on the same branch, without pushing
      fixture_git "$REPO" checkout -q reused
      fixture_commit "$REPO" 'unpushed work' danger.txt secret
      danger="$(head_sha "$REPO")"
      fixture_git "$REPO" checkout -q main
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      # The report names the reason: the work landed, but not this commit.
      The output should include 'kept reused (a merged PR used this name, but at a different commit)'
      The value "$(branches "$REPO")" should include reused
      The value "$(fixture_sha "$REPO" reused)" should equal "$danger"
    End

    It 'ignores a merged PR that came from a fork'
      # A fork PR's head ref is just a name like patch-1, which collides with
      # local branches trivially.
      fixture_branch_with_work "$REPO" patch-1
      sha="$(fixture_sha "$REPO" patch-1)"
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr patch-1 "$sha" main true)"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'kept patch-1'
      The value "$(branches "$REPO")" should include patch-1
    End

    It 'ignores a PR that merged into a branch other than the default'
      fixture_branch_with_work "$REPO" for-release
      sha="$(fixture_sha "$REPO" for-release)"
      fixture_prs "$GH_FIXTURE_PRS" "$(fixture_pr for-release "$sha" release)"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'kept for-release'
      The value "$(branches "$REPO")" should include for-release
    End

    It 'keeps a branch sitting on the default branch tip'
      fixture_branch "$REPO" fresh
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'kept fresh (already at origin/main'
      The value "$(branches "$REPO")" should include fresh
    End

    It 'falls back to ancestry and says so when the PR lookup fails'
      export GH_FIXTURE_FAIL=1
      fixture_branch_with_work "$REPO" ff-done
      fixture_merge_commit "$REPO" ff-done
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'could not read merged pull requests'
      The output should include 'deleted ff-done'
    End
  End

  Describe 'worktrees'
    It 'removes a clean worktree and deletes its merged branch'
      fixture_branch_with_work "$REPO" wt-clean
      fixture_merge_commit "$REPO" wt-clean
      fixture_worktree "$REPO" "$SANDBOX/wt" wt-clean
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'removed worktree'
      The output should include 'deleted wt-clean'
      The path "$SANDBOX/wt" should not be exist
    End

    It 'keeps a merged branch whose worktree has uncommitted changes, and preserves them'
      fixture_branch_with_work "$REPO" wt-dirty
      fixture_merge_commit "$REPO" wt-dirty
      fixture_worktree "$REPO" "$SANDBOX/wt" wt-dirty
      printf 'precious\n' >> "$SANDBOX/wt/wt-dirty.txt"
      When run script "$SYNC_REPO" "$REPO"
      The status should be success
      The output should include 'uncommitted changes'
      The value "$(branches "$REPO")" should include wt-dirty
      The path "$SANDBOX/wt" should be exist
      The contents of file "$SANDBOX/wt/wt-dirty.txt" should include precious
    End
  End

  Describe '--dry-run'
    It 'changes nothing it says it would change'
      fixture_branch_with_work "$REPO" ff-done
      fixture_merge_commit "$REPO" ff-done
      fixture_git "$REPO" checkout -q -b side
      before_branches="$(branches "$REPO")"
      before_head="$(head_sha "$REPO")"
      When run script "$SYNC_REPO" --dry-run "$REPO"
      The status should be success
      The output should include 'would delete ff-done'
      The value "$(branches "$REPO")" should equal "$before_branches"
      The value "$(head_sha "$REPO")" should equal "$before_head"
      The value "$(current_branch "$REPO")" should equal side
    End
  End

  Describe 'dependency install'
    It 'offers to install when the pull changed a lock file'
      fixture_lockfile "$REPO" package-lock.json
      fixture_remote_advance "$REPO" package-lock.json
      When run script "$SYNC_REPO" --dry-run "$REPO"
      The status should be success
      The output should include 'lock file changed in that range'
    End

    It 'stays quiet when the pull did not touch a lock file'
      fixture_lockfile "$REPO" package-lock.json
      fixture_remote_advance "$REPO" other.txt
      When run script "$SYNC_REPO" --dry-run "$REPO"
      The status should be success
      The output should not include 'lock file changed'
    End

    It 'honours --no-install even when a lock file changed'
      fixture_lockfile "$REPO" package-lock.json
      fixture_remote_advance "$REPO" package-lock.json
      When run script "$SYNC_REPO" --dry-run --no-install "$REPO"
      The status should be success
      The output should not include 'lock file changed'
    End
  End
End
