---
type: ADR
description: A plugin directory, and the lib/ it links, holds only the files an installed plugin uses at run time. Tests, test helpers and fixtures live under tests/, flow diagrams under docs/flows/, and no directory in a plugin takes the name of a plugin component it is not. Repository tests enforce these rules.
status: stable
created: 2026-09-25
owner: brianespinosa
related_issues: [205]
---

# ADR 004: Plugins ship runtime files only

## Context

Claude Code copies a plugin's whole directory into the user's plugin cache at install. The
[plugin loading reference](https://code.claude.com/docs/en/plugins/loading) says: "Every other
marketplace plugin: Claude Code copies the plugin into `cache/<marketplace>/<plugin>/<version>/`
at install and loads that copy." The docs name no ignore file and no manifest field that leaves a
file out. Each plugin's `src/lib` symlink points at the root `lib/`, and the installer copies that
directory into the cache too (ADR 001).

Before this decision, the tests sat beside the code (RFC 001 decision 10, ADR 001). So each user
who installed the plugins got 35 plugin test files, 4 test helpers, 9 `lib/` test files, 110
fixture files and 8 flow diagrams. None of these files runs in an installed plugin. RFC 001
accepted this as inert weight.

A second problem is names. The plugin reference gives a meaning to directory names at a plugin's
root: `commands/`, `agents/`, `skills/`, `hooks/`, `output-styles/`, `workflows/`, `themes/`,
`monitors/`, `bin/` and `evals/` ("Standard layout"). The dispatcher targets lived in
`src/commands/`. Claude Code does not read that directory, but a reader sees a name with a plugin
meaning on a directory that is not that component.

## Decision

1. A plugin directory, and `lib/`, holds only what an installed plugin uses at run time. This
   supersedes RFC 001 decision 10 and the ADR 001 passage on co-located tests.
2. Every test lives under `tests/`:
   - `tests/plugins/<plugin>/` mirrors `plugins/<plugin>/src/`, with fixtures in
     `tests/plugins/<plugin>/fixtures/`;
   - `tests/lib/` and `tests/harness/` hold the tests of `lib/` and `harness/`;
   - `tests/repo/` holds the repository's own checks.
3. A test imports plugin code through the `imports` map in the root `package.json`:
   `#<plugin>/*` for `plugins/<plugin>/src/*`, `#harness/*` and `#lib/*`. Node, `tsc` (nodenext)
   and vitest all read this map, so there is one map. A plugin test reaches `lib/` as
   `#<plugin>/lib/...`, through the symlink, so it sees the same module as the plugin.
   `harness/paths.ts` names a plugin's scripts and hooks for a test that runs them as a process.
4. The flow diagrams move to `docs/flows/<plugin>/<skill>/`: `_skill-flow.md` for the skill, and
   one `<subcommand>-flow.md` for each dispatcher subcommand that the skill runs.
5. No directory in a plugin takes a component name unless it is that component at the plugin
   root. `src/commands/` becomes `src/subcommands/`. The seam keeps its recorded name, the command
   function (RFC 001 decision 3), so the ADR 001 and RFC 001 citations stay true.
6. `tests/repo/repo-layout.test.ts` enforces 1 and 5. It also keeps the map of 3 out of the
   shipped code:
   - `developmentFiles` refuses a test file, a test helper or a `fixtures/` directory under
     `plugins/` or `lib/`.
   - `packageImports` refuses a `#` import in a plugin or in `lib/`. An installed plugin has no
     `package.json` to resolve it.
   - `reservedDirectoryNames` refuses a component name below a plugin root, and a root
     `commands/`.
   - A symlink to a directory counts by its own name, because the installer copies it.

   `tests/repo/skills.test.ts` enforces 4. `.claude/rules/path-plugins.md` states the rules for a
   person who edits a plugin.

## Consequences

- The installed plugins are smaller, and a user gets no file that nothing loads.
- A test no longer sits beside its code. The mirror layout and the `#` aliases keep a test easy
  to find and its imports short.
- `crossPluginImports` no longer has a test-code exemption. No file in a plugin may import
  `harness/`.
- A subcommand that two skills run has a copy of its flow in each skill's flow directory,
  `docs/flows/<plugin>/<skill>/`. A test keeps the copies identical.
- The `*.test-support.ts` coverage exclusion from #205 went away: the support files are outside
  the measured set.
