"""Black-box tests for `gh-shepherd-pr.py`.

The port of `spec/gh/shepherd_pr_spec.sh`: one named test per example that spec
held, plus the cases the shell version had no way to reach -- the single-byte
locale, the reader that closed the pipe, and the `gh is required` preflight. Every run is
against a real git repository built by the `gh` fixture, never a mocked git.

Dependabot answers `recreate` asynchronously, so the examples that need an
answer mid-poll schedule it on a background thread gated on something the script
under test has observably done -- the comment file appearing, or a `pr checks`
call reaching the log -- rather than on a bare sleep that loses the race on a
loaded machine. `after_file` and `after_call` are the port of the spec helpers
of the same names.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time

import pytest
from conftest import SHEPHERD_PR

# Past every bound these tests set, so a timeout only ever follows a failure.
GATE_TIMEOUT = 10.0


def document(result):
    """The one JSON object the script prints."""
    return json.loads(result.stdout)


def comments(gh):
    """What was posted, or NONE, so "nothing posted" is a positive assertion."""
    path = gh.path / "prs.json.comments"
    return path.read_text() if path.exists() else "NONE"


def head_of(gh, number=1):
    for pull in json.loads((gh.path / "prs.json").read_text()):
        if pull["number"] == number:
            return pull["headRefOid"]
    return None


def set_pr(gh, mutate, number=1):
    """Apply `mutate` to one pull request in the canned set, atomically.

    A partial write would be read by the very poll this exists to answer.
    """
    path = gh.path / "prs.json"
    rows = json.loads(path.read_text())
    for row in rows:
        if row["number"] == number:
            mutate(row)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(rows))
    os.replace(temporary, path)


def _background(gate, action):
    def wait():
        deadline = time.time() + GATE_TIMEOUT
        while not gate():
            if time.time() > deadline:
                return
            time.sleep(0.05)
        action()

    thread = threading.Thread(target=wait, daemon=True)
    thread.start()
    return thread


def after_comment(gh, action):
    """Run `action` once the recreate comment has been posted.

    The stub writes the comments file the moment the comment posts, so a
    mutation gated on it cannot land before the script captured the pre-comment
    head.
    """
    path = gh.path / "prs.json.comments"
    return _background(path.exists, action)


def after_call(log, pattern, action):
    """Run `action` once the gh call log holds an invocation matching `pattern`."""

    def seen():
        try:
            return pattern in log.read_text()
        except OSError:
            return False

    return _background(seen, action)


@pytest.fixture
def call_log(gh, monkeypatch):
    path = gh.path / "calls.log"
    monkeypatch.setenv("GH_FIXTURE_CALL_LOG", str(path))
    return path


@pytest.fixture
def fast_poll(monkeypatch):
    """A recreate poll that answers in seconds rather than in a CI cycle."""
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "4")
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")


# --- preflight ----------------------------------------------------------------


def test_prints_usage_with_too_few_arguments(gh, shepherd_pr):
    result = shepherd_pr(gh.repo, 1)
    assert result.status == 2
    assert "Usage:" in result.stderr


def test_prints_usage_for_help(gh, shepherd_pr):
    result = shepherd_pr("--help")
    assert result.status == 0
    assert "Usage:" in result.stdout


def test_rejects_a_non_numeric_pull_request_number(gh, shepherd_pr):
    result = shepherd_pr(gh.repo, "abc", "state")
    assert result.status == 2
    assert "not a pull request number" in result.stderr


def test_rejects_a_path_that_is_not_a_directory(gh, shepherd_pr):
    result = shepherd_pr(gh.path / "nope", 1, "state")
    assert result.status == 2
    assert "not a directory" in result.stderr


def test_rejects_a_directory_that_is_not_a_git_repository(gh, shepherd_pr):
    plain = gh.path / "plain"
    plain.mkdir()
    result = shepherd_pr(plain, 1, "state")
    assert result.status == 2
    assert "not a git repository" in result.stderr


def test_rejects_an_unknown_action(gh, shepherd_pr):
    result = shepherd_pr(gh.repo, 1, "dance")
    assert result.status == 2
    assert "unknown action: dance" in result.stderr


def test_fails_closed_when_gh_cannot_resolve_the_repository(gh, shepherd_pr, monkeypatch):
    monkeypatch.setenv("GH_FIXTURE_FAIL", "1")
    result = shepherd_pr(gh.repo, 1, "state")
    assert result.status == 1
    assert "could not resolve the repository with gh: gh: simulated failure" in result.stderr


def test_refuses_to_run_without_its_library(gh, run_script):
    lonely = gh.path / "lonely"
    lonely.mkdir()
    copy = lonely / SHEPHERD_PR.name
    shutil.copy(SHEPHERD_PR, copy)
    result = run_script(copy, gh.repo, 1, "state")
    assert result.status == 2
    assert "missing" in result.stderr


def test_reports_gh_missing_rather_than_acting(gh, shepherd_pr, sandbox):
    """Not in the spec: the shell version's `command -v gh` guard, ported."""
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "gh is required" in result.stderr


