---
paths:
  - "**/skills/**/SKILL.md"
  - "**/skills/**/FLOW.md"
---

# Skill Files

Every skill directory MUST contain a `FLOW.md` beside its `SKILL.md`, holding a flow diagram of
the skill as a `mermaid` fenced block.

The diagram does NOT belong in `SKILL.md`, and `SKILL.md` must not reference it either.
`SKILL.md` is loaded into context every time the skill is invoked, so anything living there is a
cost paid on every run. A diagram is read occasionally, by a person reasoning about the skill, so
it belongs in a sibling file that is opened on demand.

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

Mermaid renders natively in GitHub and in Claude Code, so no build step or image is needed.
Keep the source readable: a diagram that has to be rendered to be understood defeats the point.
