---
type: ADR
description: The checks for Claude Code configuration files (SKILL.md, agents, plugin and marketplace manifests, hooks.json, settings) live in an ESLint plugin that this repository writes and owns. It runs on @eslint/markdown and @eslint/json, with `yaml` for frontmatter. The plugin proves itself in this repository first. A later decision covers how other organizations install it.
status: stable
created: 2026-09-27
owner: brianespinosa
related_issues: [223]
---

# ADR 005: An ESLint plugin for Claude Code configuration files

## Context

**A person found a defect that a check could find.** A review comment on #222 found that the
`gh:issues` description did not follow the skill authoring guidance. The description was
imperative, not third person, and its trigger was narrow. That skill sets `user-invocable: false`,
so the description is its only trigger. #191 is an earlier case of the same kind: a frontmatter
flag hid a skill from the skills that call it.

**The current checks cover structure, not practice.** `claude plugin validate --strict` checks that
a manifest loads, and it only turns warnings into errors
([plugin commands reference](https://code.claude.com/docs/en/plugins/cli-reference)).
`tests/repo/skills.test.ts` checks flow files, spelled-out scripts, and three frontmatter fields on
repo-local skills. Nothing checks the practices in the
[skills docs](https://code.claude.com/docs/en/skills) or the
[skill authoring guide](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

**The checks span two file formats and more than one file.**

- Skills and agents are Markdown with YAML frontmatter.
- Plugin manifests, the marketplace manifest, `hooks.json` and settings are JSON.
- Some checks read a second file. Examples: a skill name that must match its directory, a
  referenced file that must exist, and a hook command that must point at a real script.

**Other teams in other organizations need the same checks.** The owner wants to give those teams
one install, not a set of tools to join together. The checks must run in three places: the editor,
a staged-only commit hook (ADR 002), and CI.

**The checks must come from a trusted source.** A check that a third party can change without
review is not acceptable. A Claude Code plugin that updates itself and runs scripts in a session is
not acceptable either.

**Current tools do not meet all of these constraints.** An evaluation on #223 found:

| Tool | Why it does not fit |
|------|---------------------|
| [Skillsaw](https://github.com/stbenjam/skillsaw) | The authors control the checks. It needs Python, and its commit hook lints the whole repository. |
| [claudelint](https://github.com/pdugan20/claudelint) | The authors control the checks. It has no staged-only hook, and one form is a Claude Code plugin. |
| [@gtbuchanan/eslint-plugin-agent-skills](https://github.com/gtbuchanan/tooling/tree/main/packages/eslint-plugin-agent-skills) | It covers `SKILL.md` only. One maintainer publishes it, and v1.0.0 is from 2026-09-05. |
| Biome GritQL plugins | Biome has no Markdown parser. A GritQL pattern sees one file only. |
| markdownlint-cli2 custom rules | It is for Markdown. Its editor extension does not lint JSON. |
| Oxlint JS plugins | Oxlint lints JavaScript and TypeScript only. |

No package named `eslint-plugin-claude`, `@bje/eslint-plugin` or `@bje/eslint-plugin-claude` was
on npm on 2026-09-27.

## Decision

1. **This repository writes and owns an ESLint plugin for Claude Code configuration files.** Its
   rules use the two official ESLint language plugins:
   - [`@eslint/markdown`](https://github.com/eslint/markdown), with `frontmatter: "yaml"`, for
     skills, agents and commands;
   - [`@eslint/json`](https://github.com/eslint/json) for manifests, `hooks.json` and settings.

   A rule that needs a second file reads it from `context.filename`. No third-party ESLint plugin
   is a dependency. The two plugins in the table above are prior art to read, not code to import.
2. **The plugin ships three configs.**
   - `recommended` holds the rules that follow from the Claude Code docs and the skill authoring
     guide. Any team can use it. A rule goes here only when Anthropic documentation is its source.
   - `strict` extends `bje`, then turns on at `warn` each rule that is still off, the heuristics
     included. It gives an easy way to test the full rule set.
   - `bje` extends `recommended` with the conventions of this enterprise, for example the
     `SessionStart` matcher in `.claude/rules/_design-principles.md`. A preference of this
     enterprise never goes in `recommended`.

   A check that only this repository needs, such as the flow directories, stays in
   `tests/repo/`. A check that needs a model judgment is not a lint rule.
3. **The name is `@bje/eslint-plugin-claude`.** Its rules read `@bje/claude/<rule>` in a config.
4. **The code lives at `packages/eslint-plugin-claude/`.** It is not a Claude Code plugin, so it
   is not under `plugins/`. It is not shared by plugins, so it is not in `lib/`. Its tests live at
   `tests/packages/eslint-plugin-claude/` (ADR 004). A `#eslint-plugin-claude/*` entry in the root
   `package.json` `imports` map reaches it.
5. **It follows ADR 001 while it is in this repository.** It is erasable TypeScript that node
   runs directly, with no build step. The root `eslint.config.ts` loads it by relative path. It
   has no `package.json` of its own yet. ESLint reads `eslint.config.ts` only with
   `--flag unstable_native_nodejs_ts_config`. The `lint` script in `package.json` passes the
   flag, so CI and the hook use one command. An editor extension needs the flag too, through
   `eslint.options.flags` or `ESLINT_FLAGS` (`CONTRIBUTING.md`).
6. **The dependencies are root devDependencies at exact versions:** `eslint`, `@eslint/markdown`,
   `@eslint/json` and `yaml`. None of them has an install script. `@eslint/markdown` gives the
   frontmatter as raw text. `yaml` parses it, once for each file, in one helper that each rule
   calls. A hand-written parser would fail on folded, block and quoted scalars.
7. **The gate venues follow ADR 002.**
   - lefthook runs `eslint` on the staged files that match the plugin's globs.
   - `--max-warnings 0` applies in both venues, as `--error-on-warnings` does for Biome. A `warn`
     rule is a gate in this repository. For another team, `warn` still means "does not break".
   - A new CI job, `eslint`, runs it over the repository, without `--cache`. Some rules read a
     second file, and the ESLint cache does not see a change to that file. The job becomes a
     required check only after it reports on `main` once.
   - The plugin source joins the named coverage set at 100 on all four buckets.
8. **ESLint lints only the Claude Code configuration files.** Biome keeps TypeScript, JSON format
   and its current rules. The two tools do not lint the same file for the same concern.
9. **How other organizations install the plugin is a later decision.** That decision covers the
   registry (npm or GitHub Packages), the version policy and the build. See the consequences.

## Consequences

- **One install covers every file type and every venue.** A team adds one package and its peer
  dependencies. It then gets the same rules in the editor, in a hook and in CI.
- **This repository runs two linters.** Biome and ESLint each have a config and an editor
  extension. The file globs keep them apart, but a contributor must install both extensions.
- **ESLint loads a TypeScript config through an unstable flag.** On node 22.18, ESLint reads
  `eslint.config.ts` with `--flag unstable_native_nodejs_ts_config`, without `jiti`
  ([configuration files](https://eslint.org/docs/latest/use/configure/configuration-files#typescript-configuration-files)).
  If ESLint removes the flag, the fallback is an `eslint.config.mjs` that imports the `.ts` plugin.
- **The later sharing decision must deviate from ADR 001.** Node does not strip types from a file
  under `node_modules`. So a published package must ship JavaScript, and that needs a build step.
  The sharing decision must record that deviation, or supersede this ADR.
- **Some current checks can move.** The frontmatter checks in `tests/repo/skills.test.ts` can move
  into lint rules one at a time. Each move is its own change, not a side effect of this ADR.
- **A rule can be wrong in a way a test cannot see.** Each rule gets fixtures that show it reports
  when it must and stays silent when it must not (`CLAUDE.md`, fixture quality). The fixtures come
  from real cases, such as #190, #191 and #222.
