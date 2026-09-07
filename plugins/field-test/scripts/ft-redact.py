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

from lib import cli, redact  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-redact.py"


def run(argv):
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

    redact.check_present(names)
    # Bytes in and bytes out, on both paths. The shell was `cat` inside the
    # enterprise and `jq -Rrs` outside, and neither has an encoding to get wrong:
    # what arrives here is an issue body built from a commit subject and a
    # command the target ran, which can hold any byte at all. Decoding it
    # strictly would fail the run over one; decoding it with "replace" would
    # quietly rewrite the evidence the issue exists to carry.
    raw = sys.stdin.buffer.read()
    if mode == "--inside":
        # Documented as the identity function, byte for byte, so it is exactly
        # that: nothing is decoded and nothing is re-encoded.
        sys.stdout.buffer.write(raw)
        return 0
    # surrogateescape both ways, so a byte that is not valid UTF-8 survives the
    # round trip unchanged while the replacement itself still works on text.
    text = raw.decode("utf-8", "surrogateescape")
    sys.stdout.buffer.write(redact.redact(text, names, False).encode("utf-8", "surrogateescape"))
    return 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Both layers: run() writes through sys.stdout.buffer, and the help text
        # above it goes through the text wrapper on top of the same descriptor.
        sys.stdout.buffer.flush()
        sys.stdout.flush()
    except redact.RedactError as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The docstring promises this script's own message, not a traceback. An
        # arm nobody anticipated still reports one line and exit 1, the way every
        # anticipated one does. The class name is there so an exception with an
        # empty message still names what happened instead of printing a bare colon.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
