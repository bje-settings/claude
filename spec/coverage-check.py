#!/usr/bin/env python3
"""Fail if line coverage is below a threshold.

Used by CI in place of shellspec's --fail-low-coverage, which reports a failure
at any coverage level once enabled, and by spec/run.sh when kcov is available.
Prints the per-file numbers and the uncovered lines either way, so a drop says
which file moved rather than only that the total fell.

  coverage-check.py <cobertura.xml> [threshold]
"""

import sys
import xml.etree.ElementTree as ET

DEFAULT_THRESHOLD = 95.0


def report(path, threshold):
    root = ET.parse(path).getroot()
    classes = sorted(root.iter("class"), key=lambda c: c.get("filename") or "")
    for cls in classes:
        rate = float(cls.get("line-rate", 0)) * 100
        uncovered = [
            line.get("number") for line in cls.iter("line") if line.get("hits") == "0"
        ]
        suffix = "  uncovered: " + ",".join(uncovered) if uncovered else ""
        print("  {:6.2f}%  {}{}".format(rate, cls.get("filename"), suffix))

    overall = float(root.get("line-rate", 0)) * 100
    print("\noverall: {:.2f}%   threshold: {:.2f}%".format(overall, threshold))
    return overall


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: coverage-check.py <cobertura.xml> [threshold]\n")
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
