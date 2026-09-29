# `@bje/eslint-plugin-claude`

ESLint rules for Claude Code configuration files: skills, commands, hooks, settings and plugin
manifests. [ADR 005](../../docs/adr/005-eslint-plugin-for-claude-config.md) is the decision
record. [The rule inventory](../../docs/eslint-plugin-claude-rules.md) lists the rules to come.

The plugin runs on [`@eslint/markdown`](https://github.com/eslint/markdown) and
[`@eslint/json`](https://github.com/eslint/json). It reads YAML frontmatter with
[`yaml`](https://github.com/eemeli/yaml).

## Use

This repository loads the plugin by relative path. It is not published yet (ADR 005 Decision 9).

```ts
// eslint.config.ts
import claude from './packages/eslint-plugin-claude/src/index.ts'

export default [...claude.configs.recommended]
```

Each rule brings its own `files` glob and language, so the config needs no other setup.

ESLint loads `eslint.config.ts` only with `--flag unstable_native_nodejs_ts_config`. Without the
flag, it asks for `jiti`. In this repository, `pnpm lint` passes the flag.

## Configs

| Config | Rules |
|--------|-------|
| `recommended` | Rules whose source is Anthropic documentation. |
| `bje` | `recommended`, plus the conventions of the bje enterprise. |
| `strict` | `bje`, then each rule that is still off, at `warn`. Use it to test the full rule set. |

## Rules

| Rule | Checks | `recommended` | `bje` |
|------|--------|---------------|-------|
| [`skill-description-max-length`](docs/rules/skill-description-max-length.md) | `description` length, and `description` plus `when_to_use` | `warn` | `warn` |
| [`command-legacy-format`](docs/rules/command-legacy-format.md) | A command file is the legacy form of a skill | `warn` | `error` |
| [`hooks-event-name-known`](docs/rules/hooks-event-name-known.md) | Each hook event name is one that Claude Code knows | `error` | `error` |
