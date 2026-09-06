#!/usr/bin/env python3
"""lib/discover.py — repository discovery shared by the gh plugin scripts.

Import it, then call:

    from lib import discover
    discover.discover_repos(target)

or run it as a script, which prints the same list one path per line:

    python3 lib/discover.py [target]

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
the script form exits 1 for it; a target with no repositories yields an empty
list and exits 0.
"""

from __future__ import annotations

import os
import subprocess
import sys


def _toplevel(path):
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

    top = _toplevel(real_target)
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
        top = _toplevel(entry)
        # Only the checkout root counts, never a subdirectory of one.
        if top and top == real:
            roots.append(real)
    return roots


def main(argv):
    try:
        roots = discover_repos(argv[0] if argv else None)
    except NotADirectoryError:
        return 1
    for root in roots:
        print(root)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
