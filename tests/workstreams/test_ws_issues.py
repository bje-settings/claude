"""Black-box tests for ws-issues.py.

Ported from the 22 examples in `spec/workstreams/ws_issues_spec.sh`, whose `It`
description each ported test carries in its docstring. One did not come across:
"requires jq", which asserted the shell script's dependency check. The Python
script parses and builds JSON itself, so there is no such dependency and nothing
left to assert; the tests below run with jq absent from PATH instead.

Every test drives the script as its own process through `ws_issues`, the way
Claude Code runs it, and reads its stdout back as JSON.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from conftest import STUB_BIN, WS_ISSUES, load_lib_module

pytestmark = pytest.mark.usefixtures("ws_sandbox")


def numbers(result):
    return [issue["number"] for issue in json.loads(result.stdout)]


def load_ws_issues_module():
    """ws-issues.py loaded in-process, for the one branch no stub can provoke.

    Loaded by path under its own name, as `load_lib_module` is (see its
    docstring in conftest.py).
    """
    return load_lib_module("workstreams_ws_issues_module", WS_ISSUES)


# --- selectors ----------------------------------------------------------------


def test_resolves_plain_numbers_and_hash_numbers(ws_issues):
    """resolves plain numbers and #numbers"""
    result = ws_issues("2", "#1")
    assert result.status == 0
    assert numbers(result) == [1, 2]


def test_expands_an_inclusive_range(ws_issues):
    """expands an inclusive range"""
    result = ws_issues("1-3")
    assert result.status == 0
    assert numbers(result) == [1, 2, 3]


def test_resolves_label_to_open_issues_with_that_label(ws_issues):
    """resolves label: to open issues with that label"""
    result = ws_issues("label:bug")
    assert result.status == 0
    # #5 also carries the bug label but is closed, so `--state open` excludes it.
    assert numbers(result) == [1]


def test_resolves_milestone_to_open_issues_in_that_milestone(ws_issues):
    """resolves milestone: to open issues in that milestone"""
    result = ws_issues("milestone:observe")
    assert result.status == 0
    assert numbers(result) == [4]


def test_joins_everything_else_into_one_search_query_and_says_so(ws_issues):
    """joins everything else into one search query and says so"""
    result = ws_issues("pin", "the", "linter")
    assert result.status == 0
    assert "treating as search text: pin" in result.stderr
    assert "treating as search text: linter" in result.stderr
    assert numbers(result) == [2]


def test_merges_selectors_and_removes_duplicates(ws_issues):
    """merges selectors and removes duplicates"""
    result = ws_issues("1", "label:bug", "1-2")
    assert result.status == 0
    assert numbers(result) == [1, 2]


def test_rejects_a_range_that_runs_backwards(ws_issues):
    """rejects a range that runs backwards"""
    result = ws_issues("3-1")
    assert result.status == 2
    assert "bad range" in result.stderr


def test_rejects_a_selector_that_starts_like_a_number_but_is_not_one(ws_issues):
    """rejects a selector that starts like a number but is not one"""
    result = ws_issues("1,3")
    assert result.status == 2
    assert "not a number, range, label:, or milestone: selector: 1,3" in result.stderr


def test_refuses_a_range_wider_than_the_limit_before_calling_gh(ws_issues):
    """Not in the shell spec, where `1-9999999999` built a list of ten billion
    numbers and died with an OverflowError before a single gh call went out.
    The limit is what the run could fetch anyway, so it is the cap. gh is made
    to fail here as well: exit 2 rather than 1 is the proof nothing called it."""
    result = ws_issues("1-500", env={"WS_GH_FIXTURE_FAIL": "1"})
    assert result.status == 2
    assert "range wider than the 200-issue limit: 1-500" in result.stderr


def test_measures_the_range_against_ws_issue_limit(ws_issues):
    """The cap is the limit actually in force, not the default."""
    assert ws_issues("1-2", env={"WS_ISSUE_LIMIT": "2"}).status == 0
    result = ws_issues("1-3", env={"WS_ISSUE_LIMIT": "2"})
    assert result.status == 2
    assert "range wider than the 2-issue limit: 1-3" in result.stderr


@pytest.mark.parametrize("value", ["many", "0", "-5"])
def test_falls_back_to_the_default_cap_when_the_limit_is_not_a_count(ws_issues, value):
    """A WS_ISSUE_LIMIT gh would refuse is gh's to refuse; the range check
    cannot read it, so it uses the default rather than capping at nothing."""
    result = ws_issues("1-2", env={"WS_ISSUE_LIMIT": value})
    assert result.status == 0
    assert numbers(result) == [1, 2]


