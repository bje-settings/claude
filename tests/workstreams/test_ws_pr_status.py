"""Black-box tests for ws-pr-status.py.

Ported from the 20 examples in `spec/workstreams/ws_pr_status_spec.sh` (12 `It`
blocks: the checks-fold `Parameters` block expands to nine), whose `It`
description each ported test carries in its docstring. One did not come across:
"requires jq", which asserted the shell script's dependency check. The Python
script folds the rollup itself, so there is no such dependency and nothing left
to assert; the tests below run with jq absent from PATH instead.

The fold itself is tested arm by arm in `test_pr_status.py`. These prove the
script wires the canned pull requests to it and prints what the run loop reads.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import STUB_BIN, WS_PR_STATUS, load_lib_module

pytestmark = pytest.mark.usefixtures("ws_sandbox")


@pytest.mark.parametrize(
    ("number", "expected", "why"),
    [
        (10, "pass", "successes and skips"),
        (11, "fail", "one failure beside a success"),
        (12, "pending", "an in-progress CheckRun and a pending StatusContext"),
        (13, "none", "no checks at all"),
        (14, "pass", "a StatusContext SUCCESS"),
        (15, "fail", "a cancelled run"),
        (16, "pass", "a neutral run beside a success"),
        (17, "pending", "a completed CheckRun with no conclusion"),
        (18, "fail", "a stale run that needs a rerun"),
    ],
)
def test_folds_the_check_rollup(ws_pr_status, number, expected, why):
    """folds <why> to <expected>"""
    result = ws_pr_status(str(number))
    assert result.status == 0
    assert f'"checks": "{expected}"' in result.stdout


def test_reports_the_fields_the_run_loop_decides_on(ws_pr_status):
    """reports the fields the run loop decides on"""
    result = ws_pr_status("10")
    assert result.status == 0
    status = json.loads(result.stdout)
    assert [
        status["number"],
        status["draft"],
        status["state"],
        status["base"],
        status["head"],
        status["headSha"],
        status["mergeable"],
        status["reviewDecision"],
    ] == [10, True, "OPEN", "main", "wktr-1-parser-fix", "aaa111", "MERGEABLE", ""]


def test_defaults_a_null_mergeable_and_passes_the_review_decision_through(ws_pr_status):
    """defaults a null mergeable to UNKNOWN and passes the review decision through"""
    result = ws_pr_status("#13")
    assert result.status == 0
    status = json.loads(result.stdout)
    assert [status["mergeable"], status["reviewDecision"], status["draft"]] == [
        "UNKNOWN",
        "APPROVED",
        False,
    ]


def test_names_the_failing_checks_by_name_or_context(ws_pr_status, ws_sandbox):
    """names the failing checks by CheckRun name or StatusContext context"""
    path = ws_sandbox.gh_dir / "prs.json"
    prs = json.loads(path.read_text(encoding="utf-8"))
    for pull_request in prs:
        if pull_request["number"] == 11:
            pull_request["statusCheckRollup"].append(
                {"__typename": "StatusContext", "context": "coverage/kcov", "state": "FAILURE"}
            )
    path.write_text(json.dumps(prs), encoding="utf-8")
    result = ws_pr_status("11")
    assert result.status == 0
    assert json.loads(result.stdout)["failing"] == ["lint", "coverage/kcov"]


def test_reports_no_failing_checks_on_a_passing_pr(ws_pr_status):
    """reports no failing checks on a passing PR"""
    result = ws_pr_status("10")
    assert result.status == 0
    assert '"failing": []' in result.stdout


def test_accepts_a_url(ws_pr_status):
    """accepts a url"""
    result = ws_pr_status("https://example.invalid/p/14")
    assert result.status == 0
    assert '"state": "MERGED"' in result.stdout


def test_fails_when_the_pull_request_does_not_exist(ws_pr_status):
    """fails when the pull request does not exist"""
    result = ws_pr_status("99")
    assert result.status == 1
    assert "gh pr view failed for 99" in result.stderr


def test_requires_exactly_one_argument(ws_pr_status):
    """requires exactly one argument"""
    result = ws_pr_status("10", "11")
    assert result.status == 2
    assert "exactly one pull request" in result.stderr


def test_requires_an_argument(ws_pr_status):
    """requires an argument"""
    result = ws_pr_status()
    assert result.status == 2
    assert "required" in result.stderr


def test_treats_an_explicit_empty_argument_as_none_at_all(ws_pr_status):
    """Not in the shell spec, which the shell's `case "${1:-}" in "")` arm read
    the same way: a caller whose `$PR` expanded to nothing is told what is
    missing rather than sent to gh with an empty reference."""
    result = ws_pr_status("")
    assert result.status == 2
    assert "required" in result.stderr


def test_rejects_unknown_flags(ws_pr_status):
    """rejects unknown flags"""
    result = ws_pr_status("--web")
    assert result.status == 2
    assert "unknown flag" in result.stderr


def test_prints_usage_for_help(ws_pr_status):
    """prints usage for --help"""
    for flag in ("-h", "--help"):
        result = ws_pr_status(flag)
        assert result.status == 0
        assert "checks folds the status rollup" in result.stdout


def test_prints_two_space_indented_json_with_one_trailing_newline(ws_pr_status):
    """Not in the shell spec, where `jq` decided the shape. The run loop and the
    review brief both read this output, so the shape is the contract."""
    result = ws_pr_status("10")
    assert result.status == 0
    assert result.stdout.startswith('{\n  "number": 10,\n')
    assert result.stdout.endswith('"reviewDecision": ""\n}\n')


def test_reduces_a_pull_request_with_jq_absent_from_path(ws_pr_status, sandbox):
    """Replaces the shell spec's "requires jq": the port depends on no such
    tool, so the assertion is that it works without one."""
    path = sandbox.path_without("jq")
    result = ws_pr_status("10", env={"PATH": f"{STUB_BIN}{os.pathsep}{path}"})
    assert result.status == 0
    assert '"checks": "pass"' in result.stdout


def test_says_so_when_gh_is_not_installed(ws_pr_status, sandbox):
    """Not in the shell spec, where a missing gh reported only "gh pr view
    failed"; naming the reason saves the reader working out why."""
    result = ws_pr_status("10", env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "gh pr view failed for 10" in result.stderr


# --- the arm no stub can provoke ----------------------------------------------


def test_says_so_when_gh_exits_0_with_something_that_is_not_json(monkeypatch):
    """Not in the shell spec, where such an answer went straight to jq and the
    failure read as "jq failed while folding the pull request" -- a message
    about this script's own tooling rather than about gh. No stub can provoke
    it, since a gh that cannot answer exits non-zero, so this drives gh_view
    directly, the way test_pr_status.py drives lib/pr_status.py."""
    module = load_lib_module("workstreams_ws_pr_status_module", WS_PR_STATUS)

    class Finished:
        returncode = 0
        stdout = b"<!DOCTYPE html>"

    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(module.cli.Failure) as excinfo:
        module.gh_view("10")
    assert excinfo.value.message.startswith("gh pr view failed for 10: it did not answer with JSON")
    assert excinfo.value.status == 1
