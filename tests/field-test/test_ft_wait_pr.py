"""Black-box tests for ft-wait-pr.py.

Ported from `spec/field-test/wait_pr_spec.sh`. One example per arm of
`lib/checks.py`, plus the loop around it. A wrong arm here is a loop that waits
forever on a run that already ended, or a merge on an answer that never arrived.

The waits are real seconds, so every example runs with `--interval 1` and a
timeout of one or five, the way the specs did. "requires jq" did not come
across; there is no jq to require.
"""

from __future__ import annotations

import os

import pytest
from conftest import FT_WAIT_PR

pytestmark = pytest.mark.usefixtures("ft_sandbox")

REPO = "acme-org/plugins"


@pytest.fixture
def wait(run_script):
    """One bounded wait, with the short timings every example uses."""

    def run(number, timeout=1, interval=1, repo=REPO):
        return run_script(FT_WAIT_PR, repo, number, "--timeout", timeout, "--interval", interval)

    return run


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_WAIT_PR, "--help")
    assert result.status == 0
    assert "ft-wait-pr.py <repo> <pr>" in result.stdout


def test_exits_2_with_usage_when_given_nothing(run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_WAIT_PR)
    assert result.status == 2
    assert "ft-wait-pr.py <repo> <pr>" in result.stderr


def test_exits_2_with_usage_when_given_only_a_repository(run_script):
    """a repository with no pull request is the same usage error"""
    result = run_script(FT_WAIT_PR, REPO)
    assert result.status == 2
    assert "ft-wait-pr.py <repo> <pr>" in result.stderr


def test_rejects_a_repository_that_is_not_owner_name(run_script):
    """rejects a repository that is not owner/name"""
    result = run_script(FT_WAIT_PR, "plugins", "50")
    assert result.status == 2
    assert "owner/name" in result.stderr


def test_rejects_a_pull_request_that_is_not_a_number(run_script):
    """rejects a pull request that is not a number"""
    result = run_script(FT_WAIT_PR, REPO, "fifty")
    assert result.status == 2
    assert "must be a number" in result.stderr


def test_rejects_an_unknown_argument(run_script):
    """rejects an unknown argument"""
    result = run_script(FT_WAIT_PR, REPO, "50", "--forever")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_rejects_a_timeout_that_is_not_a_number(run_script):
    """rejects a timeout that is not a number"""
    result = run_script(FT_WAIT_PR, REPO, "50", "--timeout", "soon")
    assert result.status == 2
    assert "--timeout needs a number" in result.stderr


def test_refuses_an_interval_of_zero(run_script):
    """refuses an interval of zero, which would spin without ever timing out"""
    result = run_script(FT_WAIT_PR, REPO, "50", "--interval", "0")
    assert result.status == 2
    assert "from 1" in result.stderr


# --- the answer, one per arm of the fold -------------------------------------


def test_says_merged_without_waiting(wait):
    """says merged for a merged pull request, without waiting"""
    result = wait(54)
    assert result.status == 0
    assert result.stdout == "merged\n"


def test_says_failed_for_a_pull_request_closed_without_merging(wait):
    """says failed for a pull request closed without merging"""
    result = wait(55)
    assert result.status == 1
    assert result.stdout == "failed\n"


def test_says_passed_when_every_check_is_green_or_skipped(wait):
    """says passed when every check is green or skipped"""
    result = wait(50)
    assert result.status == 0
    assert result.stdout == "passed\n"


def test_says_failed_on_a_failing_check(wait):
    """says failed on a failing check"""
    result = wait(51)
    assert result.status == 1
    assert result.stdout == "failed\n"


def test_says_failed_on_a_commit_status_in_failure(wait):
    """says failed on a commit status in FAILURE, the shape external CI reports in"""
    result = wait(59)
    assert result.status == 1
    assert result.stdout == "failed\n"


def test_says_failed_at_once_when_one_check_failed_while_another_runs(wait):
    """says failed at once when one check failed while another is still running"""
    result = wait(60)
    assert result.status == 1
    assert result.stdout == "failed\n"


def test_says_failed_on_a_cancelled_run(wait):
    """says failed on a cancelled run rather than waiting for it forever"""
    result = wait(57)
    assert result.status == 1
    assert result.stdout == "failed\n"