def test_rejects_an_empty_selector_in_any_position(ws_issues):
    """Not in the shell spec, where an empty later selector was joined into the
    search query and dropped by the join, so `ws-issues.py 1 ""` searched for
    nothing and the caller never learned its variable had expanded to nothing."""
    result = ws_issues("1", "")
    assert result.status == 2
    assert "empty selector" in result.stderr


def test_rejects_an_empty_label_value(ws_issues):
    """rejects an empty label value"""
    result = ws_issues("label:")
    assert result.status == 2
    assert "empty value" in result.stderr


def test_needs_at_least_one_selector(ws_issues):
    """needs at least one selector"""
    result = ws_issues()
    assert result.status == 2
    assert "at least one selector" in result.stderr
    assert "Selectors, in any mix" in result.stderr


def test_treats_an_explicit_empty_first_selector_as_none_at_all(ws_issues):
    """Not in the shell spec, which the shell's `case "${1:-}" in "")` arm read
    the same way: a caller whose variable expanded to nothing meant to pass a
    selector and did not, and saying so beats searching for the empty string."""
    result = ws_issues("")
    assert result.status == 2
    assert "at least one selector" in result.stderr


def test_prints_usage_for_help(ws_issues):
    """prints usage for --help"""
    for flag in ("-h", "--help"):
        result = ws_issues(flag)
        assert result.status == 0
        assert "Selectors, in any mix" in result.stdout


# --- output shape -------------------------------------------------------------


def test_projects_labels_to_names_and_normalises_a_null_body(ws_issues):
    """projects labels to names and normalises a null body"""
    result = ws_issues("1", "2")
    assert result.status == 0
    first, second = json.loads(result.stdout)
    assert [first["labels"], second["body"], second["labels"]] == [["bug"], "", ["chore"]]


def test_extracts_hash_references_once_each_excluding_the_issue_itself(ws_issues):
    """extracts #N references from the body once each, excluding the issue itself"""
    result = ws_issues("1", "3")
    assert result.status == 0
    assert [issue["refs"] for issue in json.loads(result.stdout)] == [[2, 4], [1]]


def test_does_not_treat_a_hash_n_inside_a_url_as_a_reference(ws_issues):
    """does not treat a #N inside a url as a reference"""
    result = ws_issues("6")
    assert result.status == 0
    assert [issue["refs"] for issue in json.loads(result.stdout)] == [[]]


def test_includes_a_closed_issue_when_asked_for_it_by_number(ws_issues):
    """includes a closed issue when asked for it by number"""
    result = ws_issues("5")
    assert result.status == 0
    assert '"state": "CLOSED"' in result.stdout


def test_prints_two_space_indented_json_with_one_trailing_newline(ws_issues):
    """Not in the shell spec, where `jq .` decided the shape. The plan skill
    reads this output, so the indent and the single trailing newline are the
    contract, not an accident of the printer."""
    result = ws_issues("2")
    assert result.status == 0
    assert result.stdout.startswith("[\n  {\n    ")
    assert result.stdout.endswith("}\n]\n")


# --- failure handling ---------------------------------------------------------


def test_exits_3_with_an_empty_array_naming_the_selectors(ws_issues):
    """exits 3 with an empty array, naming the selectors, when nothing matched"""
    result = ws_issues("label:nothing-here")
    assert result.status == 3
    assert result.stdout == "[]\n"
    assert "no issues matched: label:nothing-here" in result.stderr


def test_fails_when_a_number_does_not_resolve(ws_issues):
    """fails when a number does not resolve"""
    result = ws_issues("99")
    assert result.status == 1
    assert "gh issue view failed for #99" in result.stderr


def test_refuses_a_number_that_is_a_pull_request(ws_issues):
    """refuses a number that is a pull request"""
    result = ws_issues("7")
    assert result.status == 1
    assert "#7 is a pull request, not an issue" in result.stderr


def test_fails_when_gh_issue_list_fails_for_a_label(ws_issues):
    """fails when gh issue list fails for a label"""
    result = ws_issues("label:bug", env={"WS_GH_FIXTURE_FAIL": "1"})
    assert result.status == 1
    assert "gh issue list failed for label:bug" in result.stderr


def test_fails_when_gh_issue_list_fails_for_a_search(ws_issues):
    """fails when gh issue list fails for a search"""
    result = ws_issues("parser", env={"WS_GH_FIXTURE_FAIL": "1"})
    assert result.status == 1
    assert "failed for search: parser" in result.stderr


