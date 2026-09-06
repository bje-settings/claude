"""Shared setup for the Python side of the suite.

The pieces here are the pytest counterparts of `setup_sandbox`, `ws_path_without`
and shellspec's `When run script` in `spec/spec_helper.sh`, minus anything
plugin-specific: each port brings its own stub `gh` and its own canned data, and
builds it on top of these. Every example gets its own temp directory, so the
whole suite can run under `pytest -n auto` without examples sharing state.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# The tools a plugin script may reach for. `path_without` links all of these into
# a fresh bin directory except the ones it is asked to leave out, which is how the
# "tool is not installed" branches get provoked without touching the real PATH.
COMMON_TOOLS = (
    "bash",
    "sh",
    "jq",
    "git",
    "gh",
    "grep",
    "sed",
    "awk",
    "tr",
    "cat",
    "cut",
    "head",
    "mkdir",
    "mv",
    "rm",
    "date",
    "find",
    "dirname",
    "basename",
    "env",
    "id",
    "chmod",
    "python3",
)


class Sandbox:
    """One example's private world: a temp directory and a PATH it can rewrite."""

    def __init__(self, path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.path = path
        self._monkeypatch = monkeypatch

    def __truediv__(self, other: str) -> Path:
        return self.path / other

    def stub_path(self, directory) -> str:
        """Put `directory` ahead of everything already on PATH.

        The shell helpers do this with the fixture `bin/` holding a stub `gh`; the
        point is the same here, and the monkeypatch is undone when the example ends.
        """
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        new_path = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
        self._monkeypatch.setenv("PATH", new_path)
        return str(directory)

    def path_without(self, *tools: str) -> str:
        """A bin directory of symlinks to the real tools, minus the named ones.

        Returns the directory rather than exporting it: a test usually wants to
        hand it to `run_script` as the child's whole PATH, not to lose the tools
        pytest itself needs.
        """
        directory = self.path / "bin-without"
        directory.mkdir(parents=True, exist_ok=True)
        for tool in COMMON_TOOLS:
            if tool in tools:
                continue
            real = shutil.which(tool)
            if not real:
                continue
            link = directory / tool
            if not link.exists():
                link.symlink_to(real)
        return str(directory)


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Sandbox:
    """A private temp dir, HOME pointed inside it, and no plugin data dir set."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CLAUDE_PLUGIN_DATA", raising=False)
    return Sandbox(tmp_path, monkeypatch)


class Result:
    """status, stdout and stderr of one script run, as shellspec reports them."""

    def __init__(self, completed: subprocess.CompletedProcess) -> None:
        self.status = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr

    @property
    def output(self) -> str:
        return self.stdout


@pytest.fixture
def run_script():
    """Run a Python script as its own process, the way Claude Code runs it.

    `sys.executable`, not `python3`: it keeps a `pytest-floor` run genuinely on
    3.9, and it is the interpreter coverage.py's subprocess patch knows to
    measure, so a script exercised black-box still counts towards the threshold.
    """

    def run(path, *args, stdin=None, env=None) -> Result:
        child_env = dict(os.environ)
        if env:
            child_env.update({key: str(value) for key, value in env.items()})
        completed = subprocess.run(
            [sys.executable, str(path), *[str(arg) for arg in args]],
            input=stdin if stdin is not None else "",
            capture_output=True,
            text=True,
            env=child_env,
            check=False,
        )
        return Result(completed)

    return run
