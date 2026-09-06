"""Ported from `spec/gh/gh_sync_repo_edges_spec.sh`, one test per example.

The paths a happy-path run never reaches: argument handling, the default-branch
resolution fallbacks, a failing remote, and the real dependency install.
"""

from __future__ import annotations

import pytest
import scenarios
from conftest import has_working, has_yarn_berry

# --- arguments ----------------------------------------------------------------


def test_prints_usage_for_help(gh, sync_repo):
    """prints usage for --help without touching anything"""
    result = sync_repo("--help")
    assert result.status == 0
    assert "Usage:" in result.stdout
    assert "import" not in result.stdout


def test_rejects_an_unknown_flag(gh, sync_repo):
    """rejects an unknown flag"""
    result = sync_repo("--wat", gh.repo)
    assert result.status == 2
    assert "unknown flag: --wat" in result.stderr


def test_requires_a_repository_path(gh, sync_repo):
    """requires a repository path"""
    result = sync_repo()
    assert result.status == 2
    assert "usage:" in result.stderr


# --- resolving the default branch ---------------------------------------------


def test_repairs_a_missing_origin_head(gh, sync_repo):
    """repairs a missing origin/HEAD from the remote"""
    gh.forget_origin_head(gh.repo)
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "already up to date" in result.stdout
    assert gh.git(gh.repo, "symbolic-ref", "refs/remotes/origin/HEAD") == "refs/remotes/origin/main"


def test_asks_gh_for_the_default_branch(gh, sync_repo):
    """asks gh for the default branch when the remote cannot be reached"""
    gh.forget_origin_head(gh.repo)
    gh.break_origin(gh.repo)
    result = sync_repo(gh.repo)
    assert result.status == 0
    # gh answered, so we got as far as the fetch before failing.
    assert "fetch failed" in result.stdout


def test_falls_back_to_a_local_default_ref(gh, sync_repo):
    """falls back to a local main/master ref when gh cannot answer either"""
    gh.forget_origin_head(gh.repo)
    gh.break_origin(gh.repo)
    result = sync_repo(gh.repo, env={"GH_FIXTURE_FAIL": "1"})
    assert result.status == 0
    assert "fetch failed" in result.stdout


