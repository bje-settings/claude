"""Direct tests for `lib/streams.py`, the stream handling the gh scripts share.

It used to be three copies, one per script, each with its own test. The copies
are gone; these are the tests that came with them, plus the two behaviours the
copies did not have: a descriptor closed outright, and silencing stdout without
taking stderr with it.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys

from lib import streams


def test_use_utf8_leaves_a_stream_it_cannot_reconfigure_alone():
    """A replaced or detached stdout must not turn one crash into another.

    The two shapes the guard names: an object with no `reconfigure` at all, and a
    real wrapper whose buffer has been taken away, which raises ValueError.
    """
    streams.use_utf8(io.StringIO())
    detached = io.TextIOWrapper(io.BytesIO())
    detached.detach()
    streams.use_utf8(detached)


def test_use_utf8_makes_a_stream_write_utf8():
    """The other half: a stream that can be reconfigured is."""
    stream = io.TextIOWrapper(io.BytesIO(), encoding="ascii")
    streams.use_utf8(stream)
    stream.write("✓")
    stream.flush()
    assert stream.buffer.getvalue() == "✓".encode()


def test_bind_closed_streams_gives_a_closed_descriptor_something_to_write_to():
    """Started with fd 1 closed, Python leaves sys.stdout as None.

    A child, not this process: binding devnull over the test runner's own stdout
    would follow the example out. The script under test is a two-line stand-in for
    the same reason, so the assertion is about `streams` and nothing else.
    """
    script = (
        "import sys;"
        f"sys.path.insert(0, {os.path.dirname(os.path.dirname(streams.__file__))!r});"
        "from lib import streams;"
        "assert sys.stdout is None;"
        "streams.bind_closed_streams();"
        "sys.stdout.write('swallowed');"
        "sys.stdout.flush()"
    )
    completed = subprocess.run(
        ["sh", "-c", 'exec 1>&-; exec "$@"', "sh", sys.executable, "-c", script],
        stderr=subprocess.PIPE,
        check=False,
    )
    assert completed.returncode == 0
    assert completed.stderr == b""


def test_silence_output_can_leave_stderr_alone(tmp_path):
    """The report goes quiet mid-run; a real failure afterwards still has to land.

    Both descriptors are redirected to files the parent can read, so what each
    call silenced is a fact rather than an absence.
    """
    out = tmp_path / "out"
    err = tmp_path / "err"
    script = (
        "import sys;"
        f"sys.path.insert(0, {os.path.dirname(os.path.dirname(streams.__file__))!r});"
        "from lib import streams;"
        "streams.silence_output(include_stderr=False);"
        "sys.stdout.write('gone');sys.stdout.flush();"
        "sys.stderr.write('kept');sys.stderr.flush();"
        "streams.silence_output();"
        "sys.stderr.write('gone too');sys.stderr.flush()"
    )
    with open(out, "w") as stdout, open(err, "w") as stderr:
        completed = subprocess.run(
            [sys.executable, "-c", script], stdout=stdout, stderr=stderr, check=False
        )
    assert completed.returncode == 0
    assert out.read_text() == ""
    assert err.read_text() == "kept"
