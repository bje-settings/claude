#!/usr/bin/env python3
"""ft-redact.py: strip a repository's identity out of text bound for a public issue.

  ft-redact.py <names.json> [--inside] < text > text

names.json is what `ft-issue.py names` produced: a table of literal strings and
the placeholder each becomes, longest first.

With --inside this is the identity function, byte for byte: the repository under
test belongs to the same enterprise as the plugin, so the specifics are exactly
what makes the issue reproducible and they stay.

Without it, every name in the table is replaced and a line is appended saying the
run was on a repository outside the enterprise, so a reader knows the shape is
real and the names are not. Matching is literal, not regular expression: a branch
or commit subject can contain anything, and a pattern built from one would be a
way to leak the very name this exists to remove.

Exit 0, 1 on a broken names file (not JSON, or JSON that is not a names table),
2 on usage.

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import redact  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-redact.py"


def main(argv):
    names = argv[1] if len(argv) > 1 else ""
    if names in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if names == "":
        sys.stderr.write(__doc__)
        return 2
    mode = argv[2] if len(argv) > 2 else ""
    if mode not in ("", "--inside"):
        sys.stderr.write(f"{PROG}: unknown argument: {mode}\n")
        return 2

    try:
        redact.check_present(names)
        text = sys.stdin.read()
        sys.stdout.write(redact.redact(text, names, mode == "--inside"))
    except redact.RedactError as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
