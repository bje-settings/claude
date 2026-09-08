"""One pull request's check rollup folded into a single verdict.

The port of `checks.jq`, read by `ft-wait-pr.py`. Input is the pull request as
`gh pr view --json state,isDraft,statusCheckRollup` returns it; output is
`{state, draft, checks, failing}`, where `checks` is "pass", "fail", "pending"
or "none".

The arms matter more than they look. A cancelled or timed-out run reported as
pending is a loop that waits forever for a run that already ended; a completed
run with no conclusion reported as passed is a merge on an answer that has not
arrived. Under kcov the jq program was one line however many decisions it held,
which is the blind spot `.claude/rules/type-py.md` describes; here each arm is
its own branch in the report and its own unit test in
`tests/field-test/test_checks.py`.

An answer this cannot read raises ValueError rather than guessing at it, the way
jq exited non-zero and sent the script to its "gh answered with something this
cannot read" arm.
"""

from __future__ import annotations

PASS_CONCLUSIONS = ("SUCCESS", "SKIPPED", "NEUTRAL")
PASS_STATES = ("SUCCESS", "EXPECTED")
PENDING_STATES = ("PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED")


def default(value, fallback):
    """jq's `//`: null and false take the fallback, everything else stands.

    Not Python's `or`, which would also replace an empty string and a zero. The
    only field here where that shows is `state`, and an empty state must not
    silently become "UNKNOWN" and read as an answer gh never gave.
    """
    return fallback if value is None or value is False else value


def verdict(entry) -> str:
    """ "pass", "fail" or "pending" for one check.

    Two shapes arrive in the same array. A StatusContext is external CI reporting
    a commit status and carries `state`; everything else is a CheckRun, whose
    answer is `conclusion` and only once `status` says COMPLETED.
    """
    if not isinstance(entry, dict):
        raise ValueError("a check in the rollup is not an object")
    if entry.get("__typename") == "StatusContext":
        state = entry.get("state")
        if state in PASS_STATES:
            return "pass"
        if state in PENDING_STATES:
            return "pending"
        return "fail"
    if entry.get("status") != "COMPLETED":
        return "pending"
    if entry.get("conclusion") is None:
        # A completed run with no conclusion is an answer that has not landed
        # yet, not a pass. Merging on it is merging on nothing.
        return "pending"
    if entry.get("conclusion") in PASS_CONCLUSIONS:
        return "pass"
    # CANCELLED, TIMED_OUT, ACTION_REQUIRED, STALE: all of them ended, and none
    # of them ended well. Calling any of them pending waits for a run that is
    # already over.
    return "fail"


def name_of(entry) -> str:
    """What to call a check in the `failing` list: CheckRun name, else context."""
    return default(entry.get("name"), default(entry.get("context"), "check"))


def fold(document):
    """{state, draft, checks, failing} for one pull request."""
    if not isinstance(document, dict):
        raise ValueError("the pull request is not an object")
    rollup = default(document.get("statusCheckRollup"), [])
    if not isinstance(rollup, list):
        raise ValueError("statusCheckRollup is not an array")
    folded = [{"name": name_of(entry), "verdict": verdict(entry)} for entry in rollup]
    verdicts = [entry["verdict"] for entry in folded]
    if not folded:
        checks = "none"
    elif "fail" in verdicts:
        # A failure outranks a run still going: there is nothing left to wait for.
        checks = "fail"
    elif "pending" in verdicts:
        checks = "pending"
    else:
        checks = "pass"
    return {
        "state": default(document.get("state"), "UNKNOWN"),
        "draft": default(document.get("isDraft"), False),
        "checks": checks,
        "failing": [entry["name"] for entry in folded if entry["verdict"] == "fail"],
    }
