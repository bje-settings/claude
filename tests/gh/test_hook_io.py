"""Black-box tests for the seams the gh plugin's SessionStart hook is built from.

`hook-io.py` is the hook: `hooks.json` runs `hook-io.py session-start`, and
`tests/gh/test_session_start.py` covers that whole path. Its `cwd`, `branch` and
`report` subcommands are the pieces that decision is built from, kept as seams
for the tests and for debugging the hook by hand, and this file is those three.

The eight ported tests carry the `It` description they came from in their
docstring; the rest were added with the port. Every run goes through
`run_script`, so a seam is exercised as its own process, exactly as a person
debugging the hook would run it.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HOOK_IO = ROOT / "plugins" / "gh" / "hooks" / "hook-io.py"


def context_of(stdout: str) -> str:
    """The additionalContext of a SessionStart hook response."""
    payload = json.loads(stdout)
    output = payload["hookSpecificOutput"]
    assert output["hookEventName"] == "SessionStart"
    return output["additionalContext"]


# --- cwd ---------------------------------------------------------------------


def test_prints_the_cwd(run_script):
    """prints the cwd from a payload"""
    result = run_script(HOOK_IO, "cwd", stdin='{"session_id":"s","cwd":"/some/where"}')
    assert result.status == 0
    assert result.stdout.strip() == "/some/where"


def test_prints_nothing_without_a_cwd(run_script):
    """prints nothing for a payload with no cwd"""
    result = run_script(HOOK_IO, "cwd", stdin='{"session_id":"s"}')
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_prints_nothing_on_malformed_json(run_script):
    """prints nothing rather than failing on malformed JSON

    The hook falls back to its own working directory, and must never block a
    session over a payload it could not read.
    """
    result = run_script(HOOK_IO, "cwd", stdin="not json")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_prints_nothing_when_the_payload_is_not_an_object(run_script):
    """prints nothing when the payload is not an object"""
    result = run_script(HOOK_IO, "cwd", stdin='["a","b"]')
    assert result.status == 0
    assert result.stdout.strip() == ""


# --- messages ----------------------------------------------------------------


def test_branch_message_names_both_branches(run_script):
    """emits the branch message with both branch names"""
    result = run_script(HOOK_IO, "branch", "feature-x", "main")
    assert result.status == 0
    context = context_of(result.stdout)
    assert "feature-x" in context
    assert "main" in context
    assert "/gh:sync" in context


def test_report_message_wraps_the_report(run_script):
    """emits the report message wrapping the report it is given"""
    result = run_script(HOOK_IO, "report", stdin="repo-a: would delete gone")
    assert result.status == 0
    context = context_of(result.stdout)
    assert "would delete gone" in context
    assert "No branch, worktree, or working tree" in context


def test_report_reads_a_non_ascii_report_under_a_single_byte_locale(run_script):
    """Added with the port: the report on stdin holds ✓, ✗ and ·.

    Reading is the half `use_utf8` was not doing before the port. Under
    LC_ALL=en_US.ISO8859-1 with PYTHONIOENCODING=ascii an unreconfigured stdin
    raises UnicodeDecodeError on the first line carrying one, and the hook dies
    with a traceback instead of wrapping the report. The literal survives
    because the answer is `ensure_ascii` JSON, which any locale can write.
    """
    result = run_script(
        HOOK_IO,
        "report",
        stdin="a: ✗ fetch failed",
        env={"LC_ALL": "en_US.ISO8859-1", "PYTHONIOENCODING": "ascii"},
    )
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert "a: ✗ fetch failed" in context_of(result.stdout)


# --- contract ----------------------------------------------------------------


def test_rejects_an_unknown_mode(run_script):
    """rejects an unknown mode"""
    result = run_script(HOOK_IO)
    assert result.status == 2
    assert "usage:" in result.stderr


def test_rejects_branch_without_both_names(run_script):
    """rejects the branch mode without both branch names"""
    result = run_script(HOOK_IO, "branch", "only-one")
    assert result.status == 2
    assert "usage:" in result.stderr


# --- no dependency on anything outside the stdlib -----------------------------


def test_runs_with_the_plugin_tools_stripped_from_path(run_script, sandbox):
    """runs with git, jq and gh absent from PATH

    A hook runs on every session start, so it depends only on what a Mac already
    has. `path_without` builds the PATH that proves it.
    """
    bare = sandbox.path_without("git", "jq", "gh")
    result = run_script(HOOK_IO, "cwd", stdin='{"cwd":"/some/where"}', env={"PATH": bare})
    assert result.status == 0
    assert result.stdout.strip() == "/some/where"


def test_does_not_shell_out_to_a_tool_it_finds_first_on_path(run_script, sandbox):
    """ignores poisoned git, jq and gh stubs placed ahead of the real ones

    Same claim from the other side, and the one `stub_path` exists to make: if
    the helper ever grew a subprocess call, these stubs would fail it loudly
    rather than the suite noticing years later.
    """
    stubs = sandbox / "stubs"
    stubs.mkdir()
    for tool in ("git", "jq", "gh"):
        script = stubs / tool
        script.write_text("#!/bin/sh\necho poisoned >&2\nexit 3\n")
        script.chmod(0o755)
    sandbox.stub_path(stubs)
    result = run_script(HOOK_IO, "branch", "feature-x", "main")
    assert result.status == 0
    assert "poisoned" not in result.stderr
    assert "feature-x" in context_of(result.stdout)
