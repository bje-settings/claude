#!/usr/bin/env python3
"""lib/discover.py — repository discovery shared by the gh plugin scripts.

Import it, then call:

    from lib import discover
    discover.discover_repos(target)

or run it as a script, which prints the same list one path per line:

    python3 lib/discover.py [target]

`toplevel(path)` answers the narrower question on its own: the checkout root
containing `path`, or None. `gh-sync.py` asks it to tell a target that is itself
inside a repository from a directory that merely holds one.

Paths are symlink-resolved, because git reports resolved paths and callers
compare against them. On macOS /tmp and /var are symlinks, so a logical path
would never match.

Scope comes from the target, so no caller has to classify it:
  - the target is inside a git repo  -> that repo's checkout root
  - the target is not a git repo     -> every immediate subdirectory that is
                                        the root of a checkout, non-recursively

Subdirectories that are not git repos, and subdirectories that are merely
inside a repo rather than its root, are skipped without comment. Nothing is
ever cloned. Raises NotADirectoryError when the target is not a directory, and
the script form reports it on stderr and exits 1; a target with no repositories
yields an empty list and exits 0.
"""

from __future__ import annotations

import os
import subprocess
import sys


def toplevel(path):
    """The checkout root containing `path`, or None when there is none.

    A missing git is the same answer as a directory outside any checkout: no
    root. The callers have nothing to do with that distinction, and raising
    here would turn a degraded environment into a crash.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    top = completed.stdout.decode("utf-8", "replace").strip()
    return top or None


def discover_repos(target=None):
    """Checkout roots in scope for `target`, symlink-resolved."""
    if target is None or target == "":
        target = os.getcwd()
    target = str(target)
    if not os.path.isdir(target):
        raise NotADirectoryError(target)
    real_target = os.path.realpath(target)

    top = toplevel(real_target)
    if top:
        return [top]

    roots = []
    try:
        entries = sorted(os.listdir(real_target))
    except OSError:
        return roots
    for name in entries:
        # The shell glob this replaces was "$target"/*/, which never matches a
        # dotfile: the fan-out fixtures park their bare origins in a hidden
        # directory precisely because of that.
        if name.startswith("."):
            continue
        entry = os.path.join(real_target, name)
        if not os.path.isdir(entry):
            continue
        real = os.path.realpath(entry)
        top = toplevel(entry)
        # Only the checkout root counts, never a subdirectory of one.
        if top and top == real:
            roots.append(real)
    return roots


def use_utf8(stream):
    """Make `stream` write UTF-8, replacing anything it cannot encode.

    A repository path may hold any byte, so under a single-byte locale
    (LC_ALL=en_US.ISO8859-1, PYTHONIOENCODING=ascii) printing one can raise
    UnicodeEncodeError. A stream that has been replaced with something without
    reconfigure, or that is already detached, is left alone rather than turned
    into a different crash.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        # A stream with no reconfigure (a replaced sys.stdout, or one closed
        # outright) is left as it is: the fallback is the original, loud
        # UnicodeEncodeError rather than a silent one, and this must not raise.
        pass


def main(argv):
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)
    target = argv[0] if argv else None
    try:
        roots = discover_repos(target)
    except NotADirectoryError:
        # The exit status alone leaves the caller guessing which of its arguments
        # was wrong; a skill running this over several targets has nothing else to
        # go on.
        print(f"not a directory: {target if target else os.getcwd()}", file=sys.stderr)
        return 1
    try:
        for root in roots:
            print(root)
        # Forces the write now, while BrokenPipeError still lands in the handler
        # below. Left implicit, buffered output is flushed during interpreter
        # shutdown instead, which prints its own "Exception ignored in" trace.
        sys.stdout.flush()
    except BrokenPipeError:
        # `discover.py | head` closes the pipe early. That is the reader's
        # business, not a failure here. Both descriptors go to devnull, not just
        # stdout, so nothing the interpreter still tries to flush on the way out
        # can resurface as a broken-pipe trace either.
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, sys.stdout.fileno())
            os.dup2(devnull, sys.stderr.fileno())
        finally:
            os.close(devnull)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
