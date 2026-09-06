"""What every ft-*.py arranges around its own work: encoding, and a closed reader.

All of it replaces something the shell got for free. A shell script writes bytes:
it has no encoding to get wrong, and a closed pipe kills it with SIGPIPE rather
than printing a trace. A Python script has to arrange each of those, and every
script here has to arrange them the same way, or the same run produces different
output depending on which script in the chain was reached.

The one place they differ is what a closed reader costs. A script that only
prints can stop where it stands, and `silence_broken_pipe` in its `main` is the
whole answer. A script that changes something -- ft-run writing the marker,
ft-issue filing an issue -- must stop printing and keep working, which is what
`write_out` is for.

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


def silence_stdout() -> None:
    """Point stdout at devnull, leaving stderr alone."""
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stdout.fileno())
    finally:
        os.close(devnull)


def silence_broken_pipe() -> None:
    """Point both standard streams at devnull, for a reader that closed early.

    `ft-run.py show | head` is the caller's business, not a failure here. Both
    descriptors, not only stdout: the interpreter flushes on the way out, and a
    stray write to either during shutdown would resurface as the broken-pipe
    trace this exists to prevent.

    For the last flush on the way out, which is where a script with nothing left
    to do can afford to lose stderr too. A script that still has work in front of
    it wants `write_out` instead.
    """
    silence_stdout()
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stderr.fileno())
    finally:
        os.close(devnull)


def write_out(text: str) -> None:
    """Write to stdout, going quiet for good if the reader has gone away.

    A closed reader must stop a script's output, never its work. `ft-run.py start`
    has already created the run directory, truncated events.jsonl and written the
    marker by the time it prints the path to them, and a caller that piped it into
    something which exited early -- `head`, a shell that stopped reading, a killed
    skill -- would otherwise take the rest of the run down with it. A marker that
    exists and a run that was never finished is a worse state to leave behind than
    a path nobody read.

    So the first BrokenPipeError points stdout at devnull and returns. Every later
    write lands there and succeeds, including the interpreter's own flush on the
    way out, and the work carries on to its own end and its own exit status.

    stderr is deliberately left alone: the script may still have a refusal to
    report, and the reader that went away was reading stdout.
    """
    try:
        sys.stdout.write(text)
        # Flushed here rather than left to `main`, so the pipe is discovered at
        # the write that filled it rather than after the work that followed it.
        sys.stdout.flush()
    except BrokenPipeError:
        silence_stdout()
