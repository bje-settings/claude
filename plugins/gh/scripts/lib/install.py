"""lib/install.py — which package manager a checkout uses, and running it.

pnpm, Yarn Berry, and npm. Yarn 1 and bun are deliberately out of scope: a repo
on either gets the lock-file notice and installs by hand.

The order is the detection: pnpm first because it is the house package manager,
then Yarn, then npm. A repo carrying two lock files installs with the first one
found, which is what the shell version did and what a human would do.
"""

from __future__ import annotations

import os
import subprocess

# The lock files a pull is diffed against to decide whether to install at all.
LOCKFILES = ("pnpm-lock.yaml", "yarn.lock", "package-lock.json")

# lock file -> the install that respects it. Frozen/immutable/ci in every case:
# a sync installs what the lock file says and never rewrites it.
INSTALL_COMMANDS = (
    ("pnpm-lock.yaml", ("pnpm", "install", "--frozen-lockfile")),
    ("yarn.lock", ("yarn", "install", "--immutable")),
    ("package-lock.json", ("npm", "ci")),
)

# Not an errno: the one value install_deps returns that is not a package
# manager's own exit status. It says "there was nothing to install", which the
# caller reports differently from a failure.
NO_LOCKFILE = 3


def install_command(root="."):
    """The install command for the lock file in `root`, or None if there is none."""
    for lockfile, command in INSTALL_COMMANDS:
        if os.path.isfile(os.path.join(root, lockfile)):
            return list(command)
    return None


def install_deps(root="."):
    """Run the install for `root`. Returns (status, combined output).

    NO_LOCKFILE means no recognised lock file remains, which is not a failure.
    A package manager that is not installed is reported the way the shell
    reported it, as output the caller can put in its one-line reason.
    """
    command = install_command(root)
    if command is None:
        return NO_LOCKFILE, ""
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except FileNotFoundError:
        # 127 and this wording are what a shell prints for a missing command, and
        # what the shell version reported, so the caller's one-line reason reads
        # the same as it always did.
        return 127, f"{command[0]}: command not found"
    except OSError as exc:
        # A lock file whose manager is present but unrunnable -- not executable,
        # a bad interpreter line, a too-long argument list -- is a different
        # failure, and saying "command not found" for it sends the reader looking
        # for the wrong thing.
        return 127, f"{command[0]}: {exc.strerror or exc}"
    return completed.returncode, completed.stdout.decode("utf-8", "replace")
