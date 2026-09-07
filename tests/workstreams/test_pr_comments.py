"""Unit tests for `plugins/workstreams/scripts/lib/pr_comments.py`.

The fold arm by arm. `test_ws_pr_comments.py` proves the script wires gh to it
and prints what the review round reads; these name the decisions inside, the way
`test_pr_status.py` does for the checks fold.
"""

from __future__ import annotations

import pytest
from conftest import WS_LIB, load_lib_module

pr_comments = load_lib_module("ws_lib_pr_comments", WS_LIB / "pr_comments.py")


def review(body="looks wrong", login="aoife", typename="User", identifier=1):
    return {
        "databaseId": identifier,
        "body": body,
        "state": "COMMENTED",
        "author": {"login": login, "__typename": typename},
    }


def thread(resolved, comments):
    return {"isResolved": resolved, "comments": {"nodes": comments}}


def connection(nodes, has_next=False, cursor=None):
    return {
        "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
        "nodes": nodes,
    }


def pull(reviews=(), comments=(), threads=(), paging=None):
    """One `pullRequest` object. `paging` maps a connection to (hasNextPage, endCursor)."""
    paging = paging or {}
    return {
        "reviews": connection(list(reviews), *paging.get("reviews", ())),
        "comments": connection(list(comments), *paging.get("comments", ())),
        "reviewThreads": connection(list(threads), *paging.get("reviewThreads", ())),
    }


# --- who wrote it -------------------------------------------------------------


@pytest.mark.parametrize(
    ("author", "expected", "why"),
    [
        ({"login": "coderabbitai", "__typename": "Bot"}, True, "a GitHub App account"),
        ({"login": "codecov[bot]", "__typename": "User"}, True, "a machine user by its suffix"),
        ({"login": "aoife", "__typename": "User"}, False, "a person"),
        ({}, False, "an author GitHub did not name"),
        ({"login": None, "__typename": "User"}, False, "a null login"),
        ({"login": "botanist", "__typename": "User"}, False, "a login that merely starts like one"),
    ],
)
def test_reads_whether_the_author_is_a_bot(author, expected, why):
    assert pr_comments.is_bot(author) is expected, why


def test_flattens_a_comment_whose_author_deleted_their_account():
    """`author: null` is a comment worth reading, not a record to drop."""
    entry = pr_comments.entry(
        {"databaseId": 9, "body": "hi", "author": None}, "comment", False, None, None
    )
    assert [entry["author"], entry["bot"], entry["body"]] == ["", False, "hi"]


# --- the three connections ----------------------------------------------------


def test_drops_a_review_that_carries_no_body():
    """GitHub keeps a review record for every batch of inline comments, and its
    body is empty. Those comments are in the threads already, so the empty shell
    would put a finding with nothing in it in front of the round."""
    entries = pr_comments.reviews(pull(reviews=[review(body=""), review(body="   ", identifier=2)]))
    assert entries == []


def test_keeps_a_review_that_says_something():
    entries = pr_comments.reviews(pull(reviews=[review(body="two blockers", identifier=5)]))
    assert [entries[0]["id"], entries[0]["kind"], entries[0]["body"]] == [
        5,
        "review",
        "two blockers",
    ]


def test_reads_issue_comments_with_no_path_or_line():
    entries = pr_comments.comments(
        pull(comments=[{"databaseId": 6, "body": "note", "author": None}])
    )
    assert [entries[0]["kind"], entries[0]["path"], entries[0]["line"]] == ["comment", None, None]


def test_carries_each_threads_resolved_flag_onto_its_comments():
    """The round decides per finding, and a resolved thread is one somebody has
    already dealt with."""
    entries = pr_comments.threads(
        pull(
            threads=[
                thread(False, [{"databaseId": 1, "body": "a", "path": "p.py", "line": 4}]),
                thread(True, [{"databaseId": 2, "body": "b", "path": "q.py", "line": 5}]),
            ]
        )
    )
    assert [(entry["id"], entry["resolved"]) for entry in entries] == [(1, False), (2, True)]


