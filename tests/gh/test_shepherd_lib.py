"""Direct tests for `plugins/gh/scripts/lib/shepherd.py`.

These are new, not ported. The check-state fold, the merge-risk ordering and the
median CI duration lived in `lib/shepherd.jq`, `lib/shepherd-status.jq` and
`lib/ci-seconds.jq`, where kcov scored each whole program as one line however
many outcomes it decided between. `.claude/rules/type-jq.md` records what that
cost: three mutations of this fold -- narrowing the fail set so `CANCELLED` and
`TIMED_OUT` stopped counting, dropping `NEUTRAL` from the pass set, and
inverting the `COMPLETED` arm -- each left a 219-example suite green with
coverage unmoved, and the first would have reported a cancelled build as pending
and polled it forever.

So there is one named test per arm the fold can take, and each was checked by
mutation: change that arm in `lib/shepherd.py` and the test named for it goes
red on its own.
"""

from __future__ import annotations

import pytest
from lib import shepherd


def check_run(status, conclusion, name="build"):
    return {
        "__typename": "CheckRun",
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "detailsUrl": "https://github.com/acme/widgets/actions/runs/11/job/21",
    }


def status_context(state, context="ci/legacy"):
    return {
        "__typename": "StatusContext",
        "context": context,
        "state": state,
        "targetUrl": "https://ci.example/1",
    }


# --- check_state, one test per arm --------------------------------------------


@pytest.mark.parametrize("conclusion", ["SUCCESS", "NEUTRAL", "SKIPPED"])
def test_check_state_passes_the_whole_pass_set(conclusion):
    """SUCCESS, NEUTRAL and SKIPPED share the arm: finished and not in the way.

    Dropping NEUTRAL from the pass set is mutation two in the rule's list.
    """
    assert shepherd.check_state(check_run("COMPLETED", conclusion)) == "passed"


@pytest.mark.parametrize(
    "conclusion",
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"],
)
def test_check_state_fails_everything_completed_that_is_not_a_pass(conclusion):
    """Narrowing this arm is mutation one: a cancelled build polled forever.

    All of these are the same arm -- completed, and not in the pass list -- so
    one test covers them; what needs its own test is each arm, not each value.
    """
    assert shepherd.check_state(check_run("COMPLETED", conclusion)) == "failed"


def test_check_state_fails_a_completed_run_with_no_conclusion_at_all():
    """A COMPLETED run that never said how it went has not said it passed.

    Reading null as success is the one mistake this fold must not make.
    """
    assert shepherd.check_state(check_run("COMPLETED", None)) == "failed"


@pytest.mark.parametrize("status", ["QUEUED", "IN_PROGRESS", "WAITING"])
def test_check_state_calls_an_unfinished_check_run_pending(status):
    """Inverting the COMPLETED arm is mutation three."""
    assert shepherd.check_state(check_run(status, None)) == "pending"


def test_check_state_reads_a_green_status_context_by_its_state():
    """The older commit-status shape has no `conclusion` key at all."""
    assert shepherd.check_state(status_context("SUCCESS")) == "passed"


@pytest.mark.parametrize("state", ["PENDING", "EXPECTED"])
def test_check_state_calls_an_unfinished_status_context_pending(state):
    assert shepherd.check_state(status_context(state)) == "pending"


@pytest.mark.parametrize("state", ["FAILURE", "ERROR"])
def test_check_state_fails_a_red_status_context(state):
    assert shepherd.check_state(status_context(state)) == "failed"


def test_check_state_does_not_let_a_status_context_fall_through_to_conclusion():
    """A pending StatusContext has no conclusion, and must not read as failed.

    Dispatching on a `conclusion or state` chain instead of on `__typename` is
    what this asserts against: that chain calls every StatusContext failed.
    """
    row = status_context("PENDING")
    assert "conclusion" not in row
    assert shepherd.check_state(row) == "pending"


