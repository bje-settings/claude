"""Cross-plugin skill rules.

Every skill documents its flow in a sibling FLOW.md, keeps the diagram out of
SKILL.md, and spells out the scripts it runs rather than stashing a command in a
variable. Ported from spec/skills_spec.sh. Globs rather than listing skills, so
a new plugin's skills are checked without anyone editing this file.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"

MERMAID_FENCE = re.compile(r"^```mermaid", re.MULTILINE)

# A command held in a variable and expanded as one. zsh does not word-split an
# unquoted expansion, so `S="bash ...sh"; $S show` looks up the whole string as a
# command name and exits 127 under the Bash tool's shell. Spell the script out at
# every call site: bash "${CLAUDE_PLUGIN_ROOT}/scripts/x.sh" show
COMMAND_IN_A_VARIABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*="[a-z]+ ')
# A bare expansion in command position. ${VAR} placeholders inside a path are
# fine; a lone $VAR starting the line is the idiom this rejects.
BARE_EXPANSION = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]* ")


def skill_files():
    # Rooted at plugins/ and walked to any depth, which is exactly what the shell
    # spec this replaced did: `find "$ROOT/plugins" -path '*/skills/*' -name
    # SKILL.md`. Both halves matter. Walking from the repo root instead would
    # descend into .claude/worktrees/, where a checkout of this same repo doubles
    # every skill and makes the count meaningless. A fixed-depth glob instead
    # would quietly stop checking a skill the day someone groups them into
    # subdirectories.
    return sorted(
        path
        for path in PLUGINS.rglob("SKILL.md")
        if "skills" in path.relative_to(PLUGINS).parts[:-1]
    )


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def test_finds_skills_to_check():
    """finds skills to check

    Without this, a glob that matches nothing makes every check below pass
    vacuously -- the "green for the wrong reason" failure this suite exists to
    prevent.
    """
    assert skill_files()


def test_every_skill_has_a_flow_md():
    """gives every skill a FLOW.md beside its SKILL.md"""
    missing = [rel(skill) for skill in skill_files() if not (skill.parent / "FLOW.md").is_file()]
    assert missing == []


def test_every_flow_md_has_a_diagram():
    """puts a mermaid diagram in every FLOW.md"""
    without = []
    for skill in skill_files():
        flow = skill.parent / "FLOW.md"
        if not flow.is_file():
            continue
        if not MERMAID_FENCE.search(flow.read_text(encoding="utf-8")):
            without.append(rel(flow))
    assert without == []


def test_the_diagram_stays_out_of_skill_md():
    """keeps the diagram out of SKILL.md

    Required by .claude/rules/file-skill-md.md: SKILL.md is context on every run,
    FLOW.md is read on demand.
    """
    carrying = [
        rel(skill)
        for skill in skill_files()
        if MERMAID_FENCE.search(skill.read_text(encoding="utf-8"))
    ]
    assert carrying == []


def test_every_script_a_skill_runs_is_spelled_out():
    """spells out every script a skill runs"""
    hits = []
    for skill in skill_files():
        for number, line in enumerate(skill.read_text(encoding="utf-8").splitlines(), 1):
            if COMMAND_IN_A_VARIABLE.match(line) or BARE_EXPANSION.match(line):
                hits.append(f"{rel(skill)}:{number}:{line}")
    assert hits == []
