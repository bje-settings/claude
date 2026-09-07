"""What a field-test report claimed about each pull request, against GitHub.

The port of `verify.jq`, read by `ft-verify-report.py`. `compare` takes the
report's claims and what `gh pr view` answered for each one, and returns
`{ok, checked, matched, mismatches, results}`.

This exists because a worker's own report is a claim. The first pass of the
hardening loop, run by hand, had to be checked pull request by pull request
against `gh pr view`, and twice the report was wrong. A mismatch here is a
finding like any other: it goes back through the issue path.

`claimed` is the vocabulary a report uses. Anything outside it is a mismatch
rather than a pass, because a claim nobody can check is not evidence. Each arm
below is its own branch in the coverage report and its own unit test in
`tests/field-test/test_verify.py`, which the jq program it replaces could not be.
"""

from __future__ import annotations

CLAIMS = ("merged", "closed", "open", "skipped")

# The one gh failure that is an answer: the pull request is not there. Every
# other failure is gh not answering, which is a different thing entirely.
NO_SUCH_PR = "Could not resolve"

STATES = {"MERGED": "merged", "CLOSED": "closed", "OPEN": "open"}

# What a failure record says when gh failed without saying anything. A gh that
# exits non-zero with nothing on stderr is still a failure, and it must not read
# as an answer with no state, which the report would then be blamed for.
NO_REASON = "gh failed without a message"

# The reason text the harden skill keys on: a mismatch that says this is not a
# finding about the target, and the skill retries the run rather than filing it.
UNREADABLE = "could not be read on GitHub"


def failed(record) -> bool:
    """Whether one gh call failed, as the record itself says.

    An explicit flag rather than a non-empty error string: gh can exit non-zero
    with nothing on stderr, and inferring failure from the message read that as
    an answer carrying no state -- a mismatch filed against the target for a
    call that never happened.
    """
    return bool(record.get("failed"))


def actual_of(state) -> str:
    """GitHub's state in the report's own vocabulary, or "unknown"."""
    return STATES.get(state, "unknown")


def satisfies(claimed: str, actual: str) -> bool:
    """Whether what GitHub says is what the report claimed.

    skipped and open are the same outcome seen from two sides: the pull request
    is still there, untouched, which is what a skip means.
    """
    if claimed == "merged":
        return actual == "merged"
    if claimed == "closed":
        return actual == "closed"
    if claimed in ("open", "skipped"):
        return actual == "open"
    return False


def reason(claimed: str, actual: str, error: str, broke: bool = False) -> str:
    """Why one claim did not hold, in the words the loop puts in an issue.

    `broke` is the record's own failure flag, not a guess from `error`: gh can
    fail with nothing to say, and that is still a claim nobody checked.
    """
    if broke:
        return UNREADABLE + ": " + (error or NO_REASON)
    if claimed not in CLAIMS:
        return "the report used a word this cannot check: " + str(claimed)
    return "the report said " + claimed + "; GitHub says " + actual


def answer_for(actual, number):
    """The gh answer for one pull request, or a stand-in saying there was none.

    A pull request gh could not answer for is a mismatch, not a pass: a claim
    nobody checked is exactly what this script exists to catch. That holds one
    pull request at a time; a gh that answered for none of them is `answered`
    above, and the script exits 4 before it gets here.
    """
    for record in actual:
        if record.get("number") == number:
            return record
    return {"failed": True, "error": "no answer from gh pr view"}


def answered(actual) -> bool:
    """Whether gh answered at all, as opposed to failing the same way repeatedly.

    A pull request gh could not answer for is a mismatch the report has to own,
    but only while gh was answering. A gh that is not on PATH, one whose token
    expired, one whose every call failed with the same message: those check
    nothing, and reporting one mismatch per claim would file an issue against
    the target for each pull request in the report, blaming it for a broken
    tool. "Could not resolve" is the exception, and the reason this is not just
    a count of failures: gh answered, and the answer is that the pull request
    the report named does not exist.

    An outage does not have to be total to be an outage. A round where the first
    claim came back and the other nine failed with one identical message -- a
    rate limit, a token that expired mid-run, a network that went away -- filed
    nine issues against the target, because one answer was enough to call gh
    healthy. The same failure twice is that tool, not that report; two different
    failures among answers stay the report's to own, since a one-off per pull
    request is what a genuinely missing or moved pull request looks like.
    """
    failures = [record for record in actual if failed(record)]
    if not failures:
        return True
    errors = [
        record.get("error") or ""
        for record in failures
        if NO_SUCH_PR not in (record.get("error") or "")
    ]
    if not errors:
        # Every failure is a pull request GitHub says is not there, which is an
        # answer: each one is a mismatch the report owns.
        return True
    if len(failures) == len(actual):
        # Nothing came back at all, so nothing was checked.
        return False
    return not (len(errors) > 1 and len(set(errors)) == 1)


def compare(claims, actual):
    """{ok, checked, matched, mismatches, results} for one report."""
    results = []
    for claim in claims:
        number = claim.get("number")
        claimed = claim.get("claimed") or ""
        answer = answer_for(actual, number)
        error = answer.get("error") or ""
        broke = failed(answer)
        state = "unknown" if broke else actual_of(answer.get("state") or "")
        match = not broke and satisfies(claimed, state)
        results.append(
            {
                "number": number,
                "claimed": claimed,
                "actual": state,
                "match": match,
                "reason": None if match else reason(claimed, state, error, broke),
            }
        )
    mismatches = [result for result in results if not result["match"]]
    return {
        "ok": not mismatches,
        "checked": len(results),
        "matched": len(results) - len(mismatches),
        "mismatches": mismatches,
        "results": results,
    }