# --- state and merged ---------------------------------------------------------


def test_reports_a_pull_request_as_the_loop_sees_it(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    result = shepherd_pr(gh.repo, 1, "state")
    assert result.status == 0
    report = document(result)
    assert report["ok"] is True
    assert report["pr"]["mergeStateStatus"] == "BEHIND"
    assert report["pr"]["is_bot"] is True


def test_reports_ok_false_exit_0_for_a_pull_request_it_cannot_read(gh, shepherd_pr):
    result = shepherd_pr(gh.repo, 99, "state")
    assert result.status == 0
    report = document(result)
    assert report["ok"] is False
    assert "could not read pull request #99" in report["detail"]
    assert "Could not resolve to a PullRequest" in report["detail"]


def test_reports_a_merge_and_its_commit(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, state="MERGED"))
    report = document(shepherd_pr(gh.repo, 1, "merged"))
    assert report["merged"] is True
    assert report["mergeCommit"] == "merged1"


def test_reports_an_unmerged_pull_request_as_not_merged(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1))
    report = document(shepherd_pr(gh.repo, 1, "merged"))
    assert report["merged"] is False
    assert report["detail"] == "not merged: OPEN"


def test_reports_merged_as_unreadable_when_the_pull_request_is_unknown(gh, shepherd_pr):
    assert document(shepherd_pr(gh.repo, 99, "merged"))["ok"] is False


# --- rebase -------------------------------------------------------------------


def test_rebases_an_open_pull_request_and_reports_both_heads(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["ok"] is True
    assert report["before"] == "sha1"
    assert report["after"] == "rebased-sha1"
    assert head_of(gh) == "rebased-sha1"


def test_refuses_to_rebase_a_pull_request_that_is_not_open_and_changes_nothing(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, state="MERGED"))
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["ok"] is False
    assert "refused: pull request is MERGED" in report["detail"]
    assert head_of(gh) == "sha1"


def test_reports_a_failed_rebase_without_claiming_a_new_head(gh, shepherd_pr, monkeypatch):
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("GH_FIXTURE_FAIL_REBASE", "1")
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["ok"] is False
    assert "rebase failed" in report["detail"]
    assert "merge conflict" in report["detail"]
    assert "after" not in report


def test_reports_the_head_as_unmoved_when_update_branch_has_only_been_queued(
    gh, shepherd_pr, monkeypatch
):
    """`gh pr update-branch` returns as soon as GitHub accepts the request.

    Called "rebased" this tells the caller a new CI run is coming when the head
    is still the one whose checks it has already seen.
    """
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    monkeypatch.setenv("GH_FIXTURE_REBASE_ASYNC", "1")
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["ok"] is True
    assert report["before"] == report["after"] == "sha1"
    assert "the head has not moved" in report["detail"]
    assert "branch has been updated" in report["output"]


def test_reports_the_head_as_unmoved_when_the_branch_was_already_up_to_date(
    gh, shepherd_pr, monkeypatch
):
    """The other exit-0 answer that moves nothing, and it says so in the output."""
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    monkeypatch.setenv("GH_FIXTURE_REBASE_UPTODATE", "1")
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["ok"] is True
    assert report["after"] == "sha1"
    assert "already up-to-date" in report["output"]


def test_carries_ghs_own_words_on_a_rebase_that_worked(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    report = document(shepherd_pr(gh.repo, 1, "rebase"))
    assert report["detail"] == "rebased"
    assert "branch has been updated" in report["output"]


def test_does_not_call_update_branch_for_an_unknown_pull_request(gh, shepherd_pr, call_log):
    report = document(shepherd_pr(gh.repo, 99, "rebase"))
    assert report["ok"] is False
    assert "update-branch" not in call_log.read_text()


# --- recreate -----------------------------------------------------------------


def test_refuses_on_a_pull_request_dependabot_did_not_author_and_posts_nothing(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, merge="DIRTY", bot=False))
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "not authored by Dependabot" in report["detail"]
    assert comments(gh) == "NONE"


