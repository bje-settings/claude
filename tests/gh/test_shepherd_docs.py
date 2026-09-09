"""The prose that carries the shepherd loop, checked for the parts a script cannot enforce.

`settle` is only useful if the agent calls it, the orchestrator only catches the
residual race if its skill says to make that read, and the diagram is what a
reader consults before either. None of that is reachable from the scripts'
tests, so it is asserted here.

Positive assertions only: these files are prose and get reworded, and a test
that fails on a rewording is a test that gets deleted. What is asserted is that
each document still names the mechanism it is responsible for.

Every assertion is scoped with `section`, which fails loudly when a marker it
slices on has moved. A bare `split` would do the opposite of what a test should:
an `IndexError` where a reader expects an assertion, or -- worse -- a whole
document handed back as "the section", where a substring check passes for the
wrong reason and the test quietly stops testing anything.
"""

from __future__ import annotations

import pytest
from conftest import ROOT

AGENT = ROOT / "plugins" / "gh" / "agents" / "shepherd-repo.md"
SKILL = ROOT / "plugins" / "gh" / "skills" / "shepherd" / "SKILL.md"
FLOW = ROOT / "plugins" / "gh" / "skills" / "shepherd" / "FLOW.md"


def section(path, start, end=None):
    """The text between two markers, asserting each one is still there.

    `end` of None runs to the end of the file.
    """
    body = path.read_text(encoding="utf-8")
    assert body.count(start) == 1, f"{path.name}: expected exactly one {start!r}"
    body = body.split(start, 1)[1]
    if end is None:
        return body
    assert body.count(end) >= 1, f"{path.name}: {end!r} does not follow {start!r}"
    return body.split(end, 1)[0]


def test_the_agent_names_settle_in_the_actions_it_may_run():
    """An action the agent does not know about is an action nobody calls."""
    lines = [
        line
        for line in AGENT.read_text(encoding="utf-8").splitlines()
        if "gh-shepherd-pr.py" in line and "|" in line
    ]
    assert len(lines) == 1, "expected one pipe-separated action line in the agent's usage block"
    assert "settle" in lines[0].split()[-1].split("|")


@pytest.mark.parametrize("result", ["merged", "blocked", "changed", "closed", "open"])
def test_the_agent_says_what_to_do_with_every_settle_result(result):
    """The `passed` arm is where the false `blocked` came from."""
    passed = section(AGENT, "- `passed`", "- `pending`")
    assert "`settle`" in passed
    assert f"`{result}`" in passed


def test_the_agent_bounds_a_settle_call_like_the_other_blocking_ones():
    """Without `timeout: 600000` the Bash call is cut off at 120s and the agent sees nothing."""
    rule = section(AGENT, "## Hard rules", "## The loop")
    assert "`settle` call MUST pass `timeout: 600000`" in rule


def test_the_agent_forbids_a_blocked_reason_it_did_not_read():
    """Defect two of the field test: the reason carried hypotheses the state contradicted."""
    rule = section(AGENT, "## Hard rules", "## The loop")
    assert "only fields you actually read" in rule


@pytest.mark.parametrize("field", ["reviewDecision", "autoMerge", "waited"])
def test_the_agent_report_carries_what_settle_read(field):
    """The orchestrator's reclassification decides from these, so they have to travel."""
    assert field in section(AGENT, "## Report")


def test_the_skill_reclassifies_a_blocked_entry_with_one_merged_read():
    """Scoped to the step: `merged` alone appears in the report table too."""
    step = section(SKILL, "## Step 4", "## Step 5")
    assert 'gh-shepherd-pr.py" <path> <n> merged' in step
    assert "autoMerge" in step
    assert "CLEAN" in step and "UNKNOWN" in step


def test_the_skill_does_not_re_read_a_blocked_entry_that_names_a_cause():
    """The safety-relevant half: GitHub decided those, so timing cannot undo them."""
    step = section(SKILL, "## Step 4", "## Step 5")
    assert "not run" in step
    for named in ("BLOCKED", "DIRTY", "BEHIND", "reviewDecision"):
        assert named in step


def test_the_flow_diagram_carries_the_settle_branch():
    body = section(FLOW, "```mermaid", "```")
    assert "Settle" in body
    assert "BEHIND or DIRTY" in body
