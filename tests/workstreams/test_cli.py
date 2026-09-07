"""Unit tests for `plugins/workstreams/scripts/lib/cli.py`.

The wrapper every workstreams script's `main` ends in. Each script's own tests
prove the arms end to end -- a refused argument, a reader that stops reading, a
non-UTF-8 locale -- and these name them once, including the two that no script
can be made to take from the outside.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import textwrap

import pytest
from conftest import WS_LIB, load_lib_module

cli = load_lib_module("ws_lib_cli", WS_LIB / "cli.py")


def write_tiny(tmp_path, source: str):
    """A one-off script that calls `cli.run`, for the arms that need a real process.

    `sys.stdout` in this process is pytest's capture object, which reconfigures
    nothing and never breaks a pipe. Only a child has the TextIOWrapper on a
    real descriptor that these two arms are about.
    """
    script = tmp_path / "tiny.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys

            sys.path.insert(0, {lib!r})
            import cli
            """
        ).format(lib=str(WS_LIB))
        + textwrap.dedent(source),
        encoding="utf-8",
    )
    return script


class OtherFailure(Exception):
    """A second reported class, the way a `lib/` module raises its own."""

    def __init__(self, message, status):
        super().__init__(message)
        self.message = message
        self.status = status


def test_dumps_is_two_space_indented_json_with_one_trailing_newline():
    assert cli.dumps({"ok": True, "missing": []}) == '{\n  "ok": true,\n  "missing": []\n}\n'


def test_dumps_writes_non_ascii_raw_rather_than_escaped():
    assert cli.dumps({"reason": "café"}) == '{\n  "reason": "café"\n}\n'


def test_dumps_refuses_a_nan_rather_than_writing_a_literal_no_parser_accepts():
    with pytest.raises(ValueError):
        cli.dumps({"n": float("nan")})


def test_utf8_leaves_a_stream_with_nothing_to_reconfigure_alone():
    """The arm no script can reach from the outside: sys.stdout is always a
    TextIOWrapper in a child process, so only a caller that replaced it -- a
    test, or pytest's own capture -- takes this branch."""
    stream = io.StringIO()
    cli.utf8(stream)
    stream.write("café")
    assert stream.getvalue() == "café"


def test_run_returns_the_status_the_body_returned(capsys):
    assert cli.run("prog.py", lambda: 0) == 0
    assert cli.run("prog.py", lambda: 2) == 2
    assert capsys.readouterr().err == ""


def test_run_reports_a_failure_as_one_line_with_its_status(capsys):
    def body():
        raise cli.Failure("nothing matched", 3)

    assert cli.run("prog.py", body) == 3
    assert capsys.readouterr().err == "prog.py: nothing matched\n"


def test_a_failure_defaults_to_the_usage_status():
    assert cli.Failure("bad flag").status == 2


def test_run_reports_every_class_the_script_names(capsys):
    def body():
        raise OtherFailure("bad selector", 2)

    assert cli.run("prog.py", body, (cli.Failure, OtherFailure)) == 2
    assert capsys.readouterr().err == "prog.py: bad selector\n"


def test_run_does_not_report_a_class_the_script_did_not_name(capsys):
    """An exception outside `reported` is unanticipated, however it is shaped."""

    def body():
        raise OtherFailure("bad selector", 2)

    assert cli.run("prog.py", body) == 1
    assert "internal error: OtherFailure: bad selector" in capsys.readouterr().err


def test_run_exits_with_the_status_the_script_gave_unanticipated_failures(capsys):
    """A script that gave 1 a narrower meaning says so once, here, rather than
    catching everything itself: `ws-pr-status.py` keeps exit 1 for "the pull
    request does not exist", which the run loop fails a stream permanently on."""

    def body():
        raise RuntimeError("nobody saw this coming")

    assert cli.run("prog.py", body, internal_status=4) == 4
    assert "internal error: RuntimeError" in capsys.readouterr().err


def test_run_reports_an_unanticipated_failure_naming_its_class(capsys):
    def body():
        raise RuntimeError()

    assert cli.run("prog.py", body) == 1
    captured = capsys.readouterr()
    assert captured.err == "prog.py: internal error: RuntimeError: \n"
    assert "Traceback" not in captured.err


def test_run_exits_quietly_when_the_reader_closes_the_pipe_on_a_reported_failure(tmp_path):
    """The arm the flush guards: a script that prints its JSON and then reports
    a failure has output still buffered when the reporting begins. Without the
    flush in the `finally`, the interpreter's own shutdown flush hits the closed
    pipe after run() has returned and prints "Exception ignored in" on stderr."""
    script = write_tiny(
        tmp_path,
        # Raw, so the escapes below reach the child as escapes rather than
        # ending the line here and flattening the indentation dedent needs.
        r"""

        def body():
            sys.stdout.write("[]\n")
            raise cli.Failure("nothing matched", 3)


        sys.exit(cli.run("tiny.py", body))
        """,
    )
    process = subprocess.Popen(
        [sys.executable, str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


def test_utf8_makes_a_real_stdout_write_utf8_under_an_ascii_locale(tmp_path):
    """The arm the StringIO test above cannot reach: a genuine TextIOWrapper
    whose encoding is ascii, where the write fails with UnicodeEncodeError
    unless utf8() reconfigured it first."""
    script = write_tiny(
        tmp_path,
        r"""

        assert sys.stdout.encoding.lower() in ("ascii", "us-ascii"), sys.stdout.encoding
        cli.utf8(sys.stdout)
        sys.stdout.write("caf\u00e9\n")
        """,
    )
    environment = dict(os.environ, PYTHONIOENCODING="ascii", PYTHONUTF8="0", LC_ALL="C")
    finished = subprocess.run(
        [sys.executable, str(script)], capture_output=True, env=environment, check=False
    )
    assert finished.returncode == 0, finished.stderr.decode("utf-8", "replace")
    assert finished.stdout.decode("utf-8") == "café\n"