def test_refuses_recreate_for_a_bot_that_is_not_dependabot_and_posts_nothing(
    gh, shepherd_pr, fast_poll
):
    """renovate opens dependency pull requests too, and answers no recreate comment.

    `is_bot` still reports what it is, so the loop can say why it stopped; what
    the action turns on is `is_dependabot`. `fast_poll` is not needed for the
    refusal, which is immediate; it is there so that a version of this that
    stopped refusing fails in seconds rather than polling for two CI cycles.
    """
    pull = gh.dep_pr(1, merge="DIRTY")
    pull["author"] = {"login": "renovate[bot]", "is_bot": True}
    gh.write_prs(pull)
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "not authored by Dependabot" in report["detail"]
    assert report["pr"]["is_bot"] is True
    assert report["pr"]["is_dependabot"] is False
    assert comments(gh) == "NONE"


def test_refuses_recreate_on_a_pull_request_that_is_not_open(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, state="CLOSED"))
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert "refused: pull request is CLOSED" in report["detail"]
    assert comments(gh) == "NONE"


def test_comments_and_returns_once_the_head_moves(gh, shepherd_pr, fast_poll):
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    # Dependabot's answer, arriving after the comment: a new head.
    after_comment(gh, lambda: set_pr(gh, lambda row: row.update(headRefOid="recreated")))
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is True
    assert report["after"] == "recreated"
    assert report["pr"]["headRefOid"] == "recreated"
    assert "@dependabot recreate" in comments(gh)


def test_reports_recreated_not_merged_when_the_head_moved_and_the_merge_landed_together(
    gh, shepherd_pr, fast_poll
):
    """A recreated branch that went green and auto-merged before the next poll.

    The moved head must win over the state change: this is the success path.
    """
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    after_comment(
        gh, lambda: set_pr(gh, lambda row: row.update(headRefOid="recreated", state="MERGED"))
    )
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["detail"] == "recreated"
    assert "result" not in report


def test_returns_early_when_the_pull_request_is_closed_with_the_head_unmoved(
    gh, shepherd_pr, fast_poll
):
    """Dependabot's usual answer when another pull request already shipped the bump."""
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    after_comment(gh, lambda: set_pr(gh, lambda row: row.update(state="CLOSED")))
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is True
    assert report["result"] == "closed"
    assert "closed while waiting for recreate" in report["detail"]
    assert report["before"] == "sha1"
    assert report["pr"]["state"] == "CLOSED"
    assert "@dependabot recreate" in comments(gh)


def test_returns_early_when_the_pull_request_is_merged_with_the_head_unmoved(
    gh, shepherd_pr, fast_poll
):
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    after_comment(
        gh, lambda: set_pr(gh, lambda row: row.update(state="MERGED", mergeCommit={"oid": "m1"}))
    )
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is True
    assert report["result"] == "merged"
    assert "merged while waiting for recreate" in report["detail"]
    assert report["pr"]["mergeCommit"] == "m1"
    assert "@dependabot recreate" in comments(gh)


def test_keeps_polling_when_gh_cannot_read_the_pull_request_for_one_poll(
    gh, shepherd_pr, fast_poll
):
    """One poll sees no pull request at all (gh errored); a later one sees it closed."""
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    path = gh.path / "prs.json"
    keep = json.loads(path.read_text())
    keep[0]["state"] = "CLOSED"

    def blink():
        path.unlink()
        time.sleep(2)
        path.write_text(json.dumps(keep))

    after_comment(gh, blink)
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is True
    assert report["result"] == "closed"
    assert report["pr"]["state"] == "CLOSED"


def test_says_the_pull_request_could_not_be_re_read_rather_than_that_the_head_did_not_move(
    gh, shepherd_pr, monkeypatch
):
    """The comment posts against a readable pull request; then every poll fails."""
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "1")
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")
    after_comment(gh, (gh.path / "prs.json").unlink)
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "could not be re-read in 2s (2 attempts)" in report["detail"]
    assert "Could not resolve to a PullRequest" in report["detail"]
    assert report["read_failures"] == 2
    assert "head did not change" not in report["detail"]


