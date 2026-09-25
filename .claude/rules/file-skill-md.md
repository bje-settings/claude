---
paths:
  - "**/skills/**/SKILL.md"
  - "**/docs/flows/**"
---

# Skill Files

Every skill MUST have a flow directory, `docs/flows/<plugin>/<skill>/`. A repo-local skill uses
`docs/flows/_repo/<skill>/`. The directory holds:

- `_skill-flow.md`: the flow of the skill.
- `<subcommand>-flow.md`: the flow of each dispatcher subcommand that `SKILL.md` runs, such as
  `sync-flow.md` for `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" sync`. When two skills run the
  same subcommand, each directory has an identical copy.

Each file holds one diagram, as a `mermaid` fenced block, with the OKF frontmatter of
`.claude/rules/path-docs.md`. Add a row for a new file to `docs/flows/index.md`.

The diagram does NOT belong in `SKILL.md`, and `SKILL.md` must not reference it either. The skill
loads `SKILL.md` into context every time it runs. So anything that lives there costs context on
every run. A person reads a diagram occasionally, to reason about the skill. So the diagram
belongs in a separate file. It is not in the skill directory, because that directory ships to
each user.

The diagram helps a reader reason about the skill at a glance. So draw the decisions and
outcomes, not the call stack. Show the branches a reader would otherwise have to derive from
prose:

- what determines which path is taken
- every terminal outcome, including the refusals, not just the happy path
- where the skill stops and does nothing, and why

A diagram that shows only the success path is worse than none. It implies the failure paths do
not exist. If a skill can decline to act, that decision belongs in the diagram.

Keep it to one diagram per file. Prefer `flowchart TD`. Node text should say what happens in
the domain ("branch has merge proof?"), not what the code does ("call `pr_proof_for_branch`").
This way the diagram survives code changes.

## Commands in SKILL.md

Spell out every script a skill runs, at every call site:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" sync
```

Do NOT hold the command in a variable and expand it (`S="node ...ts"` then `$S sync`). zsh does
not word-split an unquoted expansion. So it looks up the whole string as one command name, and
the call exits 127. The Bash tool's shell is whatever the user's login shell is. It discards
shell state between calls. So a variable or function defined in one block is not there for the
next. `tests/repo/skills.test.ts` enforces this.

Mermaid renders natively in GitHub and in Claude Code. It needs no build step or image. Keep the
source readable. If a reader must render the diagram to understand it, the diagram defeats its
own point.
