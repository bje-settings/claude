"""Black-box tests for ft-verify-report.py.

Ported from `spec/field-test/verify_report_spec.sh`. One example per arm of
`lib/verify.py`, reached the way the skill reaches it: a report file, the stub
gh, and the exit status the loop branches on. A report is a claim, and the arms
that matter are the ones where the claim is wrong or unverifiable.

"requires jq" did not come across; there is no jq to require, and the exit-4
arm it shared is covered by the two gh cases below.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FT_VERIFY_REPORT, ft_fixture_report

pytestmark = pytest.mark.usefixtures("ft_sandbox")


@pytest.fixture
def report(ft_sandbox):
    """The report file the skill writes before verifying it."""

    class Report:
        path = ft_sandbox.report

        def case(self, name="accurate"):
            ft_fixture_report(self.path, name)
            return str(self.path)

        def write(self, document):
            self.path.write_text(
                document if isinstance(document, str) else json.dumps(document),
                encoding="utf-8",
            )
            return str(self.path)

    return Report()


@pytest.fixture
def gh_garbage(ft_sandbox):
    """A gh that exits 0 with something that is not JSON at all."""
    path = ft_sandbox.path / "gh-garbage"
    path.write_text('#!/bin/sh\necho "warning: not json"\n', encoding="utf-8")
    os.chmod(path, 0o755)
    ft_sandbox.setenv("FT_GH", path)
    return path


def answer(result):
    return json.loads(result.stdout)


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_VERIFY_REPORT, "--help")
    assert result.status == 0
    assert "ft-verify-report.py <report.json>" in result.stdout


def test_exits_2_with_usage_when_given_nothing(run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_VERIFY_REPORT)
    assert result.status == 2
    assert "ft-verify-report.py <report.json>" in result.stderr


def test_refuses_a_report_that_is_not_there(ft_sandbox, run_script):
    """refuses a report that is not there"""
    result = run_script(FT_VERIFY_REPORT, ft_sandbox.path / "nope.json")
    assert result.status == 2
    assert "no report at" in result.stderr


def test_refuses_a_report_with_no_pull_requests_in_it(report, run_script):
    """refuses a report with no pull requests in it"""
    result = run_script(FT_VERIFY_REPORT, report.write({"repo": "acme-org/plugins"}))
    assert result.status == 2
    assert "no prs array" in result.stderr


def test_refuses_to_guess_the_repository(report, run_script):
    """refuses to guess the repository"""
    result = run_script(FT_VERIFY_REPORT, report.write({"prs": []}))
    assert result.status == 2
    assert "no repository" in result.stderr


def test_rejects_an_unknown_argument(report, run_script):
    """rejects an unknown argument"""
    result = run_script(FT_VERIFY_REPORT, report.case(), "--strict")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_rejects_repo_with_no_value(report, run_script):
    """rejects --repo with no value"""
    result = run_script(FT_VERIFY_REPORT, report.case(), "--repo")
    assert result.status == 2
    assert "--repo needs a value" in result.stderr


def test_refuses_a_report_that_is_not_json(report, run_script):
    """refuses a report that is not JSON, naming that rather than a missing prs array"""
    result = run_script(FT_VERIFY_REPORT, report.write("not json"))
    assert result.status == 2
    assert "not valid JSON" in result.stderr


def test_refuses_a_pull_request_number_that_is_not_a_number(report, run_script):
    """refuses a pull request number that is not a number"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": "fifty", "claimed": "merged"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 2
    assert "must be numbers, got: fifty" in result.stderr


