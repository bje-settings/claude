"""The shared sandbox is test infrastructure, so it gets its own tests.

Everything else in the suite trusts these helpers to isolate an example and to
take a tool away when asked. A helper that quietly did neither would make ports
pass for the wrong reason, which is the one failure mode this suite exists to
rule out.
"""

from __future__ import annotations

import importlib.util
import os
import sys
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


def write_plugin(root: Path, plugin: str, mark: str) -> Path:
    """A plugin laid out the way a real one is, whose script reports its own `lib`.

    `scripts/lib/cli.py` carries one attribute named after the plugin, and the
    script reads it at import time through `from lib import cli`, exactly as a
    real script reaches `cli.run`. Two of these are enough to tell which
    plugin's `lib` an in-process load actually resolved.
    """
    scripts = root / "plugins" / plugin / "scripts"
    (scripts / "lib").mkdir(parents=True)
    (scripts / "lib" / "cli.py").write_text(f"{mark} = {mark!r}\n", encoding="utf-8")
    script = scripts / f"{plugin}-say.py"
    script.write_text(
        "import os, sys\n"
        "HERE = os.path.dirname(os.path.abspath(__file__))\n"
        "sys.path.insert(0, HERE)\n"
        "from lib import cli  # noqa: E402\n"
        f"MARK = cli.{mark}\n",
        encoding="utf-8",
    )
    return script


def load_in_process(script: Path, name: str):
    """Load a script under a unique module name, as the plugin conftests do."""
    spec = importlib.util.spec_from_file_location(name, script)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        del sys.modules[name]
        raise
    return module


def test_each_plugins_script_resolves_its_own_lib(tmp_path, reset_lib_namespace):
    # A unique module name per script is not enough: both scripts run their own
    # `from lib import cli`, which goes through sys.modules["lib"].
    alpha = write_plugin(tmp_path, "alpha", "ALPHA")
    beta = write_plugin(tmp_path, "beta", "BETA")

    assert load_in_process(alpha, "alpha_say").MARK == "ALPHA"
    # What the autouse fixture does between two tests, done here between two
    # loads, so one test can show both halves.
    reset_lib_namespace()
    assert load_in_process(beta, "beta_say").MARK == "BETA"


def test_without_the_reset_the_second_plugin_gets_the_first_ones_lib(tmp_path):
    # The failure the fixture exists to prevent, spelled out: this is
    # `AttributeError: module 'lib.cli' has no attribute 'Failure'` in CI, with
    # the plugin that lost the race named in neither the message nor the
    # traceback. Without the reset above, the test before this one fails the
    # same way.
    alpha = write_plugin(tmp_path, "alpha", "ALPHA")
    beta = write_plugin(tmp_path, "beta", "BETA")

    load_in_process(alpha, "alpha_say")
    with pytest.raises(AttributeError, match="'lib.cli' has no attribute 'BETA'"):
        load_in_process(beta, "beta_say")


def test_the_fixture_leaves_no_lib_behind_for_the_next_test(tmp_path, reset_lib_namespace):
    # The test above left alpha's lib in sys.modules and alpha's scripts/ on
    # sys.path. Ordering makes that hard to assert from another test, so assert
    # the teardown half directly instead.
    load_in_process(write_plugin(tmp_path, "alpha", "ALPHA"), "alpha_say")
    assert "lib" in sys.modules
    reset_lib_namespace()
    assert "lib" not in sys.modules
    assert not [entry for entry in sys.path if entry.endswith("alpha/scripts")]


def test_the_reset_keeps_the_path_entries_pytest_itself_added(reset_lib_namespace):
    # pytest prepends each test directory to sys.path as it collects, and the
    # snapshot is taken before that. Only a plugin's scripts/ or hooks/ entry is
    # a leftover; nothing else may be swept up with it.
    before = list(sys.path)
    reset_lib_namespace()
    assert sys.path == before
