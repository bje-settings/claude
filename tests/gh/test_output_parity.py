"""The report is byte-identical to the one `gh-sync-repo.sh` printed.

`golden/bash-output.json` was captured from the shell script before it was
deleted, over the scenarios in `scenarios.py`: every skip reason, and the report
lines a normal run produces. Commit hashes and the sandbox path are normalised
out; nothing else is.

Two deliberate divergences. `git worktree list` failing left the shell version
with an empty branch-to-worktree map, because the `|| skip` after a
`done < <(...)` reads the loop's status and never the command's; an empty map
makes every branch look free of a worktree, which is the one thing that guard
exists to prevent. The port raises the skip the shell version meant to, and
`test_gh_sync_repo_edges.py` asserts it. That scenario is not in the table at
all. The second, below, is: the port names why the pull-request lookup failed,
which the shell version never did.

The golden stays the untouched bash capture, and the divergences are applied to
it here, so they stay countable rather than dissolving into a rewritten
expectation.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from scenarios import SCENARIOS, normalise

GOLDEN = json.loads((Path(__file__).resolve().parent / "golden" / "bash-output.json").read_text())

# scenario -> (the shell line, the line the port prints instead).
DIVERGENCES = {
    "pull_request_lookup_failed": (
        "could not read merged pull requests; using ancestry alone",
        "could not read merged pull requests (gh: simulated failure); using ancestry alone",
    ),
}


def expected(name):
    """The golden report for `name`, with the port's deliberate changes applied."""
    stdout = GOLDEN[name]["stdout"]
    if name in DIVERGENCES:
        was, now = DIVERGENCES[name]
        assert was in stdout, f"{name}: the divergence no longer matches the golden"
        stdout = stdout.replace(was, now)
    return stdout


def test_every_scenario_has_a_captured_report():
    """A scenario with no golden would silently assert nothing."""
    assert sorted(SCENARIOS) == sorted(GOLDEN)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_matches_the_shell_report(name, gh, sync_repo):
    argv, env = SCENARIOS[name](gh)
    result = sync_repo(*argv, env=env)
    assert result.status == GOLDEN[name]["status"]
    assert normalise(result.stdout, gh.path) == expected(name)
