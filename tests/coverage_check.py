#!/usr/bin/env python3
"""Fail if line coverage is below a threshold.

Used by the CI coverage job and by contributors locally. Prints the per-file
numbers and the uncovered lines whether or not it fails, so a drop says which
file moved rather than only that the total fell.

It reads a cobertura report. coverage.py's report also marks partially covered
branches; where that data is present the partly-taken lines are listed beside
the uncovered ones, and where it is absent nothing changes. The gate itself is
the root line-rate either way, so a partial branch is reported but never fails a
build on its own.

Stdlib only, and 3.9-compatible: the CI coverage job runs this with the runner's
system python3, outside the uv environment, so that a broken dev environment
cannot be what decides whether a build passes.

  coverage_check.py <cobertura.xml> [threshold]

Exit codes: 0 the report clears the threshold; 1 a legible report that does not
(below the threshold, or nothing measured at all); 2 the caller's fault, which is
bad usage or a report that cannot be read. The split matters to whoever reads the
build: 1 is a coverage problem to go and fix, 2 is a broken invocation or a
broken report and says nothing about coverage either way.
"""

import sys
import xml.etree.ElementTree as ET

DEFAULT_THRESHOLD = 95.0
USAGE = "usage: coverage_check.py <cobertura.xml> [threshold]\n"


class UsageError(Exception):
    """The caller got the arguments wrong."""


class UnreadableReport(Exception):
    """The XML parsed, but a value this script must have is missing or malformed.

    Grouped with a genuine parse failure rather than with a coverage failure: a
    line-rate that is not a number says nothing about coverage, and reporting it
    as 0% would fail a build for the wrong reason.
    """


class ReportError(Exception):
    """The report is legible, and its answer is not one that can pass."""


def parse_threshold(text):
    """The threshold as a percentage, or a usage error.

    A threshold that is not a number, or is outside 0-100, is a mistake in the
    caller rather than a coverage failure, and must not be reported as one: a
    typo that silently became 0.0 would turn the gate off and still exit 0.
    """
    try:
        value = float(text)
    except (TypeError, ValueError):
        raise UsageError(f"threshold is not a number: {text}") from None
    # The range check also rejects NaN: every comparison with it is False, so
    # a NaN threshold would otherwise let any coverage level through.
    if not 0 <= value <= 100:
        raise UsageError(f"threshold must be between 0 and 100: {text}")
    return value


def rate_of(element, where, attribute="line-rate"):
    """A cobertura rate attribute as a percentage.

    `where` names the element in the message, so a malformed report says which
    file to look at rather than only that something in it was wrong.
    """
    raw = element.get(attribute)
    if raw is None:
        raise UnreadableReport(f"{where} has no {attribute}")
    try:
        return float(raw) * 100
    except ValueError:
        raise UnreadableReport(f"{where} has an unreadable {attribute}: {raw}") from None


def partial_branches(cls):
    """Line numbers whose branches were only partly taken, in document order.

    coverage.py writes branch="true" with condition-coverage="50% (1/2)" on such
    a line; a report carrying no branch attributes at all yields nothing here and
    the caller prints nothing extra. A line that was never hit is left
    to the uncovered list rather than counted twice, and a branch line carrying no
    condition-coverage at all says nothing either way and is skipped.
    """
    numbers = []
    for line in cls.iter("line"):
        if line.get("branch") != "true" or line.get("hits") == "0":
            continue
        condition = line.get("condition-coverage")
        if not condition or condition.startswith("100%"):
            continue
        # A line element with no number is not worth raising over; say so and
        # let the rest of the report through.
        numbers.append(line.get("number", "?"))
    return numbers


def report(path, threshold):
    root = ET.parse(path).getroot()
    classes = sorted(root.iter("class"), key=lambda c: c.get("filename") or "")
    # An empty report is the failure this script exists to catch: a run that
    # measured nothing has a line-rate of 0 or 1 depending on the tool, and either
    # way "no files" must not be mistaken for an answer about the files.
    if not classes or root.get("lines-valid") == "0":
        raise ReportError("report contains no measured files")

    for cls in classes:
        filename = cls.get("filename") or "(unnamed file)"
        rate = rate_of(cls, filename)
        uncovered = [
            line.get("number", "?") for line in cls.iter("line") if line.get("hits") == "0"
        ]
        suffix = "  uncovered: " + ",".join(uncovered) if uncovered else ""
        partial = partial_branches(cls)
        if partial:
            suffix += "  partial branches: " + ",".join(partial)
        print(f"  {rate:6.2f}%  {filename}{suffix}")

    overall = rate_of(root, "report root")
    print(f"\noverall: {overall:.2f}%   threshold: {threshold:.2f}%")
    return overall


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(USAGE)
        return 2
    try:
        threshold = parse_threshold(argv[2]) if len(argv) > 2 else DEFAULT_THRESHOLD
    except UsageError as error:
        sys.stderr.write(f"{error}\n{USAGE}")
        return 2
    try:
        overall = report(argv[1], threshold)
    except (OSError, ET.ParseError, UnreadableReport) as error:
        sys.stderr.write(f"FAIL: cannot read {argv[1]}: {error}\n")
        return 2
    except ReportError as error:
        sys.stderr.write(f"FAIL: {error}\n")
        return 1
    # A hair of tolerance, so a value that prints as exactly the threshold is not
    # rejected by binary floating point.
    if overall < threshold - 1e-9:
        sys.stderr.write("FAIL: coverage is below the threshold\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
