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
import subprocess
import sys

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
    """fails when the pull request does not exist

    Exit 1 is reserved for this arm: the run loop fails a stream permanently on
    it, so anything else reaching 1 would strand work the next tick could have
    finished."""
    result = ws_pr_status("99")
    assert result.status == 1
    assert "gh pr view failed for 99: no such pull request" in result.stderr


def test_forwards_ghs_own_message_when_the_pull_request_does_not_exist(ws_pr_status):
    """Not in the shell spec, where stderr was never captured and so reached the
    terminal untouched. Capturing it to decide between exit 1 and exit 4 must not
    be how gh's own explanation goes missing."""
    result = ws_pr_status("99")
    assert "Could not resolve to a PullRequest with the number of 99" in result.stderr


def test_reports_gh_failing_separately_from_a_pull_request_that_does_not_exist(
    ws_pr_status, ws_sandbox
):
    """Not in the shell spec. A rate limit, an expired token, or a network blip
    exits gh non-zero with a message that says nothing about resolving a pull
    request; reading that as "the PR does not exist" is what made the run loop
    fail a stream permanently on a blip (issue #62)."""
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_pr_status("10")
    assert result.status == 4
    assert "gh: simulated failure" in result.stderr
    assert result.stderr.endswith("ws-pr-status.py: gh pr view failed for 10\n")


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        ("GraphQL: Could not resolve to a PullRequest with the number of 99.\n", True),
        ("could not resolve to a pullrequest\n", True),
        ('no pull requests found for branch "wktr-1-parser-fix"\n', True),
        ("HTTP 403: API rate limit exceeded\n", False),
        ("error connecting to api.github.com\n", False),
        ("", False),
    ],
)
def test_reads_ghs_message_for_whether_the_pull_request_exists(stderr, expected):
    """The arm the exit status turns on, tested directly: a stub can only
    produce the messages it was written to produce, and the ones that matter
    here come from real gh."""
    module = load_lib_module("workstreams_ws_pr_status_missing", WS_PR_STATUS)
    assert module.missing(stderr) is expected


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
    failed"; naming the reason saves the reader working out why. The OSError's
    own text is the naming: without it the message says only which call it was."""
    result = ws_pr_status("10", env={"PATH": sandbox.path_without("gh")})
    assert result.status == 4
    assert "gh pr view failed for 10: " in result.stderr
    assert "No such file or directory" in result.stderr


@pytest.mark.parametrize("rollup", [{"nodes": []}, "SUCCESS", ["lint"]])
def test_reports_a_rollup_it_cannot_fold_as_a_failure_rather_than_an_internal_error(
    ws_pr_status, ws_sandbox, rollup
):
    """Not in the shell spec, where jq's own error came out as "jq failed while
    folding the pull request". Folded blind, a rollup of this shape raised an
    AttributeError, which the run loop recorded as an internal error with
    nothing in it for the reader to act on."""
    path = ws_sandbox.gh_dir / "prs.json"
    prs = json.loads(path.read_text(encoding="utf-8"))
    for pull_request in prs:
        if pull_request["number"] == 10:
            pull_request["statusCheckRollup"] = rollup
    path.write_text(json.dumps(prs), encoding="utf-8")
    result = ws_pr_status("10")
    assert result.status == 4
    assert result.stderr == (
        "ws-pr-status.py: statusCheckRollup is not a list of objects for PR 10\n"
    )


def test_prints_a_non_ascii_title_under_a_non_utf8_locale(ws_pr_status, ws_sandbox):
    """Not in the shell spec. The output is written with ensure_ascii=False, so
    an accented title goes to stdout as raw UTF-8; without reconfiguring stdout
    a non-UTF-8 locale would fail the write with a UnicodeEncodeError."""
    path = ws_sandbox.gh_dir / "prs.json"
    prs = json.loads(path.read_text(encoding="utf-8"))
    for pull_request in prs:
        if pull_request["number"] == 10:
            pull_request["title"] = "fix: caf\u00e9 parser"
    path.write_text(json.dumps(prs), encoding="utf-8")
    result = ws_pr_status("10", env={"LC_ALL": "C", "PYTHONIOENCODING": "ascii", "PYTHONUTF8": "0"})
    assert result.status == 0
    assert "caf\u00e9" in result.stdout


def test_exits_quietly_when_the_reader_closes_the_pipe(ws_sandbox):
    """Not in the shell spec, where the shell was killed by SIGPIPE and nobody
    noticed. Python turns it into a BrokenPipeError, which without a handler is
    a traceback on stderr and a non-zero exit for `ws-pr-status.py 10 | head`."""
    process = subprocess.Popen(
        [sys.executable, str(WS_PR_STATUS), "10"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


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
        stderr = b""

    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(module.cli.Failure) as excinfo:
        module.gh_view("10")
    assert excinfo.value.message.startswith("gh pr view failed for 10: it did not answer with JSON")
    assert excinfo.value.status == 4
