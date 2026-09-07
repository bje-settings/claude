#!/usr/bin/env python3
"""lib/streams.py — the stdout and stderr handling every gh script repeats.

Three things, all of which have to happen before a script writes its first line:

    from lib import streams
    streams.bind_closed_streams()
    streams.use_utf8(sys.stdout)
    streams.use_utf8(sys.stderr)

and one that happens once a reader has gone away:

    streams.silence_output()

They lived in three copies (`gh-sync.py`, `gh-sync-repo.py`, `lib/discover.py`)
and drifted the moment one of them learned something the others had not, which is
what this module exists to stop.
"""

from __future__ import annotations

import os
import sys


def bind_closed_streams():
    """Give the script something to write to when a descriptor is gone outright.

    Started with fd 1 closed (`sh -c 'exec 1>&- ; gh-sync.py ...'`), Python sets
    `sys.stdout` to None rather than to a stream that discards. Every later write
    is then an AttributeError, raised after the jobs have already run: the work is
    done, the account of it is lost, and the caller sees a traceback instead of an
    exit status. Binding devnull here makes the report a no-op instead, which is
    what a caller who closed the descriptor asked for.
    """
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            setattr(sys, name, open(os.devnull, "w"))


def use_utf8(stream):
    """Make `stream` write UTF-8, replacing anything it cannot encode.

    The reports carry ✓, ✗ and · and a repository path may hold any byte, so under
    a single-byte locale (LC_ALL=en_US.ISO8859-1, PYTHONIOENCODING=ascii) writing
    one raises UnicodeEncodeError and the run dies on its first line.

    A stream that has been replaced with something without `reconfigure`, or that
    is already detached, is left as it is: the fallback is the original, loud
    UnicodeEncodeError rather than a silent one, and this must not raise.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def silence_output(include_stderr=True):
    """Send stdout, and by default stderr too, to devnull for a reader that left.

    `include_stderr=False` is for a report that goes quiet mid-run: the pipe is
    the reader's business, but the script is still running and a real failure
    afterwards has to be able to reach the terminal. The final flush uses the
    default, because by then nothing is left to say and anything the interpreter
    still tries to write on the way out would resurface as its own broken-pipe
    trace.
    """
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stdout.fileno())
        if include_stderr:
            os.dup2(devnull, sys.stderr.fileno())
    finally:
        os.close(devnull)