def test_check_state_calls_a_row_that_is_not_an_object_pending():
    """A null element in the rollup, which GraphQL can answer with.

    The jq took the unfinished arm for it (`null != "COMPLETED"`), and so does
    this: read as failed it would report a green pull request as broken, and
    read as an attribute error it took the whole script down with a traceback.
    """
    assert shepherd.check_state(None) == "pending"
    assert shepherd.check_state("build") == "pending"


def test_checks_calls_a_rollup_holding_a_null_row_pending():
    assert shepherd.checks({"statusCheckRollup": [None]})["state"] == "pending"


def test_check_state_reads_a_row_with_no_typename_as_a_check_run():
    """gh omits __typename unless it is asked for; the CheckRun arm is the default."""
    assert shepherd.check_state({"status": "COMPLETED", "conclusion": "SUCCESS"}) == "passed"


# --- checks, the rollup fold ---------------------------------------------------


def test_checks_calls_an_empty_rollup_none():
    assert shepherd.checks({"statusCheckRollup": []})["state"] == "none"


def test_checks_calls_a_missing_rollup_none():
    assert shepherd.checks({})["state"] == "none"


def test_checks_calls_an_all_green_rollup_passed():
    rollup = [check_run("COMPLETED", "SUCCESS", "test"), check_run("COMPLETED", "SKIPPED", "lint")]
    assert shepherd.checks({"statusCheckRollup": rollup})["state"] == "passed"


def test_checks_calls_a_rollup_with_something_running_pending():
    rollup = [check_run("COMPLETED", "SUCCESS", "test"), check_run("IN_PROGRESS", None)]
    assert shepherd.checks({"statusCheckRollup": rollup})["state"] == "pending"


def test_a_failure_wins_over_a_pending_row():
    """The loop should classify a known failure now rather than wait out the run."""
    rollup = [check_run("IN_PROGRESS", None, "test"), check_run("COMPLETED", "FAILURE")]
    assert shepherd.checks({"statusCheckRollup": rollup})["state"] == "failed"


def test_checks_names_and_links_only_the_failing_rows():
    rollup = [
        check_run("COMPLETED", "SUCCESS", "test"),
        check_run("COMPLETED", "FAILURE", "build"),
    ]
    failing = shepherd.checks({"statusCheckRollup": rollup})["failing"]
    assert failing == [
        {
            "name": "build",
            "link": "https://github.com/acme/widgets/actions/runs/11/job/21",
        }
    ]


def test_checks_names_a_status_context_by_its_context_and_target_url():
    """The two shapes name and link themselves with different keys."""
    failing = shepherd.checks({"statusCheckRollup": [status_context("FAILURE")]})["failing"]
    assert failing == [{"name": "ci/legacy", "link": "https://ci.example/1"}]


def test_a_failing_row_with_no_link_reports_a_null_one():
    row = {
        "__typename": "CheckRun",
        "name": "build",
        "status": "COMPLETED",
        "conclusion": "FAILURE",
    }
    assert shepherd.checks({"statusCheckRollup": [row]})["failing"] == [
        {"name": "build", "link": None}
    ]


# --- missing_field, one test per required field --------------------------------


def readable(**overrides):
    """A pull request carrying every field the loop decides from."""
    pull = {"state": "OPEN", "headRefOid": "sha1", "statusCheckRollup": [], "labels": []}
    pull.update(overrides)
    return pull


def test_missing_field_accepts_an_answer_carrying_all_of_them():
    assert shepherd.missing_field(readable()) == ""


def test_missing_field_refuses_an_answer_that_is_not_an_object():
    assert shepherd.missing_field([]) == "a pull request object"
    assert shepherd.missing_field(None) == "a pull request object"


@pytest.mark.parametrize("field", ["state", "headRefOid"])
def test_missing_field_names_a_field_gh_did_not_answer_with(field):
    pull = readable()
    del pull[field]
    assert shepherd.missing_field(pull) == field
    assert shepherd.missing_field(readable(**{field: None})) == field


