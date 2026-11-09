---
type: ADR
description: A function-hooks plugin keeps its hooks module in hooks/register.ts or register.tsx, and its pure logic in src/*.ts. A second tsconfig, a root script for claude plugin test, and a pinned declaration file cover what the root gates cannot reach. The ADR lists the rules a hooks module does not follow.
status: stable
created: 2026-11-07
owner: brianespinosa
related_issues: [392, 400, 401, 488]
---

# ADR 007: Function-hooks plugins in this marketplace

This ADR adds to [ADR 001](001-typescript-on-node-22-18.md), [ADR 004](004-plugins-ship-runtime-files-only.md)
and [ADR 006](006-plugins-hold-copies-of-lib.md). It does not supersede them. It names the rules
that a hooks module does not follow.

## Context

A function-hooks plugin has one hooks module. `hooks/hooks.json` names it under `modules`, and it
exports `register(on, options)`. The Claude Code engine runs it. The module has "no DOM and no
Node". Every file it imports from the plugin ends in `.ts`, `.tsx` or a similar suffix
(`plugin-authoring` skill, `reference.md`).

Spike #392 ran two such modules against the gates of this repository. Five rules broke:

- The command function and the dispatcher (`.claude/rules/type-ts.md`). A module has no
  `scripts/<plugin>.ts` and no subcommand.
- Tests outside the plugin (ADR 004). `claude plugin test` runs only the `*.test.ts` and
  `*.test.tsx` files in the plugin folder. `developmentFiles` in `tests/repo/repo.ts:333` refuses
  a `*.test.ts` file there, and does not refuse a `*.test.tsx` file. `vitest` cannot load a module, because `claude-code` exists only in the
  engine.
- The coverage source set. `vitest.config.ts:67-73` names `plugins/*/src/**/*.ts` and four other
  roots. A file in `plugins/<plugin>/hooks/` is outside it.
- The root `tsconfig.json`. It sets `"types": ["node"]` (line 32) and has no `jsx` option. The
  first JSX element fails the `types` job.
- The CI pin. `plugin-validate.yml:26` pins `CLAUDE_CODE_VERSION` to 2.1.263. That version
  refused `session.end` as "not an event", and 2.1.289 accepted it.

More than one answer exists for each rule. A test folder in the plugin, or a test exemption, would
ship test files to each user. A module with only type imports loads under node, but has nothing
to call. A `.tsx` file may import a `src/lib/` copy, if `scripts/sync-lib.ts` reads `.tsx` files
too.

Four node adapters sit in `plugins/*/hooks/` today: `plugins/gh/hooks/hook-io.ts`,
`plugins/shepherd/hooks/session-start.ts`, `plugins/workstreams/hooks/guard.ts` and
`plugins/workstreams/hooks/session-start.ts`. `plugins/*/hooks` is in the root `include`
(`tsconfig.json:60`). A change to the root config must keep these four in the `types` job.

## Decision

1. **Layout.** The hooks module is `plugins/<plugin>/hooks/register.ts` or `register.tsx`.
   `hooks/hooks.json` names it under `modules`. A plugin that reads `$.state` has
   `types/index.d.ts` for the keys. A surface module goes beside the hooks module. Pure logic
   goes in `plugins/<plugin>/src/*.ts`, and no such file imports `claude-code`.
2. **Coverage.** The pure functions in `src/` stay in the vitest source set at 100. The hooks
   module and the surface modules are outside it, by path and by extension. They stay thin, so
   little logic goes untested. The Code Coverage ruleset of the enterprise does not see them.
3. **Tests.** ADR 004 stands. Tests of a hooks module live in `tests/plugins/<plugin>/`. A root
   script copies the plugin and those tests to a temporary folder. It runs `claude plugin test`
   there and exits with the status of that run. These tests are named `*.test.tsx`. Vitest
   collects only `tests/**/*.test.ts` (`vitest.config.ts:44`), so it does not load them.
4. **Types.** The root `tsconfig.json` keeps `plugins/*/hooks`, so the four node adapters stay
   type-checked. It excludes `plugins/*/hooks/register.*` and the hooks-module tests, because
   the root `include` has `tests` (`tsconfig.json:54`). A second file, `tsconfig.hooks.json`,
   sets `jsx: "react"`, `jsxFactory: "h"` and `jsxFragmentFactory: "Fragment"`. It covers
   `plugins/*/hooks/register.*`, those tests, `plugins/*/types` and a committed copy of the engine
   declarations in `types/claude-code/`. A test in `tests/repo/` checks that the first line of
   that copy names the version in `CLAUDE_CODE_VERSION`. The `types` job runs both configs.
5. **CI pin.** The pull request that adds a hooks module moves `CLAUDE_CODE_VERSION` in
   `.github/workflows/plugin-validate.yml` to the version the plugin targets. A new event that
   the plugin hooks can need a later move.
6. **Imports.** A hooks module imports no file that imports a `node:` module, because the engine
   runs it with no Node. It imports no `src/lib/` copy directly. `scripts/sync-lib.ts:68` reads
   only `.ts` files. So a `.tsx` file that imports a copy would leave that copy out of the sync. Pure
   logic that needs `lib/` goes in `src/*.ts`, which the script reads. One rule serves both
   `.ts` and `.tsx` modules.
7. **A plugin with a command hook and a hooks module.** The dependency check stays a
   `SessionStart` command hook, with `systemMessage` and `additionalContext`
   (`.claude/rules/_design-principles.md`, "Dependencies outside a plugin"). The command hook
   does only that check. The hooks module does the other work. A plugin with only a hooks module
   does its dependency check in a `session.start` function hook.

A hooks module does not follow these rules:

- The command function and the dispatcher (`.claude/rules/type-ts.md`). The entry is
  `register(on, options)`.
- `${CLAUDE_PLUGIN_DATA}`. It is undefined in a module (#391). The module uses `$.store`.
- The `SessionStart` command hook, except as ruling 7 says.
- The output fields in `.claude/rules/path-hooks.md`. A module speaks through `$.ui.toast`,
  `$.ui.log`, `$.ui.status` and `$.session.append`.
- "run directly by node on a 22.18 floor" (`CLAUDE.md`, "Plugin marketplace"). The engine runs the module, and it may be `.tsx`.

## Consequences

- **#401 adds the gates.** It adds `tsconfig.hooks.json`, `types/claude-code/index.d.ts`, the
  root script, the `plugin-test` job and the pin at 2.1.319. `reservedDirectoryNames` needs no
  change for `types/`, because `RESERVED_DIRECTORIES` does not list it (`tests/repo/repo.ts:396-407`).
- **#488 is the first hooks module.** It adds `plugins/gh/hooks/register.ts` and applies ruling 7
  to the gh plugin.
- **The module name is a convention.** The root `exclude` matches `register.*`. A hooks module
  with another name would reach the root `types` job, so a test must hold the name.
- **A hooks module has no coverage gate.** Review must check that the module holds no logic
  that a `src/` function could hold.
- **A new plugin domain is not necessary.** The marketplace installs a function-hooks plugin
  as it installs any other plugin.
- **Open: the runtime load of `modules` with command `hooks` in one file.** On Claude Code
  2.1.319, a probe plugin had `"modules"` and a `hooks.SessionStart` command entry in one
  `hooks/hooks.json`. `claude plugin validate --strict` gave `Validation passed`, exit 0. No session loaded the probe, so the runtime load
  is not confirmed. #488 must confirm it before ruling 7 is relied on.
- **Open: a symlink out of the plugin.** ADR 006 removed the symlink. A hooks module never
  imports a copy (ruling 6), so the question does not arise.
