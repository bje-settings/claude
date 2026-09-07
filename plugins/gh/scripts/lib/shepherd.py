#!/usr/bin/env python3
"""lib/shepherd.py — the reading and shaping both shepherd scripts share.

What the shell library and the three jq programs beside it held between them:
the `--json` field list, the fold that turns a `statusCheckRollup` into one word,
the pull-request summary the loop reads, the merge-risk ordering, and the median
CI duration.

Every decision here is a plain function with a unit test per arm in
`tests/gh/test_shepherd_lib.py`. Under kcov the jq versions were one line each
however many outcomes they decided between, which is the blind spot
`.claude/rules/type-jq.md` describes: three mutations of the check-state fold
left a 219-example suite green.

Nothing here runs `gh` or touches the filesystem: the callers hand in parsed
JSON and get back the object to print.
"""

from __future__ import annotations

import calendar
import time

# The --json field list both scripts ask gh for.
PR_FIELDS = (
    "number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,"
    "mergeable,headRefOid,statusCheckRollup,createdAt,state,mergeCommit"
)

# A CheckRun conclusion that does not stand in the way of a merge. NEUTRAL and
# SKIPPED are not successes, but neither blocks one, so the fold counts them
# with SUCCESS. Everything else that has COMPLETED -- FAILURE, CANCELLED,
# TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, and a COMPLETED run whose
# conclusion is still null -- is a failure. Reading any of those as pending is
# the mistake that polls a cancelled build forever.
PASSING_CONCLUSIONS = ("SUCCESS", "NEUTRAL", "SKIPPED")

# The older commit-status API's two "not finished yet" states.
PENDING_STATES = ("PENDING", "EXPECTED")

# What the shepherd loop falls back to when a repository has no usable run
# history: a repo without Actions, or one whose runs all measured non-positive.
DEFAULT_CI_SECONDS = 300

# The fields every decision in the loop is made from. gh answering without one
# of them is not a pull request in a state worth acting on, it is an answer that
# cannot be read, and `summary` would turn it into a plausible-looking document
# whose `checks.state` is `none` and whose `state` is null -- which the wait
# action reads as "passed".
# The logins Dependabot appears under. `gh pr view --json author` prefixes an
# app with `app/`; the GraphQL and REST answers use the `[bot]` suffix.
DEPENDABOT_LOGINS = (
    "dependabot",
    "app/dependabot",
    "dependabot[bot]",
    "app/dependabot[bot]",
)

# gh-security's bands, in the order the loop should take them. An unlabelled
# pull request sits between low and medium: it has not been assessed, which is
# not a reason to go last and not a reason to go first.
RISK_ORDER = ("merge-risk:low", "", "merge-risk:medium", "merge-risk:high")


def check_state(row):
    """One `statusCheckRollup` row as passed, pending, or failed.

    The rollup mixes two shapes. A CheckRun (GitHub Actions and most apps) has
    `status` (QUEUED, IN_PROGRESS, COMPLETED) and `conclusion` (SUCCESS,
    FAILURE, NEUTRAL, SKIPPED, ...). A StatusContext (the older commit-status
    API) has a single `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED),
    names itself with `context` rather than `name`, links with `targetUrl`
    rather than `detailsUrl`, and carries no `conclusion` key at all (checked
    against a real Vercel status row).

    So the dispatch is on `__typename`, never on a field falling through: a
    `conclusion or state` chain reads the wrong row shape silently, calling a
    pending StatusContext a failure because it has no conclusion.

    A row that is not an object at all -- a null element in the rollup, which
    GraphQL can answer with -- is pending, which is what the jq did: `null !=
    "COMPLETED"` took the unfinished arm. Reading it as failed would report a
    green pull request as broken.
    """
    if not isinstance(row, dict):
        return "pending"
    if row.get("__typename") == "StatusContext":
        state = row.get("state")
        if state == "SUCCESS":
            return "passed"
        if state in PENDING_STATES:
            return "pending"
        return "failed"
    if row.get("status") != "COMPLETED":
        return "pending"
    if row.get("conclusion") in PASSING_CONCLUSIONS:
        return "passed"
    return "failed"


def check_name(row):
    """What a check is called: a CheckRun's name, a StatusContext's context."""
    name = row.get("name")
    if name is None:
        name = row.get("context")
    return name


def check_link(row):
    """Where a check reports: a CheckRun's detailsUrl, a StatusContext's targetUrl."""
    link = row.get("detailsUrl")
    if link is None:
        link = row.get("targetUrl")
    return link


def checks(pull):
    """The whole rollup as `{state, failing}`.

    `state` is one of none, failed, pending, passed. A failure wins over a
    pending row on purpose: the loop should classify a known failure now rather
    than wait out the rest of the run. `none` is not `passed` to the reader
    either -- the caller reports it with its own detail -- but it is the state a
    pull request whose workflows have not queued yet is in.
    """
    rollup = pull.get("statusCheckRollup") or []
    results = [check_state(row) for row in rollup]
    if not results:
        state = "none"
    elif "failed" in results:
        state = "failed"
    elif "pending" in results:
        state = "pending"
    else:
        state = "passed"
    return {
        "state": state,
        "failing": [
            {"name": check_name(row), "link": check_link(row)}
            for row, result in zip(rollup, results)
            if result == "failed"
        ],
    }


