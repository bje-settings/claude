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

  It 'proves a branch whose pull request falls outside the bulk lookup window'
    # Found in the field: a repo with more merged pull requests than the bulk
    # limit drops the oldest, and branches merged before that window looked
    # unproven and were kept forever. The per-branch query closes it.
    fixture_branch_with_work "$REPO" landed
    sha="$(fixture_sha "$REPO" landed)"
    fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr landed "$sha")"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'deleted landed'
    The output should include 'merged PR'
    The value "$(branches "$REPO")" should not include landed
  End

  It 'says it could not check when the per-branch query fails'
    # Distinct from "no merge proof": nothing was established either way, and
    # reporting an absence that was never checked is the defect this fixes.
    fixture_branch_with_work "$REPO" unchecked
    fixture_many_prs "$GH_FIXTURE_PRS" 200
    export GH_FIXTURE_FAIL_HEAD=1
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'could not ask about this branch'
    The value "$(branches "$REPO")" should include unchecked
  End

  It 'refuses to conclude anything when one name fills the per-branch window'
    # 100 merged pull requests share the name, so "none at this commit" cannot
    # be established from a saturated list.
    fixture_branch_with_work "$REPO" busy
    fixture_many_prs "$GH_FIXTURE_PRS" 200
    reuse=""
    for i in $(seq 1 100); do reuse="$reuse $(fixture_pr busy "sha$i")"; done
    # shellcheck disable=SC2086
    fixture_many_prs "$GH_FIXTURE_PRS" 200 $reuse
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'too many merged PRs used this name to tell'
    The value "$(branches "$REPO")" should include busy
  End

  It 'ignores a PR into another base when falling back to a per-branch query'
    fixture_branch_with_work "$REPO" for-release-2
    sha="$(fixture_sha "$REPO" for-release-2)"
    fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr for-release-2 "$sha" release)"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'kept for-release-2 (no merge proof)'
  End

  It 'still requires the commit to match when falling back to a per-branch query'
    # The fallback must not be a weaker signal than the bulk lookup.
    fixture_branch_with_work "$REPO" moved
    merged_sha="$(fixture_sha "$REPO" moved)"
    fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr moved "$merged_sha")"
    fixture_git "$REPO" checkout -q moved
    fixture_commit "$REPO" 'work after the merge' after.txt after
    fixture_git "$REPO" checkout -q main
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'kept moved (merged PRs used this name; none at this commit)'
    The value "$(branches "$REPO")" should include moved
  End

  It 'ignores a fork pull request found by the per-branch query too'
    fixture_branch_with_work "$REPO" patch-2
    sha="$(fixture_sha "$REPO" patch-2)"
    fixture_many_prs "$GH_FIXTURE_PRS" 200 "$(fixture_pr patch-2 "$sha" main true)"
    When run script "$SYNC_REPO" "$REPO"
    The status should be success
    The output should include 'kept patch-2 (no merge proof)'
    The value "$(branches "$REPO")" should include patch-2
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