def test_passes_through_a_null_line_on_an_outdated_comment():
    entries = pr_comments.threads(
        pull(
            threads=[thread(False, [{"databaseId": 1, "body": "a", "path": "p.py", "line": None}])]
        )
    )
    assert [entries[0]["path"], entries[0]["line"]] == ["p.py", None]


def test_reads_a_thread_that_lost_every_comment_as_no_findings():
    assert pr_comments.threads(pull(threads=[thread(False, [])])) == []


def test_flattens_reviews_then_comments_then_threads():
    """The order is the contract: the round reads the summaries before the
    line-level findings they refer to."""
    entries = pr_comments.flatten(
        pull(
            reviews=[review(identifier=1)],
            comments=[{"databaseId": 2, "body": "c", "author": None}],
            threads=[thread(False, [{"databaseId": 3, "body": "t", "path": "p", "line": 1}])],
        )
    )
    assert [entry["kind"] for entry in entries] == ["review", "comment", "thread"]


def test_treats_a_missing_nodes_list_as_nothing_rather_than_a_failure():
    assert pr_comments.nodes_of({"pageInfo": {}}) == []


def test_refuses_a_connection_that_is_not_an_object():
    with pytest.raises(pr_comments.Malformed):
        pr_comments.nodes_of(None)


def test_refuses_nodes_that_are_not_a_list():
    with pytest.raises(pr_comments.Malformed):
        pr_comments.nodes_of({"nodes": "reviews"})


def test_skips_a_node_that_is_not_an_object():
    assert pr_comments.nodes_of({"nodes": [None, {"databaseId": 1}]}) == [{"databaseId": 1}]


# --- paging -------------------------------------------------------------------


def test_reports_a_connections_cursor_and_whether_there_is_more():
    assert pr_comments.page(pull(paging={"reviews": (True, "r2")}), "reviews") == (True, "r2")


def test_reports_no_further_page_when_github_says_there_is_none():
    assert pr_comments.page(pull(), "reviews") == (False, None)


def test_refuses_another_page_that_names_no_cursor():
    """Sent round the same page forever, the script would hang the round that
    called it rather than failing."""
    with pytest.raises(pr_comments.Malformed) as excinfo:
        pr_comments.page(pull(paging={"comments": (True, None)}), "comments")
    assert "names no cursor" in excinfo.value.message


def test_refuses_a_connection_the_answer_does_not_carry():
    with pytest.raises(pr_comments.Malformed) as excinfo:
        pr_comments.page({}, "reviewThreads")
    assert "no reviewThreads connection" in excinfo.value.message


# --- the envelope -------------------------------------------------------------


def test_finds_the_pull_request_in_ghs_answer():
    payload = {"data": {"repository": {"pullRequest": {"reviews": {}}}}}
    assert pr_comments.pull_request(payload) == {"reviews": {}}


def test_reports_githubs_own_message_when_the_answer_carries_errors():
    """gh exits 0 on a partial answer: the data half is null and the errors half
    says why, which is the message worth forwarding."""
    payload = {
        "data": None,
        "errors": [{"message": "Could not resolve to a PullRequest with the number of 99."}],
    }
    with pytest.raises(pr_comments.Malformed) as excinfo:
        pr_comments.pull_request(payload)
    assert excinfo.value.message == "Could not resolve to a PullRequest with the number of 99."
    assert excinfo.value.status == 1


def test_names_an_error_list_that_carries_no_message():
    with pytest.raises(pr_comments.Malformed) as excinfo:
        pr_comments.pull_request({"errors": ["nope"]})
    assert excinfo.value.message == "GitHub answered with an error"


@pytest.mark.parametrize(
    "payload",
    [
        "OK",
        {},
        {"data": {"repository": None}},
        {"data": {"repository": {"pullRequest": None}}},
        {"data": "repository"},
    ],
)
def test_refuses_an_answer_with_no_pull_request_in_it(payload):
    with pytest.raises(pr_comments.Malformed):
        pr_comments.pull_request(payload)