def test_gives_up_after_two_ci_cycles_when_the_head_never_moves(gh, shepherd_pr, monkeypatch):
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "1")
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "head did not change within 2s" in report["detail"]
    assert report["read_failures"] == 0
    assert report["pr"]["state"] == "OPEN"
    assert "@dependabot recreate" in comments(gh)


def test_polls_at_least_once_when_the_ci_estimate_is_zero(gh, shepherd_pr, monkeypatch):
    """A bound of twice zero would comment and then report a read never attempted.

    The comment is a write, so a bound that cannot hold a single poll must not be
    reachable: the loop is floored at one interval instead.
    """
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "0")
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "head did not change within 1s" in report["detail"]
    assert report["read_failures"] == 0
    assert "could not be re-read" not in report["detail"]
    assert "@dependabot recreate" in comments(gh)


# --- wait ---------------------------------------------------------------------


def test_answers_merged_without_watching_when_the_pull_request_has_merged(
    gh, shepherd_pr, call_log
):
    gh.write_prs(gh.dep_pr(1, state="MERGED"))
    assert document(shepherd_pr(gh.repo, 1, "wait"))["result"] == "merged"
    assert "checks" not in call_log.read_text()


def test_answers_passed_without_watching_when_nothing_reported_a_check(gh, shepherd_pr, call_log):
    gh.write_prs(gh.dep_pr(1, checks="none"))
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "passed"
    assert "no checks reported" in report["detail"]
    assert "checks" not in call_log.read_text()


def test_answers_passed_from_a_green_rollup(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, checks="passed"))
    assert document(shepherd_pr(gh.repo, 1, "wait"))["result"] == "passed"


def test_answers_failed_from_a_red_rollup_naming_the_check_and_carrying_the_log_tail(
    gh, shepherd_pr, monkeypatch
):
    gh.write_prs(gh.dep_pr(1, checks="failed"))
    log = gh.path / "log.txt"
    log.write_text("line 1\nline 2\nline 3\n")
    monkeypatch.setenv("GH_FIXTURE_RUN_LOG", str(log))
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "failed"
    assert report["pr"]["checks"]["failing"][0]["name"] == "build"
    assert "line 3" in report["log_tail"]


def test_keeps_only_the_requested_number_of_log_lines(gh, shepherd_pr, monkeypatch):
    gh.write_prs(gh.dep_pr(1, checks="failed"))
    log = gh.path / "log.txt"
    log.write_text("line 1\nline 2\nline 3\n")
    monkeypatch.setenv("GH_FIXTURE_RUN_LOG", str(log))
    monkeypatch.setenv("SHEPHERD_LOG_LINES", "2")
    assert document(shepherd_pr(gh.repo, 1, "wait"))["log_tail"] == "line 2\nline 3"


def test_fetches_the_log_of_the_actions_job_behind_a_failing_status_context(
    gh, shepherd_pr, monkeypatch, call_log
):
    """A StatusContext links to its own service, not to a run whose log gh has.

    One ahead of a failing Actions job in the same rollup must not end the
    search, or the agent classifies the failure with no log at all.
    """
    gh.write_prs(gh.dep_pr(1, checks="status-then-job-failed"))
    log = gh.path / "log.txt"
    log.write_text("the failing step\n")
    monkeypatch.setenv("GH_FIXTURE_RUN_LOG", str(log))
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "failed"
    assert [check["name"] for check in report["pr"]["checks"]["failing"]] == ["ci/legacy", "build"]
    assert report["log_tail"] == "the failing step"
    assert "log_error" not in report
    assert "run view" in call_log.read_text()


def test_answers_failed_with_an_empty_log_when_the_failing_check_is_not_an_actions_job(
    gh, shepherd_pr, call_log
):
    gh.write_prs(gh.dep_pr(1, checks="status-failed"))
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "failed"
    assert report["log_tail"] == ""
    assert "run view" not in call_log.read_text()


def test_watches_while_checks_are_pending_and_reports_pending_when_its_bound_is_hit(
    gh, shepherd_pr, call_log, monkeypatch
):
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("GH_FIXTURE_WATCH_HANG", "1")
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "1")
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "pending"
    assert report["bound"] == 1
    assert report["watcher_rc"] == 124
    assert "checks 1" in call_log.read_text()


def test_does_not_watch_a_rollup_that_has_already_failed(gh, shepherd_pr, call_log, monkeypatch):
    """`gh pr checks --watch` has been seen not to return on a terminal rollup.

    A watcher that hangs here would turn an answer the pull request already
    carries into a bound-length wait, so the failure is read from the rollup and
    no watcher is started at all.
    """
    gh.write_prs(gh.dep_pr(1, checks="failed"))
    monkeypatch.setenv("GH_FIXTURE_WATCH_HANG", "1")
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "failed"
    assert "--watch" not in call_log.read_text()