def test_missing_field_names_the_rollup_key_when_it_is_absent():
    """Absent, not empty: an empty rollup is a real answer about a new head."""
    pull = readable()
    del pull["statusCheckRollup"]
    assert shepherd.missing_field(pull) == "statusCheckRollup"
    assert shepherd.missing_field(readable(statusCheckRollup=None)) == ""


def test_missing_field_names_labels_when_they_are_not_a_list():
    assert shepherd.missing_field(readable(labels=None)) == "labels"


def test_missing_field_refuses_the_empty_object_summary_would_have_shaped():
    """The regression: `summary({})` is a pull request whose checks read passed."""
    assert shepherd.missing_field({}) == "state"
    assert shepherd.summary({})["checks"]["state"] == "none"


# --- is_bot and is_dependabot --------------------------------------------------


def test_is_bot_reads_the_flag_gh_reports():
    assert shepherd.is_bot({"author": {"login": "app/dependabot", "is_bot": True}})


def test_is_bot_reads_the_login_when_the_flag_is_absent():
    """A GraphQL answer without the flag still names the actor."""
    assert shepherd.is_bot({"author": {"login": "dependabot"}})
    assert shepherd.is_bot({"author": {"login": "app/dependabot"}})


def test_a_human_author_is_not_a_bot():
    assert not shepherd.is_bot({"author": {"login": "someone", "is_bot": False}})


def test_a_pull_request_with_no_author_at_all_is_not_a_bot():
    assert not shepherd.is_bot({})


@pytest.mark.parametrize("login", list(shepherd.DEPENDABOT_LOGINS))
def test_every_login_dependabot_appears_under_is_dependabot(login):
    """`app/` from `gh pr view --json author`, `[bot]` from GraphQL and REST."""
    assert shepherd.is_dependabot({"author": {"login": login}})


def test_another_bot_is_a_bot_and_is_not_dependabot():
    """The distinction recreate turns on: `@dependabot recreate` is answered by one bot.

    renovate and github-actions open dependency pull requests too, and a
    recreate comment on one of theirs is a comment nothing will ever read.
    """
    renovate = {"author": {"login": "renovate[bot]", "is_bot": True}}
    assert shepherd.is_bot(renovate)
    assert not shepherd.is_dependabot(renovate)
    assert shepherd.summary(renovate)["is_bot"] is True
    assert shepherd.summary(renovate)["is_dependabot"] is False


def test_an_app_login_with_no_flag_is_still_a_bot():
    assert shepherd.is_bot({"author": {"login": "app/github-actions"}})


def test_a_human_is_neither():
    human = {"author": {"login": "someone", "is_bot": False}}
    assert not shepherd.is_bot(human)
    assert not shepherd.is_dependabot(human)


# --- rank ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "expected"),
    [("merge-risk:low", 0), (None, 1), ("merge-risk:medium", 2), ("merge-risk:high", 3)],
)
def test_rank_orders_the_bands_low_unlabelled_medium_high(label, expected):
    """Unlabelled sits between low and medium: unassessed is neither extreme."""
    labels = [{"name": "dependencies"}] + ([{"name": label}] if label else [])
    assert shepherd.rank({"labels": labels}) == expected


def test_a_band_nobody_recognises_sorts_after_all_four():
    assert shepherd.rank({"labels": [{"name": "merge-risk:unknowable"}]}) == 4


# --- ci_seconds ----------------------------------------------------------------


def run(seconds):
    return {"createdAt": "2026-01-01T00:00:00Z", "updatedAt": _plus(seconds)}


def _plus(seconds):
    minutes, secs = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"2026-01-01T{hours:02d}:{minutes:02d}:{secs:02d}Z"


