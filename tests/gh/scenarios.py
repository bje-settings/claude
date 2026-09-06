"""The repository states whose report is compared against the shell version.

`tests/gh/golden/bash-output.json` holds what `gh-sync-repo.sh` printed for each
of these, captured before the shell script was deleted, with SHAs and sandbox
paths normalised out. `test_output_parity.py` asserts the Python port prints the
same thing. Every skip reason is here, along with the report lines a normal run
produces.

A scenario builds its state and returns `(argv, env)` for the run.
"""

from __future__ import annotations

import re

# The two things that legitimately differ between two runs of the same scenario:
# commit hashes, and the temporary directory the fixtures were built in.
SHA = re.compile(r"\b[0-9a-f]{7,40}\b")


def normalise(text, sandbox):
    """One run's report, with the per-run detail replaced by placeholders."""
    for path in {str(sandbox), str(sandbox.resolve())}:
        text = text.replace(path, "<sandbox>")
    return SHA.sub("<sha>", text)


def not_a_git_repository(gh):
    (gh.path / "plain").mkdir()
    return [str(gh.path / "plain")], {}


def cannot_enter_directory(gh):
    return [str(gh.path / "nowhere")], {}


def no_origin_remote(gh):
    gh.remove_origin(gh.repo)
    return [str(gh.repo)], {}


def uncommitted_changes(gh):
    gh.dirty(gh.repo)
    return [str(gh.repo)], {}


def cannot_read_the_working_tree(gh):
    gh.corrupt_index(gh.repo)
    return [str(gh.repo)], {}


def operation_in_progress(gh):
    gh.in_progress(gh.repo, "rebase-merge")
    return [str(gh.repo)], {}


def operation_in_progress_in_a_linked_worktree(gh):
    gh.branch_with_work(gh.repo, "wt-branch")
    gh.worktree(gh.repo, gh.path / "wt", "wt-branch")
    gh.in_progress(gh.path / "wt", "rebase-merge")
    return [str(gh.repo)], {}


def cannot_determine_the_default_branch(gh):
    gh.forget_origin_head(gh.repo)
    gh.drop_remote_branches(gh.repo)
    gh.break_origin(gh.repo)
    return [str(gh.repo)], {"GH_FIXTURE_FAIL": "1"}


def origin_default_missing(gh):
    # gh names a default branch this clone has no remote-tracking ref for. In
    # --dry-run origin/HEAD is not repaired, so the answer stands.
    gh.forget_origin_head(gh.repo)
    return ["--dry-run", str(gh.repo)], {"GH_FIXTURE_DEFAULT": "trunk"}


def cannot_list_local_branches(gh):
    directory, failing = gh.git_shim("for-each-ref")
    return [str(gh.repo)], {"PATH": directory + ":" + _path(), "GIT_STUB_FAIL": failing}


def already_up_to_date(gh):
    return [str(gh.repo)], {}


def fast_forward(gh):
    gh.remote_advance(gh.repo)
    return [str(gh.repo)], {}


def switch_to_the_default_branch(gh):
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    return [str(gh.repo)], {}


def diverged(gh):
    gh.diverge(gh.repo)
    return [str(gh.repo)], {}


def fetch_failed(gh):
    gh.branch_with_work(gh.repo, "wip")
    gh.break_origin(gh.repo)
    return [str(gh.repo)], {}


def delete_on_ancestry(gh):
    gh.branch_with_work(gh.repo, "ff-done")
    gh.merge_commit(gh.repo, "ff-done")
    return [str(gh.repo)], {}


def keep_without_merge_proof(gh):
    gh.branch_with_work(gh.repo, "wip")
    return [str(gh.repo)], {}


def delete_on_pull_request_proof(gh):
    gh.branch_with_work(gh.repo, "squashed")
    sha = gh.sha(gh.repo, "squashed")
    gh.merge_squash(gh.repo, "squashed")
    gh.write_prs(gh.pr("squashed", sha))
    return [str(gh.repo)], {}


def keep_a_branch_whose_tip_has_moved(gh):
    gh.branch_with_work(gh.repo, "reused")
    merged = gh.sha(gh.repo, "reused")
    gh.merge_squash(gh.repo, "reused")
    gh.write_prs(gh.pr("reused", merged))
    gh.git(gh.repo, "checkout", "-q", "reused")
    gh.commit(gh.repo, "unpushed work", "danger.txt", "secret")
    gh.git(gh.repo, "checkout", "-q", "main")
    return [str(gh.repo)], {}


def ignore_a_fork_pull_request(gh):
    gh.branch_with_work(gh.repo, "patch-1")
    gh.write_prs(gh.pr("patch-1", gh.sha(gh.repo, "patch-1"), "main", True))
    return [str(gh.repo)], {}


def ignore_another_base(gh):
    gh.branch_with_work(gh.repo, "for-release")
    gh.write_prs(gh.pr("for-release", gh.sha(gh.repo, "for-release"), "release"))
    return [str(gh.repo)], {}


def keep_a_branch_on_the_tip(gh):
    gh.branch(gh.repo, "fresh")
    return [str(gh.repo)], {}


