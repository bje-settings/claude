---
type: Reference
description: The ESLint rule @bje/claude/command-legacy-format, which reports each Markdown file in a .claude/commands/ directory or in a plugin's commands/ directory as the legacy form of a skill.
owner: brianespinosa
created: 2026-09-29
related_issues: [223]
stale_after: 2027-03-29
generated:
  by: claude-code
  at: 2026-09-29T00:00:00Z
---

# `command-legacy-format`

Use a skill, not the legacy command format.

| Config | Severity | Category | Files |
|--------|----------|----------|-------|
| `recommended` | `warn` | deprecated | `**/commands/**/*.md` |
| `bje`, `strict` | `error` | deprecated | `**/commands/**/*.md` |

## Rule details

Commands still work, but the docs call them the legacy form of a skill.[^first][^glossary] A
skill at `skills/<name>/SKILL.md` does the same job. It also holds supporting files, and the
model can start it on its own.[^components]

The glob is broad. The rule then reports a file only when its `commands/` directory is one that
Claude Code reads:

- a `commands/` directory in `.claude/`, at any depth below it;
- a `commands/` directory at the root of a plugin, next to `.claude-plugin/plugin.json`.

Any other `commands/` directory, for example `docs/commands/`, is not a report.

Fail: `.claude/commands/deploy.md`, `plugins/ops/commands/deploy.md`.

Pass: `.claude/skills/deploy/SKILL.md`, `plugins/ops/skills/deploy/SKILL.md`,
`docs/commands/deploy.md`.

## Options

None.

## Sources

[^first]: [Extend Claude with skills: Create your first skill](https://code.claude.com/docs/en/skills#create-your-first-skill)
[^glossary]: [Glossary: Deprecated and renamed terms](https://code.claude.com/docs/en/glossary#deprecated-and-renamed-terms)
[^components]: [Add components to a plugin: Commands](https://code.claude.com/docs/en/plugins/components#commands)
