"""Ported from `spec/gh/fixtures_spec.sh`, one test per claim.

The other tests are only meaningful if the fixtures really produce the states
they claim. A fixture that quietly stopped doing so would make those tests pass
for the wrong reason, so the claims are asserted here directly.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time

import pytest
from lib import prs as prs_lib

PR_FIELDS = "headRefName,headRefOid,isCrossRepository"


def run_gh(*args):
    """The stub gh, as the scripts invoke it: status, stdout, stderr."""
    completed = subprocess.run(["gh", *args], capture_output=True, env=dict(os.environ))
    return (
        completed.returncode,
        completed.stdout.decode("utf-8", "replace"),
        completed.stderr.decode("utf-8", "replace"),
    )


def pr_list(*args):
    status, stdout, _ = run_gh("pr", "list", *args)
    assert status == 0
    return json.loads(stdout)


# --- the repositories ---------------------------------------------------------


def test_creates_a_repo_with_a_real_origin(gh):
    """creates a repo with a real origin and a resolvable default branch"""
    assert gh.git(gh.repo, "symbolic-ref", "refs/remotes/origin/HEAD") == "refs/remotes/origin/main"


def test_a_squash_merged_branch_is_out_of_the_ancestry_set(gh):
    """leaves a squash-merged branch OUT of the ancestry set

    This is the whole reason the pull-request signal exists.
    """
    gh.branch_with_work(gh.repo, "sq")
    gh.merge_squash(gh.repo, "sq")
    merged = gh.git(
        gh.repo, "branch", "--merged", "refs/remotes/origin/main", "--format=%(refname:short)"
    )
    assert "sq" not in merged.split()


def test_a_merge_committed_branch_is_in_the_ancestry_set(gh):
    """leaves a merge-committed branch IN the ancestry set"""
    gh.branch_with_work(gh.repo, "mc")
    gh.merge_commit(gh.repo, "mc")
    merged = gh.git(
        gh.repo, "branch", "--merged", "refs/remotes/origin/main", "--format=%(refname:short)"
    )
    assert "mc" in merged.split()


def test_a_fast_forwarded_branch_sits_on_the_default_tip(gh):
    """leaves a fast-forwarded branch sitting exactly on the default tip"""
    gh.branch_with_work(gh.repo, "ff")
    gh.merge_ff(gh.repo, "ff")
    assert gh.sha(gh.repo, "ff") == gh.sha(gh.repo, "refs/remotes/origin/main")


def test_a_corrupt_index_fails_with_empty_stdout(gh):
    """makes git status fail with empty stdout when the index is corrupt

    The precise shape the fail-closed preflight guards against.
    """
    gh.corrupt_index(gh.repo)
    completed = subprocess.run(
        ["git", "-C", str(gh.repo), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
    )
    assert completed.returncode != 0
    assert completed.stdout == b""
    assert completed.stderr != b""


def test_a_remote_advance_leaves_the_branch_behind(gh):
    """leaves the default branch behind origin after a remote advance"""
    gh.remote_advance(gh.repo)
    gh.git(gh.repo, "fetch", "-q", "origin")
    assert gh.git(gh.repo, "rev-list", "--count", "HEAD..refs/remotes/origin/main") == "1"


def test_produces_a_genuinely_diverged_branch(gh):
    """produces a genuinely diverged branch"""
    gh.diverge(gh.repo)
    gh.git(gh.repo, "fetch", "-q", "origin")
    counts = gh.git(
        gh.repo, "rev-list", "--count", "--left-right", "HEAD...refs/remotes/origin/main"
    )
    assert counts.split() == ["1", "1"]


def test_fan_out_repos_sit_directly_under_the_scanned_directory(gh):
    """places fan-out repos directly under the scanned directory"""
    gh.create_at(gh.path / "fan", "one")
    top = gh.git(gh.path / "fan" / "one", "rev-parse", "--show-toplevel")
    assert top == os.path.realpath(str(gh.path / "fan" / "one"))


def test_fan_out_origins_are_hidden_from_the_scan(gh):
    """hides fan-out origins from the non-recursive scan"""
    gh.create_at(gh.path / "fan", "one")
    assert [name for name in os.listdir(gh.path / "fan") if not name.startswith(".")] == ["one"]


# --- the gh stub --------------------------------------------------------------


def test_the_stub_carries_forks_for_the_caller_to_drop(gh):
    """excludes pull requests from forks

    The projection is the stub's job and the fork exclusion is the script's, so
    the claim is that own_rows over what the stub returns leaves the fork out.
    """
    gh.write_prs(gh.pr("mine", "abc123"), gh.pr("theirs", "def456", "main", True))
    rows = pr_list("--state", "merged", "--base", "main", "--limit", "200", "--json", PR_FIELDS)
    assert [row["headRefName"] for row in prs_lib.own_rows(rows)] == ["mine"]


def test_the_stub_excludes_another_base(gh):
    """excludes pull requests merged into another base"""
    gh.write_prs(gh.pr("onto-main", "abc123"), gh.pr("onto-release", "def456", "release"))
    rows = pr_list("--state", "merged", "--base", "main", "--limit", "200", "--json", "headRefName")
    assert [row["headRefName"] for row in rows] == ["onto-main"]


def test_the_stub_honours_limit(gh):
    """honours --limit, so the bulk lookup window can be exercised"""
    gh.write_prs(gh.pr("a", "1"), gh.pr("b", "2"), gh.pr("c", "3"))
    rows = pr_list("--state", "merged", "--base", "main", "--limit", "2", "--json", "headRefName")
    assert len(rows) == 2


def test_the_stub_filters_by_head(gh):
    """filters by --head, as the real gh does"""
    gh.write_prs(gh.pr("wanted", "aaa"), gh.pr("other", "bbb"))
    rows = pr_list(
        "--state",
        "merged",
        "--base",
        "main",
        "--head",
        "wanted",
        "--limit",
        "5",
        "--json",
        "headRefName",
    )
    assert [row["headRefName"] for row in rows] == ["wanted"]


def test_many_prs_places_explicit_pulls_past_the_limit(gh):
    """places explicit pull requests past the lookup limit

    The test that proves the per-branch fallback works is only meaningful if this
    holds. Verified by mutation: appending at the front instead leaves every
    fallback test passing without the fallback ever running.
    """
    gh.many_prs(200, gh.pr("late", "abc123"))
    rows = pr_list("--state", "merged", "--base", "main", "--limit", "200", "--json", "headRefName")
    assert "late" not in [row["headRefName"] for row in rows]


def test_a_past_the_limit_pull_is_still_reachable_by_branch(gh):
    """still reaches a past-the-limit pull request by branch"""
    gh.many_prs(200, gh.pr("late", "abc123"))
    rows = pr_list(
        "--state",
        "merged",
        "--base",
        "main",
        "--head",
        "late",
        "--limit",
        "100",
        "--json",
        "headRefName",
    )
    assert [row["headRefName"] for row in rows] == ["late"]


def test_the_stub_rejects_a_flag_it_does_not_emulate(gh):
    """rejects a flag it does not emulate, rather than ignoring it

    Silently accepting an unknown filter would let tests pass against a query the
    real gh answers differently.
    """
    status, _, stderr = run_gh("pr", "list", "--state", "merged", "--author", "someone")
    assert status == 64
    assert "unhandled flag" in stderr


def test_the_stub_can_fail_only_the_per_branch_query(gh, monkeypatch):
    """can fail only the per-branch query"""
    monkeypatch.setenv("GH_FIXTURE_FAIL_HEAD", "1")
    status, _, stderr = run_gh(
        "pr", "list", "--state", "merged", "--base", "main", "--head", "x", "--limit", "5"
    )
    assert status != 0
    assert "simulated per-branch failure" in stderr


def test_the_stub_delays_its_answer_on_demand(gh, monkeypatch):
    """The knob a caller that measures its own elapsed time is told apart by."""
    gh.write_prs(gh.dep_pr(1))
    monkeypatch.setenv("GH_FIXTURE_DELAY", "1")
    started = time.monotonic()
    status, _, _ = run_gh("pr", "view", "1", "--json", "number")
    assert status == 0
    assert time.monotonic() - started >= 1


def test_the_stub_fails_on_demand(gh, monkeypatch):
    """fails on demand, to exercise the degraded path"""
    monkeypatch.setenv("GH_FIXTURE_FAIL", "1")
    status, _, stderr = run_gh("pr", "list", "--state", "merged")
    assert status != 0
    assert "simulated failure" in stderr


@pytest.mark.skipif(shutil.which("jq") is None, reason="jq is not installed")
def test_the_stub_applies_jq_when_asked(gh):
    """--jq still goes through real jq, for a caller that uses it."""
    gh.write_prs(gh.pr("mine", "abc123"))
    status, stdout, _ = run_gh(
        "pr",
        "list",
        "--state",
        "merged",
        "--base",
        "main",
        "--json",
        "headRefName",
        "--jq",
        ".[].headRefName",
    )
    assert status == 0
    assert stdout.strip() == "mine"


# --- dep_pr -------------------------------------------------------------------


def test_dep_pr_produces_the_check_shapes_it_names(gh):
    """produces the check shapes it names, as the stub reads them

    Every arm of the fold gets a fixture: a single expression scores as covered
    whichever branch is wrong.
    """
    shapes = [
        "passed",
        "failed",
        "pending",
        "none",
        "status-failed",
        "mixed",
        "neutral",
        "cancelled",
        "null-conclusion",
        "status-pending",
        "status-passed",
    ]
    gh.write_prs(*[gh.dep_pr(n, checks=shape) for n, shape in enumerate(shapes, start=1)])
    codes = [run_gh("pr", "checks", str(n))[0] for n in range(1, len(shapes) + 1)]
    assert codes == [0, 1, 8, 0, 1, 1, 0, 1, 1, 8, 0]


def test_dep_pr_defaults(gh):
    """defaults to an open, auto-merge, Dependabot pull request with no risk label"""
    pull = gh.dep_pr(7)
    assert pull["state"] == "OPEN"
    assert pull["autoMergeRequest"] == {"mergeMethod": "MERGE"}
    assert pull["author"]["login"] == "app/dependabot"
    assert "merge-risk" not in json.dumps(pull)
    # "" is what gh answers for a repository that requires no review, and it is
    # the state `settle` must keep waiting through rather than read as a block.
    assert pull["reviewDecision"] == ""


def test_dep_pr_honours_every_key(gh):
    """honours every key and rejects one it does not know"""
    pull = gh.dep_pr(
        8,
        state="MERGED",
        merge="DIRTY",
        auto=False,
        bot=False,
        draft=True,
        review="REVIEW_REQUIRED",
        risk="high",
        created="2020-01-01T00:00:00Z",
        head="abc",
    )
    assert pull["state"] == "MERGED"
    assert pull["mergeStateStatus"] == "DIRTY"
    assert pull["autoMergeRequest"] is None
    assert pull["author"]["is_bot"] is False
    assert pull["isDraft"] is True
    assert pull["reviewDecision"] == "REVIEW_REQUIRED"
    assert {"name": "merge-risk:high"} in pull["labels"]
    assert pull["createdAt"] == "2020-01-01T00:00:00Z"
    assert pull["headRefOid"] == "abc"
    assert pull["mergeCommit"] == {"oid": "merged8"}


def test_dep_pr_rejects_an_unknown_key(gh):
    """rejects a key it does not know rather than ignoring it"""
    with pytest.raises(ValueError, match="unknown key colour=blue"):
        gh.dep_pr(9, colour="blue")


# --- gh stub mutations --------------------------------------------------------


def test_the_stub_rewrites_the_head_and_records_comments(gh):
    """rewrites the head on update-branch and records comments"""
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    assert run_gh("pr", "update-branch", "1", "--rebase")[0] == 0
    assert run_gh("pr", "comment", "1", "--body", "hello")[0] == 0
    pull = json.loads(gh.prs_file.read_text())[0]
    assert pull["headRefOid"] == "rebased-sha1"
    assert pull["mergeStateStatus"] == "BLOCKED"
    assert "hello" in (gh.path / "prs.json.comments").read_text()


def test_the_stub_fails_an_unknown_pull_request_number(gh):
    """fails an unknown pull request number the way gh does"""
    status, _, stderr = run_gh("pr", "view", "42", "--json", "number")
    assert status == 1
    assert "Could not resolve to a PullRequest" in stderr
