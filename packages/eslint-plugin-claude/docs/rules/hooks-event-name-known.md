---
type: Reference
description: The ESLint rule @bje/claude/hooks-event-name-known, which reports a hook event name that Claude Code does not know in hooks.json, settings or plugin.json, and suggests the name for a near miss.
owner: brianespinosa
created: 2026-09-29
related_issues: [223]
stale_after: 2027-03-29
generated:
  by: claude-code
  at: 2026-09-29T00:00:00Z
---

# `hooks-event-name-known`

Use a hook event name that Claude Code knows.

| Config | Severity | Category | Files |
|--------|----------|----------|-------|
| `recommended`, `bje`, `strict` | `error` | no-op | `**/hooks/hooks.json`, `**/.claude/settings.json`, `**/.claude/settings.local.json`, `**/.claude-plugin/plugin.json` |

## Rule details

Claude Code skips a hook entry under an event name that it does not know. It shows no
error.[^lifecycle][^never] The names are case-sensitive.

The rule reads the `hooks` object at the top level of each file. It checks each key against the
33 events in the hooks reference, as of Claude Code 2.1.284. The list is in
`src/data/hook-events.ts`.

A key that is a near miss gets a suggestion with the correct name. A near miss has the same
letters with a different case or separator (`preToolUse`, `pre_tool_use`), or is two edits or
fewer from a known name. The suggestion is not an autofix. A rename changes what runs, because
a hook that never fired starts to fire.

Hooks in skill and agent frontmatter use the same names. A later rule checks them.

Fail:

```json
{ "hooks": { "preToolUse": [] } }
```

Pass:

```json
{ "hooks": { "PreToolUse": [] } }
```

## Options

| Option | Default | Use |
|--------|---------|-----|
| `additionalEvents` | `[]` | Event names to accept that are not in the list yet, for a Claude Code release newer than the list. |

```ts
'@bje/claude/hooks-event-name-known': ['error', { additionalEvents: ['NewEvent'] }]
```

## Sources

[^lifecycle]: [Hooks reference: Hook lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle)
[^never]: [Troubleshoot plugins: Hook loads but never fires](https://code.claude.com/docs/en/plugins/troubleshooting#hook-loads-but-never-fires)
