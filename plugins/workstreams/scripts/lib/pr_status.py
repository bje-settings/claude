"""The fold ws-pr-status.py runs over `gh pr view --json`.

What the jq program `lib/pr-status.jq` held: the per-row outcome, the set of
outcomes that count as failure, the name a row is reported under, the fold to
one word, and the projection the run loop reads. Each is a plain function with a
unit test per arm in `tests/workstreams/test_pr_status.py`, because under kcov
the whole fold was one line however many outcomes it decided between -- the
blind spot `.claude/rules/type-jq.md` describes.

Nothing here runs gh or touches the filesystem: `reduce` takes the parsed answer
and returns the object to print.
"""

from __future__ import annotations

# A check in any of these states needs a human or a rerun before the PR can
# merge. STALE is in the list because GitHub keeps the old (passing) conclusion
# on a check whose run no longer matches the head commit; treating it as a pass
# would report a PR as green on a result nobody produced for this diff.
FAILED = (
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
)
# Everything that is finished and not in the way. NEUTRAL and SKIPPED are not
# successes, but neither blocks a merge, so the fold counts them with SUCCESS.
PASSED = ("SUCCESS", "NEUTRAL", "SKIPPED")

PENDING = "PENDING"


class Malformed(Exception):
    """An answer from gh this fold cannot read, with the message to report.

    The status is 1, gh's own: a rollup that is not a list of objects is gh (or
    a GitHub schema change) answering with something else, not the caller
    mistyping an argument. It carries the pair `cli.run` reports, and the script
    names the class when it calls `run`, the way `issues.Invalid` is handled:
    nothing under `lib/` imports another `lib/` module.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
        self.status = 1


def coalesce(*values):
    """The first value that is neither null nor false, the way jq's `//` chose.

    Not Python's `or`: an empty string is a value jq's `//` keeps, and `0` and
    `[]` are too. Only null and false fall through.
    """
    for value in values:
        if value is not None and value is not False:
            return value
    return None


def present(value):
    """The value unless it is absent, where "" counts as absent as null does.

    GitHub reports a check that has not concluded either way as null or, on
    some rows, as the empty string, so the two are one case here. `false` joins
    them: it is not a state either, and without this the fold would upper-case
    it into the outcome FALSE, which is in neither the failed nor the passed
    set and would quietly report the whole rollup as pending.
    """
    return None if value is None or value is False or value == "" else value


def outcome(row: dict) -> str:
    """One rollup row reduced to a single upper-case state.

    CheckRun rows carry `conclusion`; StatusContext rows carry `state`. A row
    with neither typename is read by whichever of the two fields it has, so a
    rollup shape GitHub adds later still folds rather than crashing. Anything
    still absent is PENDING: a completed CheckRun with no conclusion has not
    told us it passed, and reading that as success is the one mistake this fold
    must not make.
    """
    typename = row.get("__typename")
    if typename == "CheckRun":
        state = present(row.get("conclusion"))
    elif typename == "StatusContext":
        state = present(row.get("state"))
    else:
        state = coalesce(present(row.get("conclusion")), present(row.get("state")))
    if state is None:
        return PENDING
    return str(state).upper()


def failed(state: str) -> bool:
    return state in FAILED


def check_name(row: dict) -> str:
    """What a failing check is called: a CheckRun's name, a StatusContext's context."""
    return coalesce(row.get("name"), row.get("context"), "unnamed")


def fold(rows) -> str:
    """The whole rollup as one word: fail beats pending beats pass.

    `none` is not `pass`: a PR whose workflows have not queued yet has proved
    nothing, and the run loop treats the two differently.
    """
    outcomes = [outcome(row) for row in rows]
    if not outcomes:
        return "none"
    if any(failed(state) for state in outcomes):
        return "fail"
    if all(state in PASSED for state in outcomes):
        return "pass"
    return "pending"


def failing(rows) -> list:
    """The names of the checks that failed, in rollup order, for the pause question."""
    return [check_name(row) for row in rows if failed(outcome(row))]


def reduce(document: dict) -> dict:
    """One pull request reduced to the fields the run loop decides on.

    The rollup is checked before it is folded, so a shape gh never answers with
    is named rather than raising an AttributeError from inside `outcome`: the
    run loop records a reported failure with its message, and an internal error
    with a traceback's worth of nothing.
    """
    rollup = coalesce(document.get("statusCheckRollup"), [])
    if not isinstance(rollup, list) or not all(isinstance(row, dict) for row in rollup):
        raise Malformed(
            "statusCheckRollup is not a list of objects for PR {}".format(document.get("number"))
        )
    return {
        "number": document.get("number"),
        "url": document.get("url"),
        "title": document.get("title"),
        "state": document.get("state"),
        "draft": document.get("isDraft"),
        "base": document.get("baseRefName"),
        "head": document.get("headRefName"),
        "headSha": document.get("headRefOid"),
        "mergeable": coalesce(document.get("mergeable"), "UNKNOWN"),
        "checks": fold(rollup),
        "failing": failing(rollup),
        "reviewDecision": coalesce(document.get("reviewDecision"), ""),
    }
