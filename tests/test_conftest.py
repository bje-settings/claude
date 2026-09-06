"""The shared sandbox is test infrastructure, so it gets its own tests.

Everything else in the suite trusts these helpers to isolate an example and to
take a tool away when asked. A helper that quietly did neither would make ports
pass for the wrong reason, which is the one failure mode this suite exists to
rule out.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


def test_sandbox_puts_home_inside_its_own_tmp_dir(sandbox, tmp_path):
    home = Path(os.environ["HOME"])
    assert home == tmp_path / "home"
    assert home.is_dir()


def test_sandbox_unsets_the_plugin_data_dir(monkeypatch, request):
    # Set it first, then pull the fixture in by hand, so the assertion is about
    # the fixture clearing a value that was there. Taking `sandbox` as an argument
    # would run it before this line and the test would pass on a machine where the
    # variable was simply never set.
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", "leaked-from-the-session")
    request.getfixturevalue("sandbox")
    assert "CLAUDE_PLUGIN_DATA" not in os.environ


def test_stub_path_goes_ahead_of_everything(sandbox):
    stubs = sandbox / "stubs"
    returned = sandbox.stub_path(stubs)
    assert returned == str(stubs)
    assert os.environ["PATH"].split(os.pathsep)[0] == str(stubs)


def test_stub_path_creates_the_directory(sandbox):
    stubs = sandbox / "not-yet-there" / "bin"
    sandbox.stub_path(stubs)
    assert stubs.is_dir()


def test_path_without_drops_the_named_tools_and_keeps_the_rest(sandbox):
    directory = Path(sandbox.path_without("git", "jq"))
    names = {entry.name for entry in directory.iterdir()}
    assert "git" not in names
    assert "jq" not in names
    # A PATH that cannot run a shell script is not a PATH any example wants.
    assert {"bash", "sh"} <= names


def test_two_path_without_calls_do_not_share_a_directory(sandbox):
    with_git = Path(sandbox.path_without("jq"))
    without_git = Path(sandbox.path_without("git"))
    assert with_git != without_git
    # The second call must not inherit the first call's git link.
    assert (with_git / "git").exists()
    assert not (without_git / "git").exists()


def test_path_without_rejects_a_name_it_does_not_know(sandbox):
    with pytest.raises(ValueError) as raised:
        sandbox.path_without("gti")
    assert "gti" in str(raised.value)


def test_run_script_survives_output_that_is_not_utf8(run_script, tmp_path):
    script = tmp_path / "noisy.py"
    script.write_text(
        "import sys\n"
        "sys.stdout.buffer.write(b'ok \\xff\\n')\n"
        "sys.stderr.buffer.write(b'bad \\xfe\\n')\n"
        "sys.exit(3)\n",
        encoding="utf-8",
    )
    result = run_script(script)
    assert result.status == 3
    assert "ok " in result.stdout
    assert "bad " in result.stderr


def test_run_script_passes_stdin_and_extra_env(run_script, tmp_path):
    script = tmp_path / "echo.py"
    script.write_text(
        "import os, sys\nsys.stdout.write(sys.stdin.read() + os.environ['EXTRA'])\n",
        encoding="utf-8",
    )
    result = run_script(script, stdin="in:", env={"EXTRA": "env"})
    assert result.status == 0
    assert result.stdout == "in:env"
