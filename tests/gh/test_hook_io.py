"""Black-box tests for the gh plugin's SessionStart hook helper.

Ported from spec/gh/hook_io_spec.sh; each test's docstring is the `It`
description it came from. Every run goes through `run_script`, so the helper is
exercised as its own process exactly as the shell hook runs it.
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
