"""Tests for what every ft-*.py `main` does around its own work.

The pieces live in `scripts/lib/cli.py` and are exercised there once, plus one
black-box run per behaviour through a real script, because the point of each is
what the process does rather than what the function returns. All three replace
something the shell had for free: bytes out with no encoding to get wrong, death
by SIGPIPE on a closed reader, and one message instead of a traceback.
"""

from __future__ import annotations

import io
import sys

import pytest
from conftest import FT_ENTERPRISE, FT_RUN, SCRIPTS, ft_fixture_run, load_lib_module

cli = load_lib_module("field_test_lib_cli", SCRIPTS / "lib" / "cli.py")

pytestmark = pytest.mark.usefixtures("ft_sandbox")

# One per script, so a script that never grew the wrapper is caught by name.
SCRIPT_NAMES = (
    "ft-run.py",
    "ft-collect.py",
    "ft-redact.py",
    "ft-issue.py",
    "ft-resolve.py",
    "ft-enterprise.py",
)


# --- every script has the wrapper --------------------------------------------


@pytest.mark.parametrize("name", SCRIPT_NAMES)
def test_every_script_reconfigures_its_streams(name):
    """every script sets its output encoding before it writes anything

    Named per script rather than asserted once: the wrapper is copied into each
    `main`, and a script that never grew it fails the run under a non-UTF-8
    locale in a way no other test would reach.
    """
    assert "cli.reconfigure_streams()" in (SCRIPTS / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", SCRIPT_NAMES)
def test_every_script_handles_a_reader_that_closed_early(name):
    assert "cli.silence_broken_pipe()" in (SCRIPTS / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", SCRIPT_NAMES)
def test_every_script_reports_an_unanticipated_failure_as_one_line(name):
    assert "internal error: " in (SCRIPTS / name).read_text(encoding="utf-8")


# --- reconfigure_streams -----------------------------------------------------


def test_reconfigure_streams_sets_utf8_with_replacement():
    stream = io.TextIOWrapper(io.BytesIO(), encoding="ascii")
    original = sys.stdout
    sys.stdout = stream
    try:
        cli.reconfigure_streams()
        assert stream.encoding == "utf-8"
        assert stream.errors == "replace"
    finally:
        sys.stdout = original


def test_reconfigure_streams_leaves_a_stream_that_cannot_be_reconfigured():
    """A caller that replaced sys.stdout has neither the method nor the problem."""
    original = sys.stdout
    sys.stdout = io.StringIO()
    try:
        assert cli.reconfigure_streams() is None
    finally:
        sys.stdout = original


# --- the arms, through a real process ----------------------------------------


def test_a_script_answers_under_a_locale_that_cannot_encode_its_answer(ft_sandbox, run_script):
    """prints a non-ASCII answer under PYTHONIOENCODING=ascii instead of failing

    Without the reconfigure this raises UnicodeEncodeError on the way out and the
    internal-error arm reports it, so a request that was fine reads as a bug.
    """
    ft_fixture_run(ft_sandbox.marker)
    marker = ft_sandbox.read_marker()
    marker["cwd"] = "/checkout/café"
    ft_sandbox.marker.write_text(__import__("json").dumps(marker), encoding="utf-8")
    result = run_script(FT_RUN, "show", env={"PYTHONIOENCODING": "ascii"})
    assert result.status == 0, result.stderr
    assert "café" in result.stdout


def test_a_reader_that_closed_early_is_not_a_failure(ft_sandbox, run_with_no_reader):
    """exits 0, with no traceback, when the reader closed the pipe first

    `ft-run.py show | head` is the caller's business. The shell died on SIGPIPE
    and said nothing; Python would print "Exception ignored in" from its own
    shutdown flush unless both descriptors are taken out of the way.
    """
    ft_fixture_run(ft_sandbox.marker)
    completed = run_with_no_reader(FT_RUN, "show")
    assert completed.returncode == 0
    assert completed.stderr == b""


def test_a_reader_that_closed_early_is_not_a_failure_for_a_json_answer(
    ft_sandbox, run_with_no_reader
):
    """holds for a script whose whole output is one JSON line, too"""
    completed = run_with_no_reader(FT_ENTERPRISE, "/no/such/plugin", "/no/such/target")
    assert completed.returncode == 0
    assert completed.stderr == b""


def load_script(name):
    """One ft-*.py as a module, for the arms no argument can reach.

    A script inserts its own directory on `sys.path` and imports `lib`, so the
    entries it leaves in `sys.modules` are restored afterwards: pytest runs every
    plugin's tests in one process, and a stale `lib` there would be handed to the
    next plugin that asks for one.
    """
    before = {key: value for key, value in sys.modules.items() if key == "lib" or key[:4] == "lib."}
    try:
        return load_lib_module("field_test_script_" + name.replace("-", "_"), SCRIPTS / name)
    finally:
        for key in [key for key in sys.modules if key == "lib" or key[:4] == "lib."]:
            del sys.modules[key]
        sys.modules.update(before)


@pytest.mark.parametrize("name", SCRIPT_NAMES)
def test_an_unanticipated_failure_is_one_line_and_status_1(name, capsys, monkeypatch):
    """reports an arm nobody anticipated as one line and exit 1, not as a traceback

    In process, because every failure an argument can provoke is one the script
    already answers for by name; the arm under test is the one for the failure
    nobody wrote a message for. The class name is asserted because an exception
    with an empty message would otherwise print a bare colon.
    """
    module = load_script(name)

    def explode(_argv):
        raise RuntimeError("nobody wrote a message for this")

    monkeypatch.setattr(module, "run", explode)
    assert module.main([name]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        f"{module.PROG}: internal error: RuntimeError: nobody wrote a message for this\n"
    )


@pytest.mark.parametrize("name", SCRIPT_NAMES)
def test_an_exception_with_no_message_still_names_itself(name, capsys, monkeypatch):
    """names the class of an exception carrying no message, rather than printing a bare colon"""
    module = load_script(name)

    def explode(_argv):
        raise RuntimeError()

    monkeypatch.setattr(module, "run", explode)
    assert module.main([name]) == 1
    assert capsys.readouterr().err == f"{module.PROG}: internal error: RuntimeError: \n"
