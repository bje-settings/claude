#!/usr/bin/env python3
"""Fail if line coverage is below a threshold.

Used by CI in place of shellspec's --fail-low-coverage, which reports a failure
at any coverage level once enabled, and by spec/run.sh for both reports. Prints
the per-file numbers and the uncovered lines either way, so a drop says which
file moved rather than only that the total fell.

It reads both cobertura reports the repo produces: kcov's, which carries lines
only, and coverage.py's, which also marks partially covered branches. Where
branch data is present the partly-taken lines are listed beside the uncovered
ones; where it is absent nothing changes. The gate itself is the root line-rate
in both cases.

Stdlib only, and 3.9-compatible: the CI coverage job runs this with the runner's
system python3, outside the uv environment.

  coverage_check.py <cobertura.xml> [threshold]
"""

import sys
import xml.etree.ElementTree as ET

DEFAULT_THRESHOLD = 95.0


def partial_branches(cls):
    """Line numbers whose branches were only partly taken, in document order.

    coverage.py writes branch="true" with condition-coverage="50% (1/2)" on such
    a line; kcov writes no branch attributes at all, so this is empty for its
    report and the caller prints nothing extra.
    """
    numbers = []
    for line in cls.iter("line"):
        if line.get("branch") != "true" or line.get("hits") == "0":
            continue
        condition = line.get("condition-coverage") or ""
        if condition.startswith("100%"):
            continue
        numbers.append(line.get("number"))
    return numbers


def report(path, threshold):
    root = ET.parse(path).getroot()
    classes = sorted(root.iter("class"), key=lambda c: c.get("filename") or "")
    for cls in classes:
        rate = float(cls.get("line-rate", 0)) * 100
        uncovered = [line.get("number") for line in cls.iter("line") if line.get("hits") == "0"]
        suffix = "  uncovered: " + ",".join(uncovered) if uncovered else ""
        partial = partial_branches(cls)
        if partial:
            suffix += "  partial branches: " + ",".join(partial)
        print("  {:6.2f}%  {}{}".format(rate, cls.get("filename"), suffix))

    overall = float(root.get("line-rate", 0)) * 100
    print(f"\noverall: {overall:.2f}%   threshold: {threshold:.2f}%")
    return overall


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: coverage_check.py <cobertura.xml> [threshold]\n")
        return 2
    threshold = float(argv[2]) if len(argv) > 2 else DEFAULT_THRESHOLD
    overall = report(argv[1], threshold)
    # A hair of tolerance, so a value that prints as exactly the threshold is not
    # rejected by binary floating point.
    if overall < threshold - 1e-9:
        sys.stderr.write("FAIL: coverage is below the threshold\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