def pull_request_lookup_failed(gh):
    gh.branch_with_work(gh.repo, "ff-done")
    gh.merge_commit(gh.repo, "ff-done")
    return [str(gh.repo)], {"GH_FIXTURE_FAIL": "1"}


def remove_a_clean_worktree(gh):
    gh.branch_with_work(gh.repo, "wt-clean")
    gh.merge_commit(gh.repo, "wt-clean")
    gh.worktree(gh.repo, gh.path / "wt", "wt-clean")
    return [str(gh.repo)], {}


def keep_a_dirty_worktree(gh):
    gh.branch_with_work(gh.repo, "wt-dirty")
    gh.merge_commit(gh.repo, "wt-dirty")
    gh.worktree(gh.repo, gh.path / "wt", "wt-dirty")
    gh.dirty(gh.path / "wt", "wt-dirty.txt")
    return [str(gh.repo)], {}


def keep_an_unreadable_worktree(gh):
    gh.branch_with_work(gh.repo, "wt")
    gh.merge_commit(gh.repo, "wt")
    gh.worktree(gh.repo, gh.path / "wt", "wt")
    gh.corrupt_index(gh.path / "wt")
    return [str(gh.repo)], {}


def keep_a_worktree_that_cannot_be_removed(gh):
    gh.branch_with_work(gh.repo, "wt")
    gh.merge_commit(gh.repo, "wt")
    gh.worktree(gh.repo, gh.path / "wt", "wt")
    (gh.path / "wt" / "notes.txt").write_text("scratch\n")
    return [str(gh.repo)], {}


def dry_run(gh):
    gh.branch_with_work(gh.repo, "ff-done")
    gh.merge_commit(gh.repo, "ff-done")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    return ["--dry-run", str(gh.repo)], {}


def dry_run_worktree_removal(gh):
    gh.branch_with_work(gh.repo, "wt")
    gh.merge_commit(gh.repo, "wt")
    gh.worktree(gh.repo, gh.path / "wt", "wt")
    return ["--dry-run", str(gh.repo)], {}


def lock_file_changed(gh):
    gh.lockfile(gh.repo, "package-lock.json")
    gh.remote_advance(gh.repo, "package-lock.json")
    return ["--dry-run", str(gh.repo)], {}


def lock_file_untouched(gh):
    gh.lockfile(gh.repo, "package-lock.json")
    gh.remote_advance(gh.repo, "other.txt")
    return ["--dry-run", str(gh.repo)], {}


def no_install(gh):
    gh.lockfile(gh.repo, "package-lock.json")
    gh.remote_advance(gh.repo, "package-lock.json")
    return ["--dry-run", "--no-install", str(gh.repo)], {}


def cannot_switch_pruning_only(gh):
    gh.branch_with_work(gh.repo, "gone")
    gh.merge_commit(gh.repo, "gone")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    gh.worktree(gh.repo, gh.path / "wt-main", "main")
    return [str(gh.repo)], {}


def would_create_the_default_branch(gh):
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    gh.git(gh.repo, "branch", "-D", "main")
    return ["--dry-run", str(gh.repo)], {}


def could_not_fast_forward(gh):
    gh.remote_advance(gh.repo)
    gh.lock_index(gh.repo)
    return [str(gh.repo)], {}


def could_not_delete_a_branch(gh):
    gh.branch_with_work(gh.repo, "side")
    gh.merge_commit(gh.repo, "side")
    gh.git(gh.repo, "checkout", "-q", "side")
    gh.worktree(gh.repo, gh.path / "wt-main", "main")
    return [str(gh.repo)], {}


def past_the_bulk_window(gh):
    gh.branch_with_work(gh.repo, "landed")
    gh.many_prs(200, gh.pr("landed", gh.sha(gh.repo, "landed")))
    return [str(gh.repo)], {}


def per_branch_query_failed(gh):
    gh.branch_with_work(gh.repo, "first")
    gh.branch_with_work(gh.repo, "second")
    gh.many_prs(200)
    return [str(gh.repo)], {"GH_FIXTURE_FAIL_HEAD": "1"}


def per_branch_window_crowded(gh):
    gh.branch_with_work(gh.repo, "busy")
    gh.many_prs(200, *[gh.pr("busy", f"sha{i}") for i in range(1, 101)])
    return [str(gh.repo)], {}


def per_branch_tip_moved(gh):
    gh.branch_with_work(gh.repo, "moved")
    merged = gh.sha(gh.repo, "moved")
    gh.many_prs(200, gh.pr("moved", merged))
    gh.git(gh.repo, "checkout", "-q", "moved")
    gh.commit(gh.repo, "work after the merge", "after.txt", "after")
    gh.git(gh.repo, "checkout", "-q", "main")
    return [str(gh.repo)], {}


def _path():
    import os

    return os.environ.get("PATH", "")


# Name -> builder. The name is the key in the golden file.
SCENARIOS = {
    name: value
    for name, value in sorted(globals().items())
    if callable(value) and not name.startswith("_") and name not in ("normalise",)
}
