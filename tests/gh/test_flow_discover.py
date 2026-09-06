"""Ported from `spec/gh/flow_discover_spec.sh`.

/gh:sync and /gh:shepherd resolve their scope through the same library, so their
flow diagrams describe it with one shared `discover` subgraph. Drift between the
two copies would mean one diagram is lying about how scope is decided.
"""

from __future__ import annotations

import re

import pytest
from conftest import ROOT

SKILLS = ROOT / "plugins" / "gh" / "skills"


def discover_block(skill):
    """The `subgraph discover ... end` block of one FLOW.md, indentation stripped."""
    lines = (SKILLS / skill / "FLOW.md").read_text().splitlines()
    block = []
    inside = False
    for line in lines:
        if re.match(r"^ *subgraph discover ", line):
            inside = True
        if inside:
            block.append(line.strip())
        if inside and line.strip() == "end":
            break
    return "\n".join(block)


@pytest.mark.parametrize("skill", ["sync", "shepherd"])
def test_draws_a_discover_subgraph(skill):
    """draws a discover subgraph in the sync / shepherd diagram"""
    block = discover_block(skill)
    assert "Inside a git repo?" in block
    assert "Skipped silently" in block
    assert "Stop: no git repositories directly inside cwd" in block


def test_keeps_the_two_discover_subgraphs_identical():
    """keeps the two discover subgraphs identical"""
    assert discover_block("sync") == discover_block("shepherd")
