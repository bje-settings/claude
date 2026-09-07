"""Shared setup for the Python side of the suite.

The pieces here are the pytest counterparts of `setup_sandbox`, the per-plugin
`*_path_without`, and shellspec's `When run script`, minus anything
plugin-specific: each port brings its own stub `gh` and its own canned data, and
builds it on top of these. Every example gets its own temp directory, so the
whole suite can run under `pytest -n auto` without examples sharing state.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# sys.path as it was before any test ran. A script loaded in-process pushes its
# own directory onto sys.path and never takes it off; anything not in here that
# looks like a plugin's scripts/ or hooks/ directory is one of those leftovers.
SYS_PATH_AT_START = tuple(sys.path)


def _is_leftover_plugin_entry(entry: str) -> bool:
    """True for a `plugins/<plugin>/scripts` or `.../hooks` entry a load left behind."""
    path = Path(entry)
    return path.name in {"scripts", "hooks"} and "plugins" in path.parent.parts


def reset_plugin_lib_namespace() -> None:
    """Forget every `lib` a previous in-process script load resolved.

    Each plugin's scripts share code through `plugins/<plugin>/scripts/lib/`,
    reached by `sys.path.insert(0, HERE)` and `from lib import cli`. That is right
    for a process running one plugin and wrong for pytest, which runs every
    plugin's tests in one process: the first plugin whose script is loaded
    in-process owns `sys.modules["lib"]`, and the next plugin's script imports
    that one instead of its own -- `module 'lib.cli' has no attribute 'Failure'`,
    on whichever plugin happened to load second.

    Dropping the `lib` modules alone is not enough: the losing plugin's `scripts`
    directory is still on `sys.path` from its own load, so the re-import could
    resolve to it rather than to the script's own. Both go, and each in-process
    load starts from nothing again.
    """
    for name in [n for n in sys.modules if n == "lib" or n.startswith("lib.")]:
        del sys.modules[name]
    sys.path[:] = [
        entry
        for entry in sys.path
        if entry in SYS_PATH_AT_START or not _is_leftover_plugin_entry(entry)
    ]


@pytest.fixture
def reset_lib_namespace():
    """`reset_plugin_lib_namespace` itself, for the tests that cover it.

    A fixture rather than an import: three directories hold a `conftest.py`, they
    all import under the name `conftest`, and a test module that imported one by
    name would get whichever pytest loaded last.
    """
    return reset_plugin_lib_namespace


@pytest.fixture(autouse=True)
def isolated_plugin_lib():
    """Give every test a clean `lib` namespace, before it runs and after it ends.

    Autouse and unconditional: a test that never loads a script in-process pays
    two list comprehensions, and a test that does cannot be made to pass, or to
    fail, by what an unrelated plugin's test did first.
    """
    reset_plugin_lib_namespace()
    yield
    reset_plugin_lib_namespace()


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

# Without these a returned PATH is not a usable shell environment at all, and a
# script would fail for a reason the example never meant to test.
ESSENTIAL_TOOLS = ("bash", "sh", "python3")


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
        self._monkeypatch.setenv("PATH", f"{directory}{os.pathsep}{os.environ.get('PATH', '')}")
        return str(directory)

    def path_without(self, *tools: str) -> str:
        """A bin directory of symlinks to the real tools, minus the named ones.

        Returns the directory rather than exporting it: a test usually wants to
        hand it to `run_script` as the child's whole PATH, not to lose the tools
        pytest itself needs.

        A fresh directory per call, so a second call cannot silently inherit the
        first one's links and hand back a PATH that still holds the tool the
        example is trying to take away.
        """
        unknown = [tool for tool in tools if tool not in COMMON_TOOLS]
        if unknown:
            # A typo here removes nothing and the example passes for the wrong
            # reason, which is exactly the failure the suite must not have.
            raise ValueError(
                "not tools path_without knows about: {}; add them to COMMON_TOOLS".format(
                    ", ".join(sorted(unknown))
                )
            )
        directory = Path(tempfile.mkdtemp(dir=str(self.path), prefix="bin-without-"))
        for tool in COMMON_TOOLS:
            if tool in tools:
                continue
            real = shutil.which(tool)
            if not real:
                if tool in ESSENTIAL_TOOLS:
                    raise RuntimeError(f"{tool} is not on PATH; cannot build a usable PATH")
                continue
            (directory / tool).symlink_to(real)
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
    """status, stdout and stderr of one script run, as shellspec reports them.

    The raw bytes are kept beside the decoded text for the assertions that are
    about bytes rather than about text; `stdout` is what almost every test wants.
    """

    def __init__(self, completed: subprocess.CompletedProcess) -> None:
        self.status = completed.returncode
        self.stdout_bytes = completed.stdout
        self.stderr_bytes = completed.stderr
        # errors="replace", not strict: a script that emits a stray byte would
        # otherwise raise here and lose the status and the rest of the output,
        # turning a legible assertion failure into a decoding traceback.
        self.stdout = completed.stdout.decode("utf-8", "replace")
        self.stderr = completed.stderr.decode("utf-8", "replace")


@pytest.fixture
def run_with_closed_reader():
    """Run a script whose stdout reader has already gone away.

    What `<script> | head` leaves behind once head has had enough, except that
    the read end is closed before the child is even spawned, so there is no race
    over how far it got. Stdout has to be a real pipe: `capture_output` gives a
    buffer nobody ever closes, and the branch this exists to reach never fires.

    `unbuffered` makes every line its own flush, which is how a failure lands
    mid-run rather than on the final flush. A pipe is block buffered by default,
    so a script printing a few dozen lines writes nothing until it exits, and
    only the final flush fails -- a real case too, and the other one to cover.
    Reaching the mid-run case honestly would take enough output to fill 8KB.
    """

    def run(path, *args, env=None, unbuffered=False):
        child_env = dict(os.environ)
        if unbuffered:
            child_env["PYTHONUNBUFFERED"] = "1"
        if env:
            child_env.update({key: str(value) for key, value in env.items()})
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        try:
            completed = subprocess.run(
                [sys.executable, str(path), *[str(arg) for arg in args]],
                stdout=write_fd,
                stderr=subprocess.PIPE,
                env=child_env,
                check=False,
            )
        finally:
            os.close(write_fd)
        return completed.returncode, completed.stderr.decode("utf-8", "replace")

    return run


@pytest.fixture
def run_script():
    """Run a Python script as its own process, the way Claude Code runs it.

    `sys.executable`, not `python3`: it keeps a `pytest-floor` run genuinely on
    3.9, and it is the interpreter coverage.py's subprocess patch knows to
    measure, so a script exercised black-box still counts towards the threshold.

    `cwd` runs the child from another directory, for a script that reads the
    directory it was called in -- `ft-resolve.py`'s bare-name lookup is the one
    that does. An argument rather than the test's own `monkeypatch.chdir` so the
    pytest process stays where it started: coverage.py makes its omit patterns
    absolute once, in this process, at startup, so moving it later changes
    nothing about them, but the child starts coverage of its own in `cwd` and
    resolves them there. That is what the leading `**/` on every omit pattern in
    pyproject.toml is for.

    `stdin` takes bytes as well as str, for the scripts whose contract is bytes:
    `ft-redact.py --inside` is documented as the identity function, and only a
    byte that is not valid UTF-8 can show that it is.
    """

    def run(path, *args, stdin=None, env=None, cwd=None) -> Result:
        child_env = dict(os.environ)
        if env:
            child_env.update({key: str(value) for key, value in env.items()})
        if stdin is None:
            stdin = b""
        elif isinstance(stdin, str):
            stdin = stdin.encode("utf-8")
        completed = subprocess.run(
            [sys.executable, str(path), *[str(arg) for arg in args]],
            input=stdin,
            capture_output=True,
            env=child_env,
            cwd=None if cwd is None else str(cwd),
            check=False,
        )
        return Result(completed)

    return run
