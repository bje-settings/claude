---
paths:
  - "**/skills/**/SKILL.md"
---

# Skill Files

Every `SKILL.md` MUST contain a flow diagram, as a `mermaid` fenced block, showing what the
skill does.

The diagram is for reasoning about the skill at a glance, so draw the decisions and outcomes,
not the call stack. Show the branches a reader would otherwise have to derive from prose:

- what determines which path is taken
- every terminal outcome, including the refusals, not just the happy path
- where the skill stops without acting, and why

A diagram that shows only the success path is worse than none, because it implies the failure
paths do not exist. If a skill can decline to act, that decision belongs in the diagram.

Keep it to one diagram per skill. Prefer `flowchart TD`. Node text should say what happens in
the domain ("branch has merge proof?"), not what the code does ("call `pr_proof_for_branch`"),
so the diagram survives refactoring.

Place it under a `## Flow` heading, after the opening description and before the numbered steps.

Mermaid renders natively in GitHub and in Claude Code, so no build step or image is needed.
Keep the source readable: a diagram that has to be rendered to be understood defeats the point.
