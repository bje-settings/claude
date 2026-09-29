---
type: Reference
description: The ESLint rule @bje/claude/skill-description-max-length, which limits a SKILL.md description to 1,024 characters and the description plus when_to_use to 1,536, with its options, examples and sources.
owner: brianespinosa
created: 2026-09-29
related_issues: [223]
stale_after: 2027-03-29
generated:
  by: claude-code
  at: 2026-09-29T00:00:00Z
---

# `skill-description-max-length`

Limit the length of a skill description.

| Config | Severity | Category | Files |
|--------|----------|----------|-------|
| `recommended`, `bje`, `strict` | `warn` | limit | `**/SKILL.md` |

## Rule details

Two sources limit a skill description. Each one measures a different text.

- The Agent Skills spec limits `description` to 1,024 characters. An upload to the API or to
  claude.ai fails above it.[^spec]
- The Claude Code skill listing cuts `description` plus `when_to_use` at 1,536
  characters.[^cut] The model does not see the text after the cut.

The rule does one check for each source. It counts characters as JavaScript does
(`String.length`, UTF-16 code units).

The rule reads the YAML frontmatter. It ignores a file with no frontmatter, and a file whose
frontmatter does not parse. It ignores a field that is not a string.

Legacy command files also take `description`. The rule does not check them, because
[`command-legacy-format`](command-legacy-format.md) reports each one already.

Fail:

```markdown
---
name: deploy
description: <1,025 characters>
---
```

Pass:

```markdown
---
name: deploy
description: Deploys the service to staging. Use when the user asks to ship a branch.
---
```

## Options

| Option | Default | Use |
|--------|---------|-----|
| `max` | `1024` | The limit on `description` alone. |
| `listingMax` | `1536` | The limit on `description` plus `when_to_use`. Set it to match `skillListingMaxDescChars` if you change that setting.[^fields] |

```ts
'@bje/claude/skill-description-max-length': ['warn', { max: 1024, listingMax: 1536 }]
```

## Sources

[^spec]: [Skill authoring best practices: YAML frontmatter requirements](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#yaml-frontmatter-requirements)
[^cut]: [Extend Claude with skills: Skill descriptions are cut short](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short)
[^fields]: [Extend Claude with skills: Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference)