def missing_field(pull):
    """The first required field gh did not answer with, or "" when all are there.

    `summary` shapes whatever it is given, so an empty object comes back as a
    pull request whose state is null and whose rollup is empty -- and `wait`
    reads an empty rollup as "nothing to watch, passed". The caller checks this
    first and fails closed instead.

    `statusCheckRollup` is checked for presence rather than for content: an
    empty rollup is a real answer about a pull request whose workflows have not
    queued yet. `labels` is checked for being a list, which is what gh answers
    with when a pull request carries none.
    """
    if not isinstance(pull, dict):
        return "a pull request object"
    # The four fields the loop decides on; the checks differ per field, so the
    # list lives here rather than in a constant nothing else reads.
    for field in ("state", "headRefOid"):
        if not pull.get(field):
            return field
    if "statusCheckRollup" not in pull:
        return "statusCheckRollup"
    if not isinstance(pull.get("labels"), list):
        return "labels"
    return ""


def is_dependabot(pull):
    """Whether Dependabot itself authored this pull request.

    `@dependabot recreate` is answered by one bot and ignored by every other, so
    this is deliberately a login match and not the general bot flag: renovate
    and github-actions are bots whose pull requests a recreate comment would
    only litter.
    """
    return ((pull.get("author") or {}).get("login") or "") in DEPENDABOT_LOGINS


def is_bot(pull):
    """Whether any bot authored this pull request.

    `author.is_bot` is what gh reports, but the login is checked too: a GraphQL
    answer that omits the flag still names the actor, and an app appears as
    `app/<name>` from `gh pr view` and as `<name>[bot]` elsewhere. This is the
    flag the report carries; what `recreate` acts on is `is_dependabot`.
    """
    author = pull.get("author") or {}
    if author.get("is_bot") is True:
        return True
    login = author.get("login") or ""
    return login.endswith("[bot]") or login.startswith("app/") or is_dependabot(pull)


def summary(pull):
    """The pull request as every action reports it.

    Key order is the contract: the agent reads fields by name, but the JSON is
    also read by a human in a transcript, and the shell version printed them in
    this order. A field added since goes on the end, so the order of the ones
    that were already there still holds.

    Nothing here validates: `missing_field` does that, and the callers run it
    before they get here.
    """
    author = pull.get("author") or {}
    merge_commit = pull.get("mergeCommit") or {}
    return {
        "number": pull.get("number"),
        "title": pull.get("title"),
        "author": author.get("login"),
        "is_bot": is_bot(pull),
        "state": pull.get("state"),
        "mergeStateStatus": pull.get("mergeStateStatus"),
        "mergeable": pull.get("mergeable"),
        "headRefOid": pull.get("headRefOid"),
        "autoMerge": pull.get("autoMergeRequest") is not None,
        "mergeCommit": merge_commit.get("oid"),
        "labels": [label.get("name") for label in (pull.get("labels") or [])],
        "createdAt": pull.get("createdAt"),
        "checks": checks(pull),
        "is_dependabot": is_dependabot(pull),
    }


def rank(pull):
    """The merge-risk band as a sort key: low, unlabelled, medium, high.

    The first `merge-risk:` label wins, as jq's `first` did. A band nobody
    recognises sorts after all four rather than being read as one of them.
    """
    for label in pull.get("labels") or []:
        name = label.get("name") or ""
        if name.startswith("merge-risk:"):
            if name in RISK_ORDER:
                return RISK_ORDER.index(name)
            return len(RISK_ORDER)
    return RISK_ORDER.index("")


def _epoch(stamp):
    """An ISO 8601 stamp in seconds, the way jq's `fromdateiso8601` read one.

    Raises ValueError on anything else, which is how a malformed run listing
    ends up at the 300 second fallback rather than at a wrong median.
    """
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


def ci_seconds(runs):
    """The median wall time of the given workflow runs, or 300 for none usable.

    A run's wall time is `updatedAt - createdAt`; `startedAt` can be null for a
    run that was queued and never started, so it is not used. Failures are kept:
    a failing run took as long as it took, and the loop is sizing a wait rather
    than judging health. Runs missing either stamp, or with a non-positive
    duration, are dropped.

    The median is the upper of the two middles for an even count, which is what
    jq's `sort | .[length / 2 | floor]` picked, so the two agree on every input.
    """
    durations = []
    try:
        for run in runs or []:
            created = run.get("createdAt")
            updated = run.get("updatedAt")
            if created is None or updated is None:
                continue
            duration = _epoch(updated) - _epoch(created)
            if duration > 0:
                durations.append(duration)
    except (AttributeError, TypeError, ValueError):
        # jq errored on the whole program for one unparseable stamp and the
        # caller fell back; a row that is not an object reaches here the same
        # way. One bad row means the listing is not an answer about durations.
        return DEFAULT_CI_SECONDS
    if not durations:
        return DEFAULT_CI_SECONDS
    return sorted(durations)[len(durations) // 2]


def status_document(pulls, repo, default_branch, ci):
    """The whole `gh-shepherd-status.py` report.

    Drafts are out of scope entirely. Of what is left, a pull request a human
    has already marked for auto-merge is a target; one without it is reported
    under `skipped_no_automerge` and never enabled, because auto-merge is the
    human's signal that the pull request is wanted.
    """
    open_prs = [pull for pull in pulls if not pull.get("isDraft")]
    targets = [pull for pull in open_prs if pull.get("autoMergeRequest") is not None]
    targets.sort(key=lambda pull: (rank(pull), pull.get("createdAt") or ""))
    skipped = [pull for pull in open_prs if pull.get("autoMergeRequest") is None]
    skipped.sort(key=lambda pull: pull.get("createdAt") or "")
    return {
        "repo": repo,
        "default_branch": default_branch,
        "ci_seconds": ci,
        "targets": [summary(pull) for pull in targets],
        "skipped_no_automerge": [
            {
                "number": pull.get("number"),
                "title": pull.get("title"),
                "author": (pull.get("author") or {}).get("login"),
            }
            for pull in skipped
        ],
    }
