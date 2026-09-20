"""Skill rules, across the plugins and the repo's own tooling.

Every skill documents its flow in a sibling FLOW.md, keeps the diagram out of
SKILL.md, and spells out the scripts it runs rather than stashing a command in a
variable. Ported from spec/skills_spec.sh. Globs rather than listing skills, so
a new skill is checked without anyone editing this file.

Two roots, not one. `plugins/` holds what people install. `.claude/skills/` holds
this repo's own tooling, which is subject to the same rules and is checked by
nothing else: `claude plugin validate --strict` only ever sees `.` and
`plugins/*/`, so without this file the repo-local skills have no validation at
all. Hence the frontmatter check at the bottom, which the plugin skills get from
validate and these do not.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
REPO_SKILLS = ROOT / ".claude" / "skills"
SKILL_ROOTS = (PLUGINS, REPO_SKILLS)

MERMAID_FENCE = re.compile(r"^```mermaid", re.MULTILINE)

# A command held in a variable and expanded as one. zsh does not word-split an
# unquoted expansion, so `S="python3 ...py"; $S show` looks up the whole string
# as a command name and exits 127 under the Bash tool's shell. Spell the script
# out at every call site: python3 "${CLAUDE_PLUGIN_ROOT}/scripts/x.py" show.
# The interpreter half of the pattern allows digits, so `python3` is caught.
COMMAND_IN_A_VARIABLE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*="[a-z][a-z0-9]* ')
# A bare expansion in command position. ${VAR} placeholders inside a path are
# fine; a lone $VAR starting the line is the idiom this rejects.
BARE_EXPANSION = re.compile(r"^\$[A-Za-z_][A-Za-z0-9_]* ")


def skills_under(root: Path):
    # Rooted at a named directory and walked to any depth, which is exactly what
    # the shell spec this replaced did: `find "$ROOT/plugins" -path '*/skills/*'
    # -name SKILL.md`. Both halves matter. Walking from the repo root instead
    # would descend into .claude/worktrees/, where a checkout of this same repo
    # doubles every skill and makes the count meaningless -- which is also why
    # the second root is .claude/skills and never .claude. A fixed-depth glob
    # would quietly stop checking a skill the day someone groups them into
    # subdirectories.
    if root == REPO_SKILLS:
        # Already inside a skills/ directory, so every SKILL.md under it counts.
        return sorted(root.rglob("SKILL.md"))
    return sorted(
        path for path in root.rglob("SKILL.md") if "skills" in path.relative_to(root).parts[:-1]
    )


def skill_files():
    found = []
    for root in SKILL_ROOTS:
        found.extend(skills_under(root))
    return sorted(found)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def test_finds_skills_to_check():
    """finds skills to check

    Without this, a glob that matches nothing makes every check below pass
    vacuously -- the "green for the wrong reason" failure this suite exists to
    prevent.
    """
    assert skill_files()


def test_finds_skills_under_every_root():
    """finds skills under each root it claims to check

    The guard above stops protecting a root the moment there are two of them:
    plugins/ alone keeps the combined list non-empty, so a typo in the second
    path would leave this file green while enforcing nothing on the skills it
    was extended to cover. Each root is asserted on its own.

    If a root legitimately empties out, delete it from SKILL_ROOTS rather than
    loosening this.
    """
    empty = [str(root.relative_to(ROOT)) for root in SKILL_ROOTS if not skills_under(root)]
    assert empty == []


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


def test_the_repo_local_skills_declare_their_frontmatter():
    """gives every repo-local skill a name, a description, and no model invocation

    `claude plugin validate --strict` covers the plugin skills' frontmatter and
    never sees these: CI and the lefthook `plugin-validate` step both point it
    at `.` and `plugins/*/` only. So the checks a plugin skill gets for free
    are made here instead.

    disable-model-invocation is not optional for these. Repo tooling acts on the
    repository, and a skill with side effects that the model can reach on its own
    is a side effect nobody asked for.
    """
    missing = []
    for skill in skills_under(REPO_SKILLS):
        text = skill.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            missing.append(f"{rel(skill)}: no frontmatter")
            continue
        frontmatter = text.split("---\n", 2)[1]
        for field in ("name:", "description:", "disable-model-invocation: true"):
            if field not in frontmatter:
                missing.append(f"{rel(skill)}: {field}")
    assert missing == []