def test_clamps_the_wait_bound_so_one_call_fits_inside_a_tool_call(gh, shepherd_pr, monkeypatch):
    """Twice a slow repository's CI cycle is longer than the caller can wait."""
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "1000")
    monkeypatch.delenv("SHEPHERD_WAIT_BOUND", raising=False)
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "pending"
    assert report["bound"] == 540


def test_reports_the_time_actually_spent_rather_than_the_bound(gh, shepherd_pr, monkeypatch):
    """A watcher that returned at once did not wait the bound out."""
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "300")
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "pending"
    assert report["bound"] == 300
    assert report["waited"] < 300
    assert f"after {report['waited']}s" in report["detail"]


def test_reports_the_rollup_not_the_watcher_once_the_watcher_returns(gh, shepherd_pr, monkeypatch):
    """The watcher returns at once and the rollup still says pending.

    That is what a check that finished between two reads looks like from the
    wrong side. The answer is pending, and the caller asks again.
    """
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "5")
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "pending"
    assert report["watcher_rc"] == 8


def test_reports_merged_when_auto_merge_fires_during_the_watch(
    gh, shepherd_pr, call_log, monkeypatch
):
    """The merge must land while the watcher is running, not before the first read.

    Otherwise the example passes through the answers-without-watching path.
    """
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("GH_FIXTURE_WATCH_HANG", "1")
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "2")
    after_call(
        call_log,
        "pr checks",
        lambda: set_pr(gh, lambda row: row.update(state="MERGED", mergeCommit={"oid": "m1"})),
    )
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["result"] == "merged"
    assert "checks 1" in call_log.read_text()


def test_wait_reports_ok_false_when_the_pull_request_cannot_be_read(gh, shepherd_pr):
    assert document(shepherd_pr(gh.repo, 99, "wait"))["ok"] is False


# --- skip ---------------------------------------------------------------------


def test_posts_the_reason_and_reports_the_comment_url(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1))
    reason = gh.path / "reason.md"
    reason.write_text("Skipping: the failing test asserts behaviour, not a mechanical fix.\n")
    report = document(shepherd_pr(gh.repo, 1, "skip", reason))
    assert report["ok"] is True
    assert report["comment_url"] == "https://github.com/acme/widgets/pull/1#issuecomment-1"
    assert "not a mechanical fix" in comments(gh)


def test_refuses_an_empty_reason_and_posts_nothing(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1))
    empty = gh.path / "empty.md"
    empty.write_text("")
    report = document(shepherd_pr(gh.repo, 1, "skip", empty))
    assert report["ok"] is False
    assert "reason file is missing or empty" in report["detail"]
    assert comments(gh) == "NONE"


def test_is_a_usage_error_without_a_reason_file(gh, shepherd_pr):
    result = shepherd_pr(gh.repo, 1, "skip")
    assert result.status == 2
    assert "skip needs a reason file" in result.stderr


def test_is_a_usage_error_with_an_empty_reason_file_argument(gh, shepherd_pr):
    """`skip ""` is a caller that lost its variable, which is what the shell said.

    Not an `ok:false` document: the argument is missing, not the file, and the
    two call for different fixes.
    """
    gh.write_prs(gh.dep_pr(1))
    result = shepherd_pr(gh.repo, 1, "skip", "")
    assert result.status == 2
    assert "skip needs a reason file" in result.stderr
    assert result.stdout == ""
    assert comments(gh) == "NONE"


def test_refuses_to_comment_on_a_pull_request_that_is_not_open(gh, shepherd_pr):
    gh.write_prs(gh.dep_pr(1, state="MERGED"))
    reason = gh.path / "reason.md"
    reason.write_text("reason\n")
    report = document(shepherd_pr(gh.repo, 1, "skip", reason))
    assert "refused: pull request is MERGED" in report["detail"]
    assert comments(gh) == "NONE"


def test_skip_reports_ok_false_when_the_pull_request_cannot_be_read(gh, shepherd_pr):
    reason = gh.path / "reason.md"
    reason.write_text("reason\n")
    report = document(shepherd_pr(gh.repo, 99, "skip", reason))
    assert report["ok"] is False
    assert comments(gh) == "NONE"


