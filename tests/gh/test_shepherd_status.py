"""Black-box tests for `gh-shepherd-status.py`.

The port of `spec/gh/shepherd_status_spec.sh`: one named test per example that
spec held, plus the stream cases the shell version had no way to reach. The
per-arm tests for the fold these assertions read through are in
`test_shepherd_lib.py`.
"""

from __future__ import annotations

import json
import shutil
import time

from conftest import SHEPHERD_STATUS


def document(result):
    """The one JSON document the script prints."""
    return json.loads(result.stdout)


def target_numbers(result):
    return [target["number"] for target in document(result)["targets"]]


def skipped_numbers(result):
    return [row["number"] for row in document(result)["skipped_no_automerge"]]


def check_states(result):
    return {target["number"]: target["checks"]["state"] for target in document(result)["targets"]}


def write_runs(gh, monkeypatch, *specs):
    """`gh run list` rows from "<seconds>[:<branch>[:<status>]]" specs.

    The port of the spec's `runs` helper: each row's wall time is its updatedAt
    minus its createdAt, so a duration is expressed by moving the end stamp.
    """
    rows = []
    for spec in specs:
        parts = str(spec).split(":")
        seconds = int(parts[0])
        branch = parts[1] if len(parts) > 1 else "main"
        status = parts[2] if len(parts) > 2 else "completed"
        end = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(1767225600 + seconds))
        rows.append(
            {
                "headBranch": branch,
                "status": status,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": end,
            }
        )
    path = gh.path / "runs.json"
    path.write_text(json.dumps(rows))
    monkeypatch.setenv("GH_FIXTURE_RUNS", str(path))
    return path


# --- preflight ----------------------------------------------------------------


def test_rejects_a_path_that_is_not_a_directory(gh, shepherd_status):
    result = shepherd_status(gh.path / "nope")
    assert result.status == 2
    assert "not a directory" in result.stderr


def test_rejects_a_directory_that_is_not_a_git_repository(gh, shepherd_status):
    plain = gh.path / "plain"
    plain.mkdir()
    result = shepherd_status(plain)
    assert result.status == 2
    assert "not a git repository" in result.stderr


def test_prints_usage_for_help(gh, shepherd_status):
    result = shepherd_status("--help")
    assert result.status == 0
    assert "Usage:" in result.stdout


def test_fails_closed_when_gh_cannot_answer_for_the_repository(gh, shepherd_status, monkeypatch):
    monkeypatch.setenv("GH_FIXTURE_FAIL", "1")
    result = shepherd_status(gh.repo)
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr
    assert result.stdout == ""


def test_refuses_to_run_without_its_library(gh, run_script):
    """A copy of the script with no lib/ beside it is a wiring mistake, not a crash."""
    lonely = gh.path / "lonely"
    lonely.mkdir()
    copy = lonely / SHEPHERD_STATUS.name
    shutil.copy(SHEPHERD_STATUS, copy)
    result = run_script(copy, gh.repo)
    assert result.status == 2
    assert "missing" in result.stderr