def test_warns_when_a_list_fills_the_limit(ws_issues):
    """warns when a list fills the limit, since more may be hidden"""
    result = ws_issues("parser", env={"WS_ISSUE_LIMIT": "2"})
    assert result.status == 0
    assert "returned 2 issues, the limit" in result.stderr
    assert '"number": 1' in result.stdout


def test_fails_when_gh_cannot_read_its_own_data(ws_issues, ws_sandbox):
    """Not in the shell spec. Whatever went wrong inside gh, the script reports
    the call that failed and leaves gh's own message on stderr where it is."""
    (ws_sandbox.gh_dir / "issues.json").write_text("not json at all", encoding="utf-8")
    result = ws_issues("label:bug")
    assert result.status == 1
    assert "gh issue list failed for label:bug" in result.stderr


def test_says_so_when_gh_exits_0_with_something_that_is_not_json(monkeypatch):
    """Not in the shell spec, where such an answer went straight to jq and the
    failure read as "jq failed while merging issues" -- a message about this
    script's own tooling rather than about gh. No stub can provoke it, since a
    gh that cannot answer exits non-zero, so this drives gh_json directly."""
    module = load_ws_issues_module()

    class Finished:
        returncode = 0
        stdout = b"<!DOCTYPE html>"

    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(module.cli.Failure) as excinfo:
        module.gh_json(["issue", "list"], "gh issue list failed for label:bug")
    assert excinfo.value.message.startswith("gh issue list failed for label:bug: gh answered")
    assert excinfo.value.status == 1


def test_says_so_when_gh_answers_with_something_that_is_not_an_issue(monkeypatch):
    """Not in the shell spec. A JSON answer that is not an object has no url to
    test, so the pull-request check passed it through and the merge then read a
    number off something that had none. No stub can produce it: the projection
    `--json` asks for fails first, so this drives gh_view directly."""
    module = load_ws_issues_module()

    class Finished:
        returncode = 0
        stdout = b"[]"

    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(module.cli.Failure) as excinfo:
        module.gh_view(1)
    assert excinfo.value.message == (
        "gh issue view answered with something other than an issue for #1"
    )
    assert excinfo.value.status == 1


def test_says_so_when_gh_is_not_installed(ws_issues, sandbox):
    """Not in the shell spec, where a missing gh reported only "gh issue view
    failed"; naming the reason saves the reader working out why. The OSError's
    own text is part of it: without it the message says only which call failed."""
    result = ws_issues("1", env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "gh issue view failed for #1" in result.stderr
    assert "No such file or directory" in result.stderr


def test_resolves_issues_with_jq_absent_from_path(ws_issues, sandbox):
    """Replaces the shell spec's "requires jq": the port depends on no such
    tool, so the assertion is that it works without one. The stub gh runs jq
    only for a `--jq` expression, which this script never passes."""
    path = sandbox.path_without("jq")
    result = ws_issues("label:bug", env={"PATH": f"{STUB_BIN}{os.pathsep}{path}"})
    assert result.status == 0
    assert numbers(result) == [1]


def test_prints_a_non_ascii_title_under_a_non_utf8_locale(ws_issues, ws_sandbox):
    """Not in the shell spec. The output is written with ensure_ascii=False, so
    an accented title goes to stdout as raw UTF-8; without reconfiguring stdout
    a non-UTF-8 locale would fail the write with a UnicodeEncodeError."""
    issues = json.loads((ws_sandbox.gh_dir / "issues.json").read_text(encoding="utf-8"))
    issues[0]["title"] = "fix: café parser"
    (ws_sandbox.gh_dir / "issues.json").write_text(json.dumps(issues), encoding="utf-8")
    result = ws_issues("1", env={"LC_ALL": "C", "PYTHONIOENCODING": "ascii", "PYTHONUTF8": "0"})
    assert result.status == 0
    assert "café" in result.stdout


def test_exits_quietly_when_the_reader_closes_the_pipe(ws_sandbox):
    """Not in the shell spec, where the shell was killed by SIGPIPE and nobody
    noticed. Python turns it into a BrokenPipeError, which without a handler is
    a traceback on stderr and a non-zero exit for `ws-issues.py 1-6 | head`."""
    process = subprocess.Popen(
        [sys.executable, str(WS_ISSUES), "1-6"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


def test_exits_quietly_when_the_reader_closes_the_pipe_on_the_nothing_matched_path(ws_sandbox):
    """The `[]` is written before the exit-3 failure is raised, so that path has
    output waiting when the reporting begins. Without the flush inside cli.run's
    `finally`, the interpreter flushes it after run() has returned and prints
    "Exception ignored in ... BrokenPipeError" over the top of exit 3."""
    process = subprocess.Popen(
        [sys.executable, str(WS_ISSUES), "label:nothing-here"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""