def test_skips_when_no_default_branch_can_be_determined(gh, sync_repo):
    """skips when no default branch can be determined at all"""
    argv, env = scenarios.cannot_determine_the_default_branch(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "cannot determine the default branch" in result.stdout


def test_skips_when_the_default_branch_has_no_local_remote_ref(gh, sync_repo):
    """gh names a default branch this clone has no remote-tracking ref for."""
    argv, env = scenarios.origin_default_missing(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "origin/trunk does not exist locally" in result.stdout


# --- a remote that cannot be reached ------------------------------------------


def test_reports_a_failed_fetch_and_changes_nothing(gh, sync_repo):
    """reports a failed fetch and changes nothing"""
    argv, env = scenarios.fetch_failed(gh)
    before = gh.branches(gh.repo)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "fetch failed; nothing changed" in result.stdout
    assert gh.branches(gh.repo) == before


# --- the default branch checked out elsewhere ---------------------------------


def test_prunes_anyway_but_does_not_try_to_advance(gh, sync_repo):
    """prunes anyway but does not try to advance

    A linked worktree holds main, so this checkout cannot switch to it.
    """
    argv, env = scenarios.cannot_switch_pruning_only(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "cannot switch to main" in result.stdout
    assert "pruning only" in result.stdout
    assert "deleted gone" in result.stdout


# --- the real dependency install ----------------------------------------------


@pytest.mark.skipif(not has_working("pnpm"), reason="pnpm is unavailable or not working")
def test_runs_pnpm(gh, sync_repo):
    """runs pnpm when the pull changed pnpm-lock.yaml"""
    gh.js_project(gh.repo, "pnpm")
    gh.remote_update_lock(gh.repo, "pnpm")
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "dependencies installed" in result.stdout


@pytest.mark.skipif(not has_working("npm"), reason="npm is unavailable")
def test_runs_npm(gh, sync_repo):
    """runs npm when the project uses package-lock.json"""
    gh.js_project(gh.repo, "npm")
    gh.remote_update_lock(gh.repo, "npm")
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "dependencies installed" in result.stdout


def test_runs_yarn_berry(gh, sync_repo, tmp_path):
    """runs yarn when the project uses Yarn Berry"""
    if not has_yarn_berry(tmp_path):
        pytest.skip("yarn berry is unavailable")
    gh.js_project(gh.repo, "yarn")
    gh.remote_update_lock(gh.repo, "yarn")
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "dependencies installed" in result.stdout


@pytest.mark.skipif(not has_working("pnpm"), reason="pnpm is unavailable or not working")
def test_says_so_when_the_lock_file_was_removed(gh, sync_repo):
    """says so when the lock file was removed by the pull, rather than claiming an install"""
    gh.js_project(gh.repo, "pnpm")
    gh.remote_drop_lockfile(gh.repo, "pnpm-lock.yaml")
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "no recognised lock file remains" in result.stdout


@pytest.mark.skipif(not has_working("pnpm"), reason="pnpm is unavailable or not working")
def test_reports_the_reason_when_an_install_fails(gh, sync_repo):
    """reports the reason when an install fails

    Broken on the remote side, so the default branch still fast-forwards and the
    install is what fails, for a real and reportable reason.
    """
    gh.js_project(gh.repo, "pnpm")
    gh.remote_break_lock(gh.repo, "pnpm-lock.yaml")
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "install failed" in result.stdout


# --- failure branches ---------------------------------------------------------


def test_offers_to_create_the_default_branch(gh, sync_repo):
    """offers to create the default branch when the checkout has never had it"""
    argv, env = scenarios.would_create_the_default_branch(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "would create main from origin/main" in result.stdout


def test_reports_a_fast_forward_that_git_refuses(gh, sync_repo):
    """reports a fast-forward that git refuses

    An index lock is tolerated by git status but refused by anything that updates
    refs, so the merge fails after the preflight has passed.
    """
    argv, env = scenarios.could_not_fast_forward(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "could not fast-forward main" in result.stdout


def test_uses_ancestry_alone_when_gh_is_not_installed(gh, sync_repo, sandbox):
    """uses ancestry alone when gh is not installed at all

    A PATH with no gh on it, as opposed to a gh that fails.
    """
    gh.branch_with_work(gh.repo, "landed")
    gh.merge_commit(gh.repo, "landed")
    result = sync_repo(gh.repo, env={"PATH": sandbox.path_without("gh")})
    assert result.status == 0
    assert "could not read merged pull requests" in result.stdout
    assert "deleted landed" in result.stdout


def test_proves_a_branch_outside_the_bulk_lookup_window(gh, sync_repo):
    """proves a branch whose pull request falls outside the bulk lookup window

    Found in the field: a repo with more merged pull requests than the bulk limit
    drops the oldest, and branches merged before that window looked unproven and
    were kept forever. The per-branch query closes it.

    Real gh returns newest-first, so the limit drops the OLDEST. The stub keeps
    the first N after filtering, and many_prs appends, so the appended pull
    request stands in for the dropped-oldest one.
    """
    argv, env = scenarios.past_the_bulk_window(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "deleted landed" in result.stdout
    assert "merged PR" in result.stdout
    assert "landed" not in gh.branches(gh.repo)


def test_does_not_ask_about_a_branch_the_bulk_lookup_proved(gh, sync_repo):
    """does not ask about a branch the bulk lookup already proved

    Guards the call volume: the per-branch query is a fallback, not a second
    opinion. If it were called unconditionally, a repo with many branches would
    make an API call for each, which is what makes rate limiting likely.
    """
    gh.branch_with_work(gh.repo, "landed")
    # 199 fillers + landed + one more: saturated, with landed inside the window.
    gh.many_prs(199, gh.pr("landed", gh.sha(gh.repo, "landed")), gh.pr("spare", "zzz"))
    log = gh.path / "calls.log"
    result = sync_repo(gh.repo, env={"GH_FIXTURE_CALL_LOG": str(log)})
    assert result.status == 0
    assert "deleted landed" in result.stdout
    assert [line for line in log.read_text().splitlines() if "--head" in line] == []


def test_stops_asking_after_the_first_failure(gh, sync_repo):
    """stops asking after the first failure, and says the run was incomplete

    A failing lookup is very unlikely to be branch-specific, and a rate limit
    only gets worse if we keep asking.
    """
    argv, env = scenarios.per_branch_query_failed(gh)
    log = gh.path / "calls.log"
    env = dict(env)
    env["GH_FIXTURE_CALL_LOG"] = str(log)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept first (could not ask about this branch" in result.stdout
    assert "kept second (could not ask about this branch" in result.stdout
    assert "2 branch(es) were never checked" in result.stdout
    # One attempt, not one per branch.
    assert len([line for line in log.read_text().splitlines() if "--head" in line]) == 1


def test_says_it_could_not_check_when_the_per_branch_query_fails(gh, sync_repo):
    """says it could not check when the per-branch query fails

    Distinct from "no merge proof": nothing was established either way, and
    reporting an absence that was never checked is the defect this fixes.
    """
    gh.branch_with_work(gh.repo, "unchecked")
    gh.many_prs(200)
    result = sync_repo(gh.repo, env={"GH_FIXTURE_FAIL_HEAD": "1"})
    assert result.status == 0
    assert "could not ask about this branch" in result.stdout
    assert "unchecked" in gh.branches(gh.repo)


def test_refuses_to_conclude_when_one_name_fills_the_window(gh, sync_repo):
    """refuses to conclude anything when one name fills the per-branch window

    100 merged pull requests share the name, so "none at this commit" cannot be
    established from a saturated list.
    """
    argv, env = scenarios.per_branch_window_crowded(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "too many merged PRs used this name to tell" in result.stdout
    assert "busy" in gh.branches(gh.repo)


def test_ignores_another_base_in_the_per_branch_query(gh, sync_repo):
    """ignores a PR into another base when falling back to a per-branch query"""
    gh.branch_with_work(gh.repo, "for-release-2")
    gh.many_prs(200, gh.pr("for-release-2", gh.sha(gh.repo, "for-release-2"), "release"))
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "kept for-release-2 (no merge proof)" in result.stdout


def test_still_requires_the_commit_to_match_in_the_fallback(gh, sync_repo):
    """still requires the commit to match when falling back to a per-branch query

    The fallback must not be a weaker signal than the bulk lookup.
    """
    argv, env = scenarios.per_branch_tip_moved(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "kept moved (merged PRs used this name; none at this commit)" in result.stdout
    assert "moved" in gh.branches(gh.repo)


def test_ignores_a_fork_pull_request_in_the_fallback(gh, sync_repo):
    """ignores a fork pull request found by the per-branch query too"""
    gh.branch_with_work(gh.repo, "patch-2")
    gh.many_prs(200, gh.pr("patch-2", gh.sha(gh.repo, "patch-2"), "main", True))
    result = sync_repo(gh.repo)
    assert result.status == 0
    assert "kept patch-2 (no merge proof)" in result.stdout
    assert "patch-2" in gh.branches(gh.repo)


def test_keeps_a_branch_whose_worktree_cannot_be_read(gh, sync_repo):
    """keeps a branch whose worktree cannot be read"""
    argv, env = scenarios.keep_an_unreadable_worktree(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "cannot read worktree" in result.stdout
    assert "wt" in gh.branches(gh.repo)


def test_keeps_a_branch_whose_worktree_cannot_be_removed(gh, sync_repo):
    """keeps a branch when its worktree cannot be removed

    An untracked file passes the cleanliness guard but makes git worktree remove
    refuse without --force, which this deliberately never passes.
    """
    argv, env = scenarios.keep_a_worktree_that_cannot_be_removed(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "could not remove worktree" in result.stdout
    assert "wt" in gh.branches(gh.repo)
    assert (gh.path / "wt").exists()


def test_describes_a_worktree_removal_in_dry_run(gh, sync_repo):
    """describes a worktree removal in --dry-run without doing it"""
    argv, env = scenarios.dry_run_worktree_removal(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "would remove worktree" in result.stdout
    assert (gh.path / "wt").exists()
    assert "wt" in gh.branches(gh.repo)


# --- a branch that cannot be deleted ------------------------------------------


def test_reports_the_branch_it_could_not_delete(gh, sync_repo):
    """reports the branch it could not delete rather than claiming success

    With main held by another worktree the sync cannot switch away, so it is
    still standing on the very branch it has proof to delete. git refuses, which
    is the right outcome; the report has to say so.
    """
    argv, env = scenarios.could_not_delete_a_branch(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "cannot switch to main" in result.stdout
    assert "could not delete side" in result.stdout
    assert "side" in gh.branches(gh.repo)


# --- enumerations that fail ---------------------------------------------------


def test_skips_when_the_worktree_list_cannot_be_read(gh, sync_repo):
    """Fails closed: an empty branch-to-worktree map would make every branch look
    free of a worktree, and that map is the only thing between real uncommitted
    work and a force delete.

    The shell version wrote this skip after a `done < <(...)`, where the `||`
    reads the loop's status rather than git's, so it never fired. This is the
    one place the port deliberately does not match the captured output.
    """
    gh.branch_with_work(gh.repo, "wip")
    directory, failing = gh.git_shim("worktree list")
    result = sync_repo(
        gh.repo, env={"PATH": directory + ":" + scenarios._path(), "GIT_STUB_FAIL": failing}
    )
    assert result.status == 0
    assert "skipped: cannot list worktrees" in result.stdout
    assert "wip" in gh.branches(gh.repo)


def test_skips_when_the_branch_list_cannot_be_read(gh, sync_repo):
    """A ref list that cannot be read prunes nothing and says so."""
    argv, env = scenarios.cannot_list_local_branches(gh)
    result = sync_repo(*argv, env=env)
    assert result.status == 0
    assert "skipped: cannot list local branches" in result.stdout


def test_uses_pull_requests_alone_when_ancestry_cannot_be_read(gh, sync_repo):
    """A failed ancestry probe must not masquerade as "nothing is merged"."""
    gh.branch_with_work(gh.repo, "squashed")
    sha = gh.sha(gh.repo, "squashed")
    gh.merge_squash(gh.repo, "squashed")
    gh.write_prs(gh.pr("squashed", sha))
    directory, failing = gh.git_shim("branch --merged")
    result = sync_repo(
        gh.repo, env={"PATH": directory + ":" + scenarios._path(), "GIT_STUB_FAIL": failing}
    )
    assert result.status == 0
    assert "could not read merged branches; using pull requests alone" in result.stdout
    assert "deleted squashed" in result.stdout


def test_skips_pruning_when_neither_signal_can_be_read(gh, sync_repo):
    """With no pull-request list and no ancestry there is no proof at all, and
    pruning on no proof is exactly the force delete every guard here prevents."""
    gh.branch_with_work(gh.repo, "wip")
    directory, failing = gh.git_shim("branch --merged")
    result = sync_repo(
        gh.repo,
        env={
            "PATH": directory + ":" + scenarios._path(),
            "GIT_STUB_FAIL": failing,
            "GH_FIXTURE_FAIL": "1",
        },
    )
    assert result.status == 0
    assert "no way to prove what has merged; skipped pruning entirely" in result.stdout
    assert "wip" in gh.branches(gh.repo)