def test_ci_seconds_takes_the_median_not_the_mean():
    """Sorted 30 45 50 60 900: the middle one, not the mean the outlier drags up."""
    assert shepherd.ci_seconds([run(s) for s in (30, 900, 60, 45, 50)]) == 50


def test_ci_seconds_takes_the_upper_middle_of_an_even_count():
    """jq's `sort | .[length / 2 | floor]` picked the upper of the two middles."""
    assert shepherd.ci_seconds([run(s) for s in (10, 20, 30, 40)]) == 30


def test_ci_seconds_drops_a_run_missing_a_stamp():
    runs = [run(50), {"createdAt": "2026-01-01T00:00:00Z", "updatedAt": None}]
    assert shepherd.ci_seconds(runs) == 50


def test_ci_seconds_drops_a_non_positive_duration():
    assert shepherd.ci_seconds([run(0), run(50)]) == 50


def test_ci_seconds_falls_back_when_nothing_is_usable():
    assert shepherd.ci_seconds([run(0)]) == 300


def test_ci_seconds_falls_back_on_an_empty_listing():
    assert shepherd.ci_seconds([]) == 300


def test_ci_seconds_falls_back_on_an_unparseable_stamp():
    """jq errored on the whole program for one bad stamp and the caller fell back."""
    assert shepherd.ci_seconds([{"createdAt": "yesterday", "updatedAt": "today"}]) == 300


def test_ci_seconds_falls_back_when_the_listing_is_not_rows_at_all():
    assert shepherd.ci_seconds(["nonsense"]) == 300


# --- summary and status_document -----------------------------------------------


def test_summary_carries_the_fields_the_loop_needs():
    pull = {
        "number": 1,
        "title": "build(deps): bump dep-1",
        "author": {"login": "app/dependabot", "is_bot": True},
        "state": "OPEN",
        "mergeStateStatus": "BEHIND",
        "mergeable": "MERGEABLE",
        "headRefOid": "sha1",
        "autoMergeRequest": {"mergeMethod": "MERGE"},
        "mergeCommit": None,
        "labels": [{"name": "dependencies"}],
        "createdAt": "2026-01-01T00:00:00Z",
        "statusCheckRollup": [],
    }
    assert shepherd.summary(pull) == {
        "number": 1,
        "title": "build(deps): bump dep-1",
        "author": "app/dependabot",
        "is_bot": True,
        "state": "OPEN",
        "mergeStateStatus": "BEHIND",
        "mergeable": "MERGEABLE",
        "headRefOid": "sha1",
        "autoMerge": True,
        "mergeCommit": None,
        "labels": ["dependencies"],
        "createdAt": "2026-01-01T00:00:00Z",
        "checks": {"state": "none", "failing": []},
        "is_dependabot": True,
    }


def test_summary_flattens_a_merge_commit_to_its_oid():
    assert shepherd.summary({"mergeCommit": {"oid": "abc"}})["mergeCommit"] == "abc"


def test_status_document_splits_targets_from_pull_requests_without_auto_merge():
    pulls = [
        {"number": 1, "autoMergeRequest": {"mergeMethod": "MERGE"}, "createdAt": "2026-01-01"},
        {"number": 2, "autoMergeRequest": None, "createdAt": "2026-01-02", "title": "t"},
    ]
    document = shepherd.status_document(pulls, "acme/widgets", "main", 42)
    assert [t["number"] for t in document["targets"]] == [1]
    assert document["skipped_no_automerge"] == [{"number": 2, "title": "t", "author": None}]
    assert document["repo"] == "acme/widgets"
    assert document["default_branch"] == "main"
    assert document["ci_seconds"] == 42


def test_status_document_drops_drafts_from_both_lists():
    pulls = [{"number": 1, "isDraft": True, "autoMergeRequest": None, "createdAt": "2026-01-01"}]
    document = shepherd.status_document(pulls, "acme/widgets", "main", 42)
    assert document["targets"] == []
    assert document["skipped_no_automerge"] == []
