"""The two things every ft-*.py `main` does before and after its own work.

Both replace something the shell got for free. A shell script writes bytes: it
has no encoding to get wrong, and a closed pipe kills it with SIGPIPE rather
than printing a trace. A Python script has to arrange each of those, and every
script here has to arrange them the same way, or the same run produces different
output depending on which script in the chain was reached.

Not used by `hooks/hook-io.py`, which keeps its own copy: a hook runs on every
tool call in every session, and must not need an import to succeed before it can
speak.
"""

from __future__ import annotations

import os
import sys


def reconfigure_streams() -> None:
    """UTF-8 out, replacing what will not encode.

    Every one of these scripts prints text it did not write: a commit subject, a
    branch name, a command the target ran, gh's own words. Under a non-UTF-8
    locale (`PYTHONIOENCODING=ascii`, `LC_ALL=C`, a cron job with no locale at
    all) writing one raises UnicodeEncodeError, and a script that failed for that
    reason reports an internal error for a request that was fine. The shell
    equivalent passed the bytes through and is what the callers expect.

    Guarded because `reconfigure` needs a text stream that is still open: a
    caller that replaced sys.stdout with something of its own has neither the
    method nor the problem.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            continue


def silence_broken_pipe() -> None:
    """Point both standard streams at devnull, for a reader that closed early.

    `ft-run.py show | head` is the caller's business, not a failure here. Both
    descriptors, not only stdout: the interpreter flushes on the way out, and a
    stray write to either during shutdown would resurface as the broken-pipe
    trace this exists to prevent.
    """
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stdout.fileno())
        os.dup2(devnull, sys.stderr.fileno())
    finally:
        os.close(devnull)
