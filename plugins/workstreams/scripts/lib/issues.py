"""Selector parsing and the issue merge for ws-issues.py.

Two kinds of thing live here. The jq program `lib/issues-merge.jq` ran -- the
flatten, the de-duplication, the sort, the projection, and the `#N` reference
scan -- and the selector classification the shell did with `case` globs and
`[[ =~ ]]` regexes. Both are plain functions so each arm can be tested directly.
Under kcov a jq program counted as one line however many decisions it held,
which is the blind spot `.claude/rules/type-py.md` describes; here every branch
is its own arm of the coverage report and its own unit test in
`tests/workstreams/test_issues.py`.

Nothing here runs a subprocess or reads the environment: the functions take
selectors and parsed gh answers and return values or raise `Invalid`. The script
owns gh, stderr, and exit codes.
"""

from __future__ import annotations

import re

# A #N directly after a letter, digit, or slash (as in a url anchor) is not a
# reference. Non-overlapping, the way jq's `scan` was.
REFERENCE = re.compile(r"(?:^|[^A-Za-z0-9/])#([0-9]+)")
NUMBER = re.compile(r"^[0-9]+$")
RANGE = re.compile(r"^([0-9]+)-([0-9]+)$")

# The two selectors that become a `gh issue list` call, and the flag each takes.
LIST_SELECTORS = ("label", "milestone")

DIGITS = "0123456789"

# The --limit ws-issues.py gives gh when the environment names none, and so the
# widest range a single selector may name. The script passes the limit actually
# in force; this is what `classify` falls back to when called without one.
DEFAULT_LIMIT = 200


class Invalid(Exception):
    """A selector the script must refuse, with the message and exit status to use.

    Every selector this module rejects is a usage error, so the status is always
    2. It carries one anyway, the way `state.Invalid` does, because that pair is
    what `cli.run` reports: nothing in `lib/` imports another `lib/` module, so
    each one raises its own class and the script names it when it calls `run`.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
        self.status = 2


def _starts_with_digit(text: str) -> bool:
    """ASCII digits only, the way the shell's `[0-9]` glob meant it.

    `str.isdigit` is true for Arabic-Indic and superscript digits too, none of
    which `int()` further down would accept in a range.
    """
    return bool(text) and text[0] in DIGITS


def classify(selector: str, limit: int = DEFAULT_LIMIT):
    """What one selector is, as a (kind, payload) pair.

    ("list", (flag, value))   label: or milestone:, one `gh issue list` call
    ("numbers", [n, ...])     a number, a #number, or an inclusive range
    ("search", text)          anything else, joined into one search query

    The order of the tests is the order of the shell's `case` arms, which
    decides the ambiguous inputs: `label:` wins over everything, and a selector
    that starts like a number but is not one (`1,3`, `1O`) is refused as a typo
    rather than quietly becoming search text.

    `limit` is the issue limit the run is working under. A range wider than it
    is refused here, before a single gh call goes out: `1-9999999999` asked for
    ten billion `gh issue view` calls, and the list it built to hold them was
    what raised an OverflowError before any of them ran.
    """
    if not selector:
        raise Invalid("empty selector")
    for prefix in LIST_SELECTORS:
        if selector.startswith(prefix + ":"):
            value = selector[len(prefix) + 1 :]
            if not value:
                raise Invalid(f"empty value in selector: {selector}")
            return ("list", (f"--{prefix}", value))
    # One leading '#' is dropped, and only when a digit follows it: `##5` and
    # `#abc` are search text, not malformed numbers.
    if selector.startswith("#") and _starts_with_digit(selector[1:]):
        body = selector[1:]
    elif _starts_with_digit(selector):
        body = selector
    else:
        return ("search", selector)
    span = RANGE.match(body)
    if span:
        low, high = int(span.group(1)), int(span.group(2))
        if low > high:
            raise Invalid(f"bad range: {selector}")
        if high - low + 1 > limit:
            raise Invalid(f"range wider than the {limit}-issue limit: {selector}")
        return ("numbers", list(range(low, high + 1)))
    if NUMBER.match(body):
        return ("numbers", [int(body)])
    raise Invalid(f"not a number, range, label:, or milestone: selector: {selector}")


def refs(body: str, number) -> list:
    """The other issue numbers a body mentions as #N, once each, in numeric order.

    The issue's own number is dropped: an issue that refers to itself for the
    reader's benefit ("tracked here as #3") is not blocked on itself.
    """
    found = {int(match) for match in REFERENCE.findall(body or "")}
    found.discard(number)
    return sorted(found)


def project(record: dict) -> dict:
    """One gh issue reduced to the fields the plan skill reads.

    A null body becomes "" so every consumer can treat it as a string, and
    labels become plain names because nothing downstream wants their colours.
    """
    body = record.get("body") or ""
    return {
        "number": record.get("number"),
        "title": record.get("title"),
        "state": record.get("state"),
        "url": record.get("url"),
        "body": body,
        "labels": [label.get("name") for label in record.get("labels") or []],
        "refs": refs(body, record.get("number")),
    }


def merge(answers) -> list:
    """Every gh answer flattened into one array, de-duplicated, sorted, projected.

    `answers` holds what each gh call returned: `issue list` gives an array,
    `issue view` gives one object. An issue named by two selectors is kept once,
    the first time it was seen, which is what jq's `unique_by` did and which
    matters not at all while the records are identical -- but would matter if a
    later gh field ever differed between a list and a view.
    """
    records = []
    for answer in answers:
        if isinstance(answer, list):
            records.extend(answer)
        else:
            records.append(answer)
    first = {}
    for record in records:
        number = record.get("number")
        if number not in first:
            first[number] = record
    return [project(first[number]) for number in sorted(first)]
