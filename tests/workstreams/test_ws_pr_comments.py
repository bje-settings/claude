"""Black-box tests for ws-pr-comments.py.

No shell spec to port: the script is new with the review skill (#62), which
reads one pull request's reviews, issue comments, and review threads through it
instead of through two raw `gh` calls whose output nobody folded.

The fold itself is tested arm by arm in `test_pr_comments.py`. These prove the
script sends one query, pages it, and prints what the round reads.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from conftest import (
    STUB_BIN,
    WS_PR_COMMENTS,
    comments_page,
    load_lib_module,
    ws_fixture_comments,
)

pytestmark = pytest.mark.usefixtures("ws_sandbox")


def entries(result):
    assert result.status == 0, result.stderr
    return json.loads(result.stdout)


def test_reports_every_review_comment_and_thread_on_the_pull_request(ws_pr_comments):
    found = entries(ws_pr_comments("10"))
    assert [(entry["id"], entry["kind"]) for entry in found] == [
        (5001, "review"),
        (5002, "review"),
        (6001, "comment"),
        (6002, "comment"),
        (7001, "thread"),
        (7002, "thread"),
        (7003, "thread"),
    ]


def test_leaves_out_the_review_github_keeps_for_a_batch_of_inline_comments(ws_pr_comments):
    """Review 5003 has an empty body; its comments are in the threads already."""
    assert 5003 not in [entry["id"] for entry in entries(ws_pr_comments("10"))]


def test_flags_a_github_app_and_a_machine_user_as_bots(ws_pr_comments):
    found = {entry["id"]: entry for entry in entries(ws_pr_comments("10"))}
    assert [found[5001]["bot"], found[6001]["bot"], found[5002]["bot"]] == [True, True, False]
    assert [found[5001]["author"], found[6001]["author"]] == ["coderabbitai", "codecov[bot]"]


def test_names_the_author_of_a_comment_whose_account_is_gone_as_nobody(ws_pr_comments):
    found = {entry["id"]: entry for entry in entries(ws_pr_comments("10"))}
    assert [found[6002]["author"], found[6002]["bot"]] == ["", False]


def test_marks_the_comments_of_a_resolved_thread_resolved(ws_pr_comments):
    found = {entry["id"]: entry for entry in entries(ws_pr_comments("10"))}
    assert [found[7001]["resolved"], found[7003]["resolved"]] == [False, True]


def test_carries_the_path_and_line_of_a_thread_comment_and_nothing_else(ws_pr_comments):
    found = {entry["id"]: entry for entry in entries(ws_pr_comments("10"))}
    assert [found[7001]["path"], found[7001]["line"]] == ["src/parser.py", 42]
    assert [found[7002]["path"], found[7002]["line"]] == ["src/parser.py", None]
    assert [found[5001]["path"], found[5001]["line"]] == [None, None]


def test_reads_every_page_when_github_answers_with_more_than_one(ws_pr_comments, ws_sandbox):
    """The three connections page together, and a connection that has run out
    keeps its cursor: falling back to null would hand back its first page and
    double every entry on it."""
    ws_fixture_comments(
        ws_sandbox.gh_dir / "comments.json",
        [
            comments_page(
                comments=[{"databaseId": 1, "body": "one", "author": None}], has_next=True
            ),
            comments_page(comments=[{"databaseId": 2, "body": "two", "author": None}]),
        ],
    )
    assert [entry["id"] for entry in entries(ws_pr_comments("10"))] == [1, 2]


def test_asks_for_the_next_page_with_the_cursor_github_gave_it(ws_pr_comments, ws_sandbox):
    """The stub refuses a second page to a caller that sent no cursor, so this
    fails rather than passing on a script that dropped its paging."""
    ws_fixture_comments(
        ws_sandbox.gh_dir / "comments.json",
        [comments_page(has_next=True), comments_page()],
    )
    assert entries(ws_pr_comments("10")) == []


def test_reports_an_empty_pull_request_as_an_empty_list(ws_pr_comments, ws_sandbox):
    ws_fixture_comments(ws_sandbox.gh_dir / "comments.json", [comments_page()])
    result = ws_pr_comments("10")
    assert result.status == 0
    assert result.stdout == "[]\n"


# --- naming the pull request --------------------------------------------------


def test_takes_the_repository_from_a_url(ws_pr_comments, ws_sandbox):
    """The round runs in whatever session the user started, which is often a
    checkout of some other repository; the url is what settles it."""
    ws_sandbox.setenv("WS_REPO", "somebody/else")
    result = ws_pr_comments("https://github.com/acme-org/widgets/pull/10")
    assert result.status == 0
    assert len(json.loads(result.stdout)) == 7


def test_accepts_a_hash_prefixed_number(ws_pr_comments):
    assert entries(ws_pr_comments("#10"))


def test_refuses_a_reference_that_is_neither_a_number_nor_a_url(ws_pr_comments):
    result = ws_pr_comments("main")
    assert result.status == 2
    assert "not a pull request number or url" in result.stderr


def test_refuses_a_repo_that_is_not_owner_slash_name(ws_pr_comments):
    result = ws_pr_comments("10", "--repo", "widgets")
    assert result.status == 2
    assert "repo must be owner/name" in result.stderr


def test_rejects_an_argument_after_the_pull_request(ws_pr_comments):
    result = ws_pr_comments("10", "--all")
    assert result.status == 2
    assert "unknown argument: --all" in result.stderr


def test_rejects_a_repo_flag_with_no_value(ws_pr_comments):
    result = ws_pr_comments("10", "--repo")
    assert result.status == 2
    assert "--repo needs a value" in result.stderr


def test_rejects_unknown_flags(ws_pr_comments):
    result = ws_pr_comments("--web")
    assert result.status == 2
    assert "unknown flag" in result.stderr


def test_requires_an_argument(ws_pr_comments):
    result = ws_pr_comments()
    assert result.status == 2
    assert "required" in result.stderr


def test_treats_an_explicit_empty_argument_as_none_at_all(ws_pr_comments):
    result = ws_pr_comments("")
    assert result.status == 2
    assert "required" in result.stderr


def test_prints_usage_for_help(ws_pr_comments):
    for flag in ("-h", "--help"):
        result = ws_pr_comments(flag)
        assert result.status == 0
        assert "every review, comment, and review thread" in result.stdout


# --- when gh cannot answer ----------------------------------------------------


def test_forwards_ghs_own_message_when_it_fails(ws_pr_comments, ws_sandbox):
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_pr_comments("10", "--repo", "bje-settings/example")
    assert result.status == 1
    assert "gh: simulated failure" in result.stderr
    assert result.stderr.endswith(
        "ws-pr-comments.py: gh api graphql failed for bje-settings/example#10\n"
    )


def test_says_so_when_gh_is_not_installed(ws_pr_comments, sandbox):
    result = ws_pr_comments(
        "10", "--repo", "acme-org/widgets", env={"PATH": sandbox.path_without("gh")}
    )
    assert result.status == 1
    assert "gh api graphql failed for acme-org/widgets#10: " in result.stderr
    assert "No such file or directory" in result.stderr


def test_says_so_when_gh_is_not_installed_and_the_repository_has_to_be_resolved(
    ws_pr_comments, sandbox
):
    """The other arm of a missing gh: with no --repo and no WS_REPO there is not
    even a repository to name, and the message has to say which of the two ways
    left would fix it."""
    result = ws_pr_comments("10", env={"PATH": sandbox.path_without("gh")})
    assert result.status == 1
    assert "cannot resolve the repository (gh: " in result.stderr
    assert "pass --repo owner/name" in result.stderr


def test_reads_a_connection_that_names_no_cursor_at_all(ws_pr_comments, ws_sandbox):
    """GitHub answers an empty connection with a null endCursor. There is no
    next page to ask for, so nothing is remembered and the round ends."""
    empty = {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}
    ws_fixture_comments(
        ws_sandbox.gh_dir / "comments.json",
        [
            {
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviews": empty,
                            "comments": empty,
                            "reviewThreads": empty,
                        }
                    }
                }
            }
        ],
    )
    result = ws_pr_comments("10")
    assert result.status == 0
    assert result.stdout == "[]\n"


def test_reports_a_graphql_error_github_answered_with(ws_pr_comments, ws_sandbox):
    """gh exits 0 on a partial answer, so a pull request that is not there
    arrives as a page of errors rather than as a failure."""
    ws_fixture_comments(
        ws_sandbox.gh_dir / "comments.json",
        [{"data": None, "errors": [{"message": "Could not resolve to a PullRequest."}]}],
    )
    result = ws_pr_comments("99")
    assert result.status == 1
    assert result.stderr.endswith("ws-pr-comments.py: Could not resolve to a PullRequest.\n")


def test_reports_an_answer_it_cannot_read_rather_than_an_internal_error(ws_pr_comments, ws_sandbox):
    ws_fixture_comments(ws_sandbox.gh_dir / "comments.json", [{"data": {"repository": None}}])
    result = ws_pr_comments("10")
    assert result.status == 1
    assert result.stderr.endswith("ws-pr-comments.py: gh answered with no pull request\n")


def test_says_so_when_the_repository_cannot_be_resolved(ws_pr_comments, ws_sandbox):
    """gh repo view is the last resort, and its failure has to name the two ways
    left to say which repository the pull request is in."""
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_pr_comments("10")
    assert result.status == 1
    assert "pass --repo owner/name" in result.stderr


# --- output and the process ---------------------------------------------------


def test_prints_two_space_indented_json_with_one_trailing_newline(ws_pr_comments):
    """The review round reads this output, so the shape is the contract."""
    result = ws_pr_comments("10")
    assert result.status == 0
    assert result.stdout.startswith('[\n  {\n    "id": 5001,\n')
    assert result.stdout.endswith("}\n]\n")


def test_prints_a_non_ascii_body_under_a_non_utf8_locale(ws_pr_comments, ws_sandbox):
    ws_fixture_comments(
        ws_sandbox.gh_dir / "comments.json",
        [comments_page(comments=[{"databaseId": 1, "body": "café", "author": None}])],
    )
    result = ws_pr_comments(
        "10", env={"LC_ALL": "C", "PYTHONIOENCODING": "ascii", "PYTHONUTF8": "0"}
    )
    assert result.status == 0
    assert "café" in result.stdout


def test_exits_quietly_when_the_reader_closes_the_pipe(ws_sandbox):
    process = subprocess.Popen(
        [sys.executable, str(WS_PR_COMMENTS), "10"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


def test_reads_a_pull_request_with_jq_absent_from_path(ws_pr_comments, sandbox):
    """The script folds the answer itself; nothing here shells out to jq."""
    path = sandbox.path_without("jq")
    result = ws_pr_comments("10", env={"PATH": f"{STUB_BIN}{os.pathsep}{path}"})
    assert result.status == 0
    assert len(json.loads(result.stdout)) == 7


# --- the arm no stub can provoke ----------------------------------------------


def test_says_so_when_gh_exits_0_with_something_that_is_not_json(monkeypatch):
    """A gh that cannot answer exits non-zero, so no stub reaches this: a proxy
    in front of the API answering with an HTML error page is what does."""
    module = load_lib_module("workstreams_ws_pr_comments_module", WS_PR_COMMENTS)

    class Finished:
        returncode = 0
        stdout = b"<!DOCTYPE html>"
        stderr = b""

    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: Finished())
    with pytest.raises(module.cli.Failure) as excinfo:
        module.gh_graphql("acme-org", "widgets", 10, {})
    assert "it did not answer with JSON" in excinfo.value.message
    assert excinfo.value.status == 1


def test_says_so_when_gh_repo_view_answers_with_something_other_than_a_name(monkeypatch):
    """The stub always answers `gh repo view` with a nameWithOwner, so the arms
    where it does not are driven directly."""
    module = load_lib_module("workstreams_ws_pr_comments_repo", WS_PR_COMMENTS)

    class Finished:
        returncode = 0
        stderr = b""

        def __init__(self, stdout):
            self.stdout = stdout

    for answer in (b"{}", b"not json", b'{"nameWithOwner": null}', b'{"nameWithOwner": "widgets"}'):
        monkeypatch.setattr(module.subprocess, "run", lambda *a, _out=answer, **k: Finished(_out))
        with pytest.raises(module.cli.Failure) as excinfo:
            module.gh_repo()
        assert "pass --repo owner/name" in excinfo.value.message