# --- an answer gh gave without the fields the loop reads -----------------------


def test_refuses_a_pull_request_gh_answered_without_the_fields_the_loop_reads(
    gh, shepherd_pr, call_log
):
    """The regression: an answer carrying only `number` used to become `passed`.

    `summary` shapes whatever it is handed, so a projection missing everything
    else came back as a pull request with no checks -- which `wait` reads as
    nothing left to watch.
    """
    (gh.path / "prs.json").write_text(json.dumps([{"number": 7}]))
    report = document(shepherd_pr(gh.repo, 7, "wait"))
    assert report["ok"] is False
    assert "gh answered without state" in report["detail"]
    assert "result" not in report
    assert "--watch" not in call_log.read_text()


def test_reads_a_rollup_holding_a_null_row_rather_than_dying_on_it(gh, shepherd_pr):
    """GraphQL can answer with a null element; it used to be an exit-1 traceback."""
    pull = gh.dep_pr(1, checks="pending")
    pull["statusCheckRollup"] = [None]
    gh.write_prs(pull)
    result = shepherd_pr(gh.repo, 1, "state")
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert document(result)["pr"]["checks"]["state"] == "pending"


# --- environment overrides that were not used ----------------------------------


def test_says_so_when_a_wait_bound_override_is_not_a_number(gh, shepherd_pr, monkeypatch):
    """A bound nobody meant to use would otherwise decide the whole run in silence."""
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "abc")
    result = shepherd_pr(gh.repo, 1, "wait")
    assert result.status == 0
    assert "SHEPHERD_WAIT_BOUND=abc ignored; using 540" in result.stderr
    assert document(result)["bound"] == 540


def test_says_so_when_a_log_line_count_override_is_not_a_number(gh, shepherd_pr, monkeypatch):
    gh.write_prs(gh.dep_pr(1))
    monkeypatch.setenv("SHEPHERD_LOG_LINES", "lots")
    result = shepherd_pr(gh.repo, 1, "state")
    assert result.status == 0
    assert "SHEPHERD_LOG_LINES=lots ignored; using 60" in result.stderr


def test_says_nothing_when_no_override_was_given(gh, shepherd_pr, monkeypatch):
    """Only a value that was set and not used is worth a line."""
    gh.write_prs(gh.dep_pr(1))
    monkeypatch.delenv("SHEPHERD_LOG_LINES", raising=False)
    monkeypatch.delenv("SHEPHERD_CI_SECONDS", raising=False)
    assert shepherd_pr(gh.repo, 1, "state").stderr == ""


# --- streams ------------------------------------------------------------------


def test_survives_a_single_byte_locale(gh, shepherd_pr):
    """Not in the spec. Two earlier ports lost time to non-ASCII output dying here."""
    pull = gh.dep_pr(1)
    pull["title"] = "build(deps): bump café — 1.0.0"
    gh.write_prs(pull)
    result = shepherd_pr(gh.repo, 1, "state", env={"PYTHONIOENCODING": "ascii", "LC_ALL": "C"})
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert document(result)["pr"]["title"] == "build(deps): bump café — 1.0.0"


def test_a_reader_that_left_stops_the_report_not_the_rebase(gh, run_with_closed_reader):
    """`gh-shepherd-pr.py <path> <n> rebase | head` with head already gone.

    The rebase is the state change, and it has to have happened: a run abandoned
    by a closed pipe would exit 0 with the branch never updated and nothing
    saying so.
    """
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    status, stderr = run_with_closed_reader(SHEPHERD_PR, gh.repo, 1, "rebase", unbuffered=True)
    assert status == 0
    assert "Traceback" not in stderr
    assert head_of(gh) == "rebased-sha1"


def test_a_reader_that_left_stops_the_report_not_the_skip_comment(gh, run_with_closed_reader):
    """The other write this script makes: the comment must still be posted.

    Buffered, unlike the rebase case above: a pipe is block buffered, so the one
    small report line reaches the pipe only at the final flush, and that is the
    other place a broken pipe lands. Both have to be silent and exit 0.
    """
    gh.write_prs(gh.dep_pr(1))
    reason = gh.path / "reason.md"
    reason.write_text("not mechanical\n")
    status, stderr = run_with_closed_reader(SHEPHERD_PR, gh.repo, 1, "skip", reason)
    assert status == 0
    assert "Traceback" not in stderr
    assert "not mechanical" in comments(gh)
