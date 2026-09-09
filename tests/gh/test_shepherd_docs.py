"""The prose that carries the shepherd loop, checked for the parts a script cannot enforce.

`settle` is only useful if the agent calls it, the orchestrator only catches the
residual race if its skill says to make that read, and the diagram is what a
reader consults before either. None of that is reachable from the scripts'
tests, so it is asserted here.

Positive assertions only: these files are prose and get reworded, and a test
that fails on a rewording is a test that gets deleted. What is asserted is that
each document still names the mechanism it is responsible for.
"""

from __future__ import annotations

import pytest
from conftest import ROOT

AGENT = ROOT / "plugins" / "gh" / "agents" / "shepherd-repo.md"
SKILL = ROOT / "plugins" / "gh" / "skills" / "shepherd" / "SKILL.md"
FLOW = ROOT / "plugins" / "gh" / "skills" / "shepherd" / "FLOW.md"


def test_the_agent_names_settle_in_the_actions_it_may_run():
    """An action the agent does not know about is an action nobody calls."""
    assert "settle" in AGENT.read_text().split("## Hard rules")[0]


def test_the_agent_calls_settle_on_a_passing_check_run():
    """The `passed` arm is where the false `blocked` came from."""
    body = AGENT.read_text()
    passed = body.split("- `passed`")[1].split("- `pending`")[0]
    assert "`settle`" in passed
    for result in ("merged", "blocked", "changed", "closed", "open"):
        assert result in passed, f"the passed arm does not say what to do with `{result}`"


def test_the_agent_bounds_a_settle_call_like_the_other_blocking_ones():
    """Without `timeout: 600000` the Bash call is cut off at 120s and the agent sees nothing."""
    body = AGENT.read_text()
    rule = body.split("## Hard rules")[1].split("## The loop")[0]
    assert "settle" in rule
    assert "600000" in rule


def test_the_agent_forbids_a_blocked_reason_it_did_not_read():
    """Defect two of the field test: the reason carried hypotheses the state contradicted."""
    rule = AGENT.read_text().split("## Hard rules")[1].split("## The loop")[0]
    assert "only fields you actually read" in rule


@pytest.mark.parametrize("field", ["reviewDecision", "autoMerge", "waited"])
def test_the_agent_report_carries_what_settle_read(field):
    """The orchestrator's reclassification decides from these, so they have to travel."""
    report = AGENT.read_text().split("## Report")[1]
    assert field in report


def test_the_skill_reclassifies_a_blocked_entry_with_one_merged_read():
    body = SKILL.read_text()
    assert "merged" in body
    assert "autoMerge" in body
    assert "CLEAN" in body and "UNKNOWN" in body


def test_the_flow_diagram_carries_the_settle_branch():
    body = FLOW.read_text()
    assert "Settle" in body
    assert "BEHIND or DIRTY" in body