def test_reports_gh_missing_rather_than_an_empty_repository(gh, shepherd_status, sandbox):
    """Not in the spec: the shell version's `command -v gh` guard, ported."""
    result = shepherd_status(gh.repo, env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "gh is required" in result.stderr


# --- target selection ---------------------------------------------------------


def test_reports_valid_json_with_the_repo_and_defaults_when_there_are_no_pull_requests(
    gh, shepherd_status
):
    result = shepherd_status(gh.repo)
    assert result.status == 0
    assert document(result) == {
        "repo": "acme/widgets",
        "default_branch": "main",
        "ci_seconds": 300,
        "targets": [],
        "skipped_no_automerge": [],
    }


def test_targets_only_open_non_draft_auto_merge_pull_requests_and_reports_the_rest(
    gh, shepherd_status
):
    gh.write_prs(
        gh.dep_pr(1),
        gh.dep_pr(2, auto=False),
        gh.dep_pr(3, draft=True),
        gh.dep_pr(4, state="MERGED"),
    )
    result = shepherd_status(gh.repo)
    assert result.status == 0
    assert target_numbers(result) == [1]
    assert skipped_numbers(result) == [2]


def test_does_not_treat_a_pull_request_without_the_dependencies_label_as_a_target(
    gh, shepherd_status
):
    """The label filter is server-side in real gh; the stub applies it the same way."""
    other = gh.dep_pr(2)
    other["labels"] = [{"name": "enhancement"}]
    gh.write_prs(gh.dep_pr(1), other)
    assert target_numbers(shepherd_status(gh.repo)) == [1]


def test_orders_by_merge_risk_band_unlabelled_after_low_then_oldest_first(gh, shepherd_status):
    gh.write_prs(
        gh.dep_pr(5, risk="high", created="2026-01-01T00:00:00Z"),
        gh.dep_pr(6, created="2026-01-03T00:00:00Z"),
        gh.dep_pr(7, created="2026-01-02T00:00:00Z"),
        gh.dep_pr(8, risk="medium", created="2026-01-01T00:00:00Z"),
        gh.dep_pr(9, risk="low", created="2026-01-09T00:00:00Z"),
    )
    assert target_numbers(shepherd_status(gh.repo)) == [9, 7, 6, 8, 5]


def test_summarises_each_target_with_the_fields_the_loop_needs(gh, shepherd_status):
    gh.write_prs(gh.dep_pr(1, merge="BEHIND", checks="failed"))
    result = shepherd_status(gh.repo)
    assert result.status == 0
    target = document(result)["targets"][0]
    assert target["is_bot"] is True
    assert target["mergeStateStatus"] == "BEHIND"
    assert target["autoMerge"] is True
    assert target["checks"]["state"] == "failed"
    assert target["checks"]["failing"][0]["name"] == "build"
    assert "/actions/runs/11/job/21" in target["checks"]["failing"][0]["link"]


def test_reads_a_status_context_rollup_as_well_as_check_runs(gh, shepherd_status):
    gh.write_prs(gh.dep_pr(1, checks="status-failed"))
    target = document(shepherd_status(gh.repo))["targets"][0]
    assert target["checks"]["state"] == "failed"
    assert target["checks"]["failing"] == [{"name": "ci/legacy", "link": "https://ci.example/1"}]


def test_folds_every_conclusion_the_way_the_loop_needs(gh, shepherd_status):
    """NEUTRAL and SKIPPED pass; CANCELLED and a null conclusion fail; a pending
    commit status waits; a green one passes."""
    gh.write_prs(
        gh.dep_pr(1, checks="neutral"),
        gh.dep_pr(2, checks="cancelled"),
        gh.dep_pr(3, checks="null-conclusion"),
        gh.dep_pr(4, checks="status-pending"),
        gh.dep_pr(5, checks="status-passed"),
    )
    assert check_states(shepherd_status(gh.repo)) == {
        1: "passed",
        2: "failed",
        3: "failed",
        4: "pending",
        5: "passed",
    }


def test_calls_a_rollup_failed_when_something_failed_beside_something_running(gh, shepherd_status):
    """A failure wins over pending: the loop should classify now rather than wait."""
    gh.write_prs(gh.dep_pr(1, checks="mixed"))
    assert check_states(shepherd_status(gh.repo)) == {1: "failed"}


def test_recognises_a_human_author(gh, shepherd_status):
    gh.write_prs(gh.dep_pr(1, bot=False))
    target = document(shepherd_status(gh.repo))["targets"][0]
    assert target["is_bot"] is False
    assert target["author"] == "someone"


# --- ci_seconds ---------------------------------------------------------------


def test_takes_the_median_of_recent_run_durations(gh, shepherd_status, monkeypatch):
    """Sorted 30 45 50 60 900: the middle one, not the mean the outlier drags up."""
    write_runs(gh, monkeypatch, 30, 900, 60, 45, 50)
    assert document(shepherd_status(gh.repo))["ci_seconds"] == 50


def test_measures_only_completed_runs_on_the_default_branch(gh, shepherd_status, monkeypatch):
    """Two long runs that must not count: one still running on main, one on a branch.

    If either leaked in, the median would move.
    """
    write_runs(gh, monkeypatch, 40, 50, 60, "5000:main:in_progress", "6000:feature")
    assert document(shepherd_status(gh.repo))["ci_seconds"] == 50


def test_ignores_runs_with_a_non_positive_duration_and_falls_back(gh, shepherd_status, monkeypatch):
    write_runs(gh, monkeypatch, 0)
    assert document(shepherd_status(gh.repo))["ci_seconds"] == 300


def test_falls_back_to_300_when_the_run_listing_is_unavailable(gh, shepherd_status, monkeypatch):
    monkeypatch.setenv("GH_FIXTURE_RUNS", str(gh.path / "missing.json"))
    assert document(shepherd_status(gh.repo))["ci_seconds"] == 300


# --- streams ------------------------------------------------------------------


def test_survives_a_single_byte_locale(gh, shepherd_status):
    """Not in the spec. Two earlier ports lost time to non-ASCII output dying here.

    A pull request title carries a character no single-byte locale can encode,
    and the run has to finish and report rather than raise on its first line.
    """
    pull = gh.dep_pr(1)
    pull["title"] = "build(deps): bump café — 1.0.0"
    gh.write_prs(pull)
    result = shepherd_status(gh.repo, env={"PYTHONIOENCODING": "ascii", "LC_ALL": "C"})
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert document(result)["targets"][0]["title"] == "build(deps): bump café — 1.0.0"


def test_a_reader_that_closed_the_pipe_is_not_an_error(gh, shepherd_status, run_with_closed_reader):
    """`gh-shepherd-status.py <path> | head` after head has had enough.

    This script changes nothing, so there is nothing to protect but the exit
    status: a broken pipe must not surface as a traceback.
    """
    gh.write_prs(gh.dep_pr(1))
    status, stderr = run_with_closed_reader(SHEPHERD_STATUS, gh.repo)
    assert status == 0
    assert "Traceback" not in stderr
