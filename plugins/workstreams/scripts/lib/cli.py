"""The parts of a workstreams script's `main` that are the same in every one.

Four scripts print JSON, refuse bad input with their own one-line message and a
status, and may be read by something that stops reading. Written out four times
that is four copies of the same broken-pipe dance to keep in step; here it is
one, and one place for a test to reach.

Nothing here knows what any script does. `run` takes the script's name (for the
messages), a callable returning the exit status, and the exception classes that
callable means to report; it owns only what happens around them: the encoding of
the two output streams, the flush, and the three ways a script can end other
than normally.
"""

from __future__ import annotations

import json
import os
import sys


class Failure(Exception):
    """A failure a script reports as its own: the message and the exit status.

    Not usage alone. Each script's docstring says what its statuses mean. Every
    script passes one explicitly through its own `die`, so the default of 2, a
    usage error, is what a direct `raise Failure(...)` gets and nothing else.
    """

    def __init__(self, message: str, status: int = 2) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def dumps(document) -> str:
    """The pretty JSON `jq .` printed: two-space indent, one trailing newline.

    `ensure_ascii=False` because that is the parity: jq writes raw UTF-8, so an
    issue title with an accent in it stays readable instead of becoming a run of
    \\u escapes. `allow_nan=False` because Python would otherwise emit the
    literals NaN and Infinity, which are not JSON and which no other reader of
    this output would parse.
    """
    return json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def utf8(stream) -> None:
    """Make one text stream write UTF-8 whatever the locale says.

    dumps() writes with ensure_ascii=False and the preflight output carries no
    ASCII promise either, so a non-UTF-8 locale (PYTHONIOENCODING=ascii and the
    like) would otherwise fail the write with a UnicodeEncodeError rather than
    the request just working.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        # A stream that is not a reconfigurable TextIOWrapper -- pytest's
        # capture object, or a caller that put an io.StringIO in its place --
        # already accepts str and has no encoding to change. Leaving it as it is
        # is the right answer, not an error.
        pass


def run(prog: str, body, reported=(Failure,)) -> int:
    """Call `body` and turn every way it can end into an exit status.

    `reported` names the exceptions the script raises deliberately, each
    carrying a `message` and a `status`. It is a parameter rather than one fixed
    class because a `lib/` module raises its own: nothing under `lib/` imports
    another `lib/` module, because the tests load each one by path under a
    plugin-unique name, outside any package, where a sibling import would not
    resolve. Everything else is unanticipated and reported as such.
    """
    utf8(sys.stdout)
    utf8(sys.stderr)
    try:
        try:
            status = body()
        finally:
            # Forces the write now, while BrokenPipeError still lands in the
            # handler below. Left implicit, small output stays buffered until
            # the interpreter's own shutdown flush, which runs after this
            # function returns and prints its own "Exception ignored in" trace
            # instead. In the `finally` rather than after the call because a
            # script may print and then report a failure -- `ws-issues.py`
            # writes `[]` before raising for "nothing matched" -- and that path
            # has output waiting too.
            sys.stdout.flush()
    except reported as error:
        sys.stderr.write(f"{prog}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        # `ws-issues.py 1-99 | head` closes the pipe early. That is the reader's
        # business, not a failure here, and the interpreter must not try to flush
        # the closed stream on the way out and print its own trace. Both
        # descriptors go to devnull -- not just stdout -- so nothing the
        # interpreter still tries to flush during shutdown (stdout again, or a
        # stray write to stderr) can resurface as a broken-pipe trace either.
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, sys.stdout.fileno())
            os.dup2(devnull, sys.stderr.fileno())
        finally:
            os.close(devnull)
        return 0
    except Exception as error:
        # Every script's usage text promises its own message rather than a
        # traceback. Deliberate: an arm nobody anticipated still reports one line
        # and exit 1, the way every anticipated one does. The class name is
        # included so an exception with an empty message (str(error) == "") still
        # names what happened instead of printing a bare colon.
        sys.stderr.write(f"{prog}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status