def test_gives_up_with_pending_when_the_checks_are_still_running(wait):
    """gives up with pending when the checks are still running"""
    result = wait(52)
    assert result.status == 3
    assert result.stdout == "pending\n"


def test_treats_a_completed_run_with_no_conclusion_as_pending(wait):
    """treats a completed run with no conclusion as pending, not as a pass"""
    result = wait(56)
    assert result.status == 3
    assert result.stdout == "pending\n"


def test_says_passed_for_a_pull_request_with_no_checks_once_it_looked_twice(wait):
    """says passed for a pull request with no checks, once it has looked twice"""
    result = wait(53, timeout=5)
    assert result.status == 0
    assert result.stdout == "passed\n"


def test_keeps_polling_until_a_run_that_was_in_progress_goes_green(wait):
    """keeps polling until a run that was in progress goes green"""
    result = wait(58, timeout=5)
    assert result.status == 0
    assert result.stdout == "passed\n"


def test_does_not_call_one_empty_look_a_pass_when_a_run_turns_up(wait):
    """does not call one look with no checks a pass when a run turns up on the next"""
    result = wait(61)
    assert result.status == 3
    assert result.stdout == "pending\n"


# --- when gh cannot answer ---------------------------------------------------


def test_exits_5_for_a_pull_request_that_does_not_exist(wait):
    """exits 5 for a pull request GitHub says is not there, not the retryable 4

    Its own status because it is the one failure waiting cannot cure: the caller
    has the wrong number or the wrong repository, and the skill's exit-4 branch
    would spend a wake and a second look finding that out again.
    """
    result = wait(999)
    assert result.status == 5
    assert "no pull request 999" in result.stderr
    assert "Could not resolve to a PullRequest" in result.stderr


def test_exits_4_for_a_state_it_cannot_read_rather_than_calling_it_passed(wait):
    """a state outside OPEN, MERGED and CLOSED is an answer nobody here can read

    With no checks in the rollup it would otherwise fall past the state arms and
    be reported `passed`, which the skill merges on.
    """
    result = wait(62, timeout=5)
    assert result.status == 4
    assert "state this cannot read for pull request 62" in result.stderr
    assert "LOCKED" in result.stderr
    assert result.stdout == ""


def test_exits_4_when_gh_never_answers(ft_sandbox, wait):
    """a gh that hangs is bounded by the wait's own budget, not left to the caller"""
    slow = ft_sandbox.path / "gh-slow"
    slow.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
    os.chmod(slow, 0o755)
    ft_sandbox.setenv("FT_GH", slow)
    result = wait(50)
    assert result.status == 4
    assert "did not answer within" in result.stderr


def test_exits_4_when_gh_itself_fails_with_its_message(ft_sandbox, wait):
    """exits 4 when gh itself fails, with its message"""
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = wait(50)
    assert result.status == 4
    assert "simulated failure" in result.stderr


def test_exits_4_when_gh_answers_with_something_unreadable(ft_sandbox, wait):
    """exits 4 when gh answers with something unreadable, showing what it said"""
    garbage = ft_sandbox.path / "gh-garbage"
    garbage.write_text('#!/bin/sh\necho "warning: not json"\n', encoding="utf-8")
    os.chmod(garbage, 0o755)
    ft_sandbox.setenv("FT_GH", garbage)
    result = wait(50)
    assert result.status == 4
    assert "cannot read for pull request 50" in result.stderr
    assert "not json" in result.stderr


def test_exits_4_when_gh_cannot_be_run_at_all(ft_sandbox, wait):
    """a gh that is not on PATH is a wait that answers nothing, not one that hangs"""
    ft_sandbox.setenv("FT_GH", ft_sandbox.path / "no-such-gh")
    result = wait(50)
    assert result.status == 4
    assert "cannot read pull request 50" in result.stderr


def test_a_reader_that_closed_early_is_not_a_failure(run_with_no_reader):
    """`ft-wait-pr.py ... | head` is the caller's business, not a failure here."""
    completed = run_with_no_reader(FT_WAIT_PR, REPO, "54", "--timeout", "1", "--interval", "1")
    assert completed.returncode == 0
    assert completed.stderr == b""
