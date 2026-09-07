"""Ported from `spec/gh/gh_sync_repo_spec.sh`, one test per example.

Each test carries the `It` description it came from in its docstring. Setup that
`test_output_parity.py` also uses comes from `scenarios.py`, so the two files
cannot drift into asserting different states under the same name; the assertions
here are the example's own claims, including the side effects the report alone
does not prove.
"""

from __future__ import annotations

import scenarios

# --- preflight, which must refuse before touching anything --------------------


def test_skips_a_directory_that_is_not_a_git_repository(gh, sync_repo):
    """skips a directory that is not a git repository"""
    argv, env = scenarios.not_a_git_repository(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "skipped: not a git repository" in result.stdout


def test_skips_a_repository_with_no_origin_remote(gh, sync_repo):
    """skips a repository with no origin remote"""
    argv, env = scenarios.no_origin_remote(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "skipped: no 'origin' remote" in result.stdout


def test_skips_a_repository_with_uncommitted_changes(gh, sync_repo):
    """skips a repository with uncommitted changes to tracked files"""
    argv, env = scenarios.uncommitted_changes(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "skipped: uncommitted changes" in result.stdout


def test_does_not_skip_for_untracked_files_alone(gh, sync_repo):
    """does NOT skip for untracked files alone"""
    gh.untracked(gh.repo)
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "skipped" not in result.stdout


def test_fails_closed_when_the_working_tree_cannot_be_read(gh, sync_repo):
    """fails closed when the working tree cannot be read at all

    A corrupt index makes git status exit non-zero with EMPTY stdout, which a
    naive check reads as "clean" and proceeds to delete branches on.
    """
    argv, env = scenarios.cannot_read_the_working_tree(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "cannot read the working tree state" in result.stdout


def test_skips_an_operation_in_progress_in_the_main_worktree(gh, sync_repo):
    """skips when an operation is in progress in the main worktree"""
    argv, env = scenarios.operation_in_progress(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "operation in progress" in result.stdout


def test_skips_an_operation_in_progress_in_a_linked_worktree(gh, sync_repo):
    """skips when an operation is in progress in a LINKED worktree

    A rebasing linked worktree has a detached HEAD, so it maps to no branch and
    its work would otherwise be invisible to the deletion guards.
    """
    argv, env = scenarios.operation_in_progress_in_a_linked_worktree(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "operation in progress in" in result.stdout


# --- advancing the default branch ---------------------------------------------


def test_reports_an_up_to_date_default_branch(gh, sync_repo):
    """reports an up-to-date default branch"""
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "already up to date" in result.stdout


def test_fast_forwards_a_default_branch_that_is_behind(gh, sync_repo):
    """fast-forwards a default branch that is behind"""
    argv, env = scenarios.fast_forward(gh)
    before = gh.head_sha(gh.repo)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "fast-forwarded" in result.stdout
    assert gh.head_sha(gh.repo) != before


def test_switches_to_the_default_branch(gh, sync_repo):
    """switches to the default branch from a feature branch"""
    argv, env = scenarios.switch_to_the_default_branch(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "switched from side to main" in result.stdout
    assert gh.current_branch(gh.repo) == "main"


def test_refuses_to_merge_a_diverged_default_branch(gh, sync_repo):
    """refuses to merge a diverged default branch and keeps the local commit"""
    argv, env = scenarios.diverged(gh)
    local = gh.head_sha(gh.repo)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "has diverged" in result.stdout
    assert gh.head_sha(gh.repo) == local


# --- proving a branch has merged ----------------------------------------------


def test_deletes_a_branch_merged_with_a_merge_commit(gh, sync_repo):
    """deletes a branch merged with a merge commit, on ancestry alone"""
    argv, env = scenarios.delete_on_ancestry(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "deleted ff-done" in result.stdout
    assert "merged into main" in result.stdout
    assert "ff-done" not in gh.branches(gh.repo)


def test_keeps_a_branch_with_no_merge_proof(gh, sync_repo):
    """keeps a branch with no merge proof"""
    argv, env = scenarios.keep_without_merge_proof(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept wip (no merge proof)" in result.stdout
    assert "wip" in gh.branches(gh.repo)


def test_deletes_a_squash_merged_branch_on_pull_request_proof(gh, sync_repo):
    """deletes a squash-merged branch on pull-request proof, which ancestry cannot see"""
    argv, env = scenarios.delete_on_pull_request_proof(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "deleted squashed" in result.stdout
    assert "merged PR" in result.stdout
    assert "squashed" not in gh.branches(gh.repo)


def test_keeps_a_branch_whose_tip_has_moved(gh, sync_repo):
    """KEEPS a branch whose name matches a merged PR but whose tip has moved

    The regression that mattered: a reused branch name, or work committed after
    the PR merged, was force-deleted on a name match alone. The report names what
    was established: something merged under this name, but not this commit.
    """
    argv, env = scenarios.keep_a_branch_whose_tip_has_moved(gh)
    danger = gh.sha(gh.repo, "reused")
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept reused (merged PRs used this name; none at this commit)" in result.stdout
    assert "reused" in gh.branches(gh.repo)
    assert gh.sha(gh.repo, "reused") == danger


def test_ignores_a_merged_pull_request_from_a_fork(gh, sync_repo):
    """ignores a merged PR that came from a fork

    A fork PR's head ref is just a name like patch-1, which collides with local
    branches trivially.
    """
    argv, env = scenarios.ignore_a_fork_pull_request(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept patch-1 (no merge proof)" in result.stdout
    assert "patch-1" in gh.branches(gh.repo)


def test_ignores_a_pull_request_merged_into_another_base(gh, sync_repo):
    """ignores a PR that merged into a branch other than the default"""
    argv, env = scenarios.ignore_another_base(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept for-release (no merge proof)" in result.stdout
    assert "for-release" in gh.branches(gh.repo)


def test_keeps_a_branch_sitting_on_the_default_tip(gh, sync_repo):
    """keeps a branch sitting on the default branch tip"""
    argv, env = scenarios.keep_a_branch_on_the_tip(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept fresh (already at origin/main" in result.stdout
    assert "fresh" in gh.branches(gh.repo)


def test_falls_back_to_ancestry_when_the_pull_request_lookup_fails(gh, sync_repo):
    """falls back to ancestry and says so when the PR lookup fails"""
    argv, env = scenarios.pull_request_lookup_failed(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert (
        "could not read merged pull requests (gh: simulated failure); using ancestry alone"
        in result.stdout
    )
    assert "deleted ff-done" in result.stdout


# --- worktrees ----------------------------------------------------------------


def test_removes_a_clean_worktree_and_deletes_its_branch(gh, sync_repo):
    """removes a clean worktree and deletes its merged branch"""
    argv, env = scenarios.remove_a_clean_worktree(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "removed worktree" in result.stdout
    assert "deleted wt-clean" in result.stdout
    assert not (gh.path / "wt").exists()


def test_keeps_a_merged_branch_whose_worktree_is_dirty(gh, sync_repo):
    """keeps a merged branch whose worktree has uncommitted changes, and preserves them"""
    argv, env = scenarios.keep_a_dirty_worktree(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "uncommitted changes" in result.stdout
    assert "wt-dirty" in gh.branches(gh.repo)
    assert (gh.path / "wt").exists()
    assert "dirty" in (gh.path / "wt" / "wt-dirty.txt").read_text()


# --- --dry-run ----------------------------------------------------------------


def test_dry_run_changes_nothing_it_says_it_would_change(gh, sync_repo):
    """changes nothing it says it would change"""
    argv, env = scenarios.dry_run(gh)
    before_branches = gh.branches(gh.repo)
    before_head = gh.head_sha(gh.repo)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "would delete ff-done" in result.stdout
    assert gh.branches(gh.repo) == before_branches
    assert gh.head_sha(gh.repo) == before_head
    assert gh.current_branch(gh.repo) == "side"


# --- dependency install -------------------------------------------------------


def test_offers_to_install_when_the_pull_changed_a_lock_file(gh, sync_repo):
    """offers to install when the pull changed a lock file"""
    argv, env = scenarios.lock_file_changed(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "lock file changed in that range" in result.stdout


def test_stays_quiet_when_the_pull_did_not_touch_a_lock_file(gh, sync_repo):
    """stays quiet when the pull did not touch a lock file"""
    argv, env = scenarios.lock_file_untouched(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "lock file changed" not in result.stdout


def test_honours_no_install_even_when_a_lock_file_changed(gh, sync_repo):
    """honours --no-install even when a lock file changed"""
    argv, env = scenarios.no_install(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "lock file changed" not in result.stdout


def test_honours_the_no_install_environment_flag(gh, sync_repo):
    """GH_SYNC_NO_INSTALL is how gh-sync.sh passes --no-install to its jobs."""
    gh.lockfile(gh.repo, "package-lock.json")
    gh.remote_advance(gh.repo, "package-lock.json")
    result = sync_repo("--dry-run", gh.repo, env={"GH_SYNC_NO_INSTALL": "1"})
    assert result.status == 0
    assert "lock file changed" not in result.stdout


def test_honours_the_dry_run_environment_flag(gh, sync_repo):
    """GH_SYNC_DRY_RUN is the other half of that contract."""
    gh.branch_with_work(gh.repo, "ff-done")
    gh.merge_commit(gh.repo, "ff-done")
    result = sync_repo(gh.repo, env={"GH_SYNC_DRY_RUN": "1"})
    assert result.status == 0
    assert "would delete ff-done" in result.stdout
    assert "ff-done" in gh.branches(gh.repo)