def test_names_a_number_that_is_not_a_number_in_the_words_the_report_used(report, run_script):
    """names a JSON true as `true`, not as Python's True

    `str` renders JSON's words as Python's, and `got: True` sends whoever reads
    the message looking through the report for a word it does not contain.
    """
    document = {"repo": "acme-org/plugins", "prs": [{"number": True, "claimed": "merged"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 2
    assert "must be numbers, got: true" in result.stderr


def test_names_a_null_number_as_null(report, run_script):
    document = {"repo": "acme-org/plugins", "prs": [{"number": None, "claimed": "merged"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 2
    assert "must be numbers, got: null" in result.stderr


@pytest.mark.skipif(os.geteuid() == 0, reason="running as root, permissions do not apply")
def test_names_a_report_it_cannot_open_as_unreadable(report, run_script):
    """a report that is there but unreadable is not a report that is missing"""
    path = report.case()
    os.chmod(path, 0o000)
    try:
        result = run_script(FT_VERIFY_REPORT, path)
    finally:
        os.chmod(path, 0o600)
    assert result.status == 2
    assert f"cannot read {path}" in result.stderr
    assert "no report at" not in result.stderr


def test_refuses_a_claim_that_is_not_an_object(report, run_script):
    """a prs array holding bare numbers is a report this cannot read"""
    result = run_script(FT_VERIFY_REPORT, report.write({"repo": "a/b", "prs": [50]}))
    assert result.status == 2
    assert "cannot read the claims out of" in result.stderr


# --- comparing claims against GitHub -----------------------------------------


def test_passes_a_report_where_every_claim_holds(report, run_script):
    """passes a report where merged, skipped, and closed all hold"""
    result = run_script(FT_VERIFY_REPORT, report.case("accurate"))
    assert result.status == 0
    document = answer(result)
    assert document["ok"] is True
    assert (document["checked"], document["matched"]) == (3, 3)
    assert document["mismatches"] == []


def test_catches_a_pull_request_claimed_merged_that_is_still_open(report, run_script):
    """catches a pull request the report claimed merged that is still open"""
    result = run_script(FT_VERIFY_REPORT, report.case("wrong"))
    assert result.status == 1
    assert answer(result)["ok"] is False
    assert "the report said merged; GitHub says open" in result.stdout


def test_refuses_to_pass_a_claim_in_a_word_it_cannot_check(report, run_script):
    """refuses to pass a claim in a word it cannot check"""
    result = run_script(FT_VERIFY_REPORT, report.case("unknown"))
    assert result.status == 1
    assert "used a word this cannot check: shepherded" in result.stdout


def test_treats_a_pull_request_gh_cannot_answer_for_as_a_mismatch(report, run_script):
    """treats a pull request gh cannot answer for as a mismatch, not a pass"""
    result = run_script(FT_VERIFY_REPORT, report.case("missing"))
    assert result.status == 1
    assert "could not be read on GitHub" in result.stdout
    assert "Could not resolve to a PullRequest" in result.stdout


def test_reads_the_repository_from_repo_over_the_one_in_the_report(report, run_script):
    """reads the repository from --repo over the one in the report"""
    report.case("accurate")
    document = json.loads(report.path.read_text(encoding="utf-8"))
    document["repo"] = "nope/nope"
    result = run_script(FT_VERIFY_REPORT, report.write(document), "--repo", "acme-org/plugins")
    assert result.status == 0
    assert answer(result)["ok"] is True


def test_catches_a_closed_pull_request_the_report_called_merged(report, run_script):
    """catches a closed pull request the report called merged"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": 55, "claimed": "merged"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 1
    assert answer(result)["results"][0]["actual"] == "closed"


def test_accepts_open_as_well_as_skipped(report, run_script):
    """accepts open as well as skipped for a pull request left alone"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "open"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 0
    assert answer(result)["ok"] is True


def test_catches_a_skip_claimed_for_a_pull_request_that_merged(report, run_script):
    """catches a skip claimed for a pull request that actually merged"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": 54, "claimed": "skipped"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 1
    assert "the report said skipped; GitHub says merged" in result.stdout


def test_does_not_pass_a_report_with_no_claims(report, run_script):
    """does not pass a report with no claims: nothing to check is not evidence"""
    document = {"repo": "acme-org/plugins", "prs": []}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 3
    assert answer(result)["ok"] is False
    assert answer(result)["checked"] == 0
    assert "nothing to check" in result.stdout


def test_reads_a_number_written_as_a_string(report, run_script):
    """reads a number written as a string, so a hand-assembled report is not a false mismatch"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": "50", "claimed": "skipped"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 0
    assert answer(result)["ok"] is True
    assert answer(result)["results"][0]["number"] == 50


def test_catches_a_closed_claim_for_a_pull_request_that_is_still_open(report, run_script):
    """catches a closed claim for a pull request that is still open"""
    document = {"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "closed"}]}
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 1
    assert "the report said closed; GitHub says open" in result.stdout


def test_counts_the_claims_that_held_separately(report, run_script):
    """counts the claims that held separately from the ones that did not"""
    document = {
        "repo": "acme-org/plugins",
        "prs": [{"number": 54, "claimed": "merged"}, {"number": 50, "claimed": "merged"}],
    }
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 1
    assert (answer(result)["checked"], answer(result)["matched"]) == (2, 1)


def test_exits_4_when_gh_answers_with_something_that_is_not_json(report, gh_garbage, run_script):
    """exits 4 when gh answers with something that is not JSON, rather than calling it a mismatch"""
    result = run_script(FT_VERIFY_REPORT, report.case("accurate"))
    assert result.status == 4
    assert "cannot read for pull request 54" in result.stderr
    assert "not json" in result.stderr


def test_reports_every_claim_not_only_the_ones_that_failed(report, run_script):
    """reports every claim, not only the ones that failed"""
    result = run_script(FT_VERIFY_REPORT, report.case("accurate"))
    assert result.status == 0
    assert len(answer(result)["results"]) == 3


def test_a_gh_that_cannot_be_run_at_all_exits_4(report, ft_sandbox, run_script):
    """a gh that is not there checked nothing, which is not the report's fault

    Exit 1 would put one mismatch per claim in front of the harden skill, which
    files each one as an issue against the target: a broken tool blamed on the
    thing under test.
    """
    ft_sandbox.setenv("FT_GH", ft_sandbox.path / "no-such-gh")
    result = run_script(FT_VERIFY_REPORT, report.case("accurate"))
    assert result.status == 4
    assert "gh could not answer, so no claim was checked" in result.stderr
    assert result.stdout == ""


def test_a_gh_that_fails_the_same_way_for_every_claim_exits_4(report, ft_sandbox, run_script):
    """a gh that failed the same way for every claim answered nothing"""
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = run_script(FT_VERIFY_REPORT, report.case("accurate"))
    assert result.status == 4
    assert "simulated failure" in result.stderr


def test_one_pull_request_gh_could_not_read_among_answers_is_a_mismatch(report, run_script):
    """gh answered for the rest, so the one it could not read is the report's to own"""
    document = {
        "repo": "acme-org/plugins",
        "prs": [{"number": 54, "claimed": "merged"}, {"number": 999, "claimed": "merged"}],
    }
    result = run_script(FT_VERIFY_REPORT, report.write(document))
    assert result.status == 1
    assert (answer(result)["checked"], answer(result)["matched"]) == (2, 1)
