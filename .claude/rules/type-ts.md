---
paths:
  - "lib/**/*.ts"
  - "harness/**/*.ts"
  - "plugins/**/*.ts"
  - "scripts/**/*.ts"
  - "tests/**/*.ts"
---

# Plugin TypeScript

New plugin code is TypeScript, executed directly by node with type stripping and no build step.
The floor is node 22.18. `.npmrc` pins the 22.x release pnpm runs by default.
`docs/rfc/001-typescript-port.md` is the record ("Shape", "The testing seam", the sixteen
decisions). `docs/adr/001-typescript-on-node-22-18.md` covers the runtime and the shared `lib/`.
`docs/adr/002-quality-gate-venues.md` covers where each gate runs. This page is the rules.

## Shape

```
lib/                           # shared across plugins; the only thing that crosses a boundary
plugins/<plugin>/
  scripts/<plugin>.ts          # thin adapter: one dispatcher, one arm per command
  src/
    lib -> ../../../lib        # committed symlink
    subcommands/<command>.ts   # one exported function per subcommand: the seam
  hooks/*.ts
tests/plugins/<plugin>/        # mirrors plugins/<plugin>/src/; outside the plugin, so never shipped
  subcommands/<command>.test.ts
  fixtures/
```

## The command function is the seam

Parsed arguments and injected clients in, an envelope out. Everything a command decides is then
reachable in-process, with nothing spawned and no stub binary on `PATH`.

`lib/envelope.ts` has three outcomes, and they are the exit statuses. `ok` is 0, and the payload
is the answer. `failed` is 1, and it means this code went wrong. `refused` is 2, and it means the
request cannot be carried out as asked.

A failure writes nothing to stdout, and it writes the reason to stderr. So a caller that parses
stdout can never read a refusal as a result. `renderJson` and `renderText` turn an envelope into
stdout, stderr, and a status. The entry point writes the trailing newline.

Arguments come from `lib/args.ts` `parseArguments`. Every declared string option carries a
default. So a parsed command line is never partial, and no command grows a branch for a flag
nobody passed. A bad flag, an absent value, a stray positional, or a value outside `choices` is
`refused`, exit 2. `lib/README.md` has the worked examples and the rest of the contract.

## `scripts/` is an adapter

It turns `process.argv` into the command function's arguments. It constructs the real clients,
calls the command, and maps the result onto an exit code and a stream. It holds no decisions,
which is what lets one spawned contract test per plugin (`harness/spawn.ts` `runScript`) cover
all of it.

The directory is `scripts/`, never `bin/`. claude.ai rejects a plugin that carries a top-level
`bin/`, by marketplace sync and by direct upload alike. So a plugin with one cannot reach
organization settings at all
([plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces#keep-executables-out-of-the-top-level-bin-directory)).
While the plugin is enabled, the Bash tool also adds `bin/` to its own `PATH`. Nothing here wants
that. RFC 001 decision 16. `tests/repo/repo-layout.test.ts` refuses a plugin that carries one
(`binDirectories`), because nothing else here goes red when it comes back.

One dispatcher serves each plugin, with an arm per command. So the plugin carries one floor
guard, one EPIPE guard, and one contract test (RFC 001 decision 15). The import inside each arm
is dynamic, so a command nobody asked for is never loaded.

It carries exactly one static import, `../src/lib/node-floor.ts`. It calls
`assertNodeFloor(process.version)`, and reaches everything else by `await import`, after the
check. The JS engine hoists and evaluates import declarations before any statement runs. So a
second static import would load its whole module graph, on the runtime the guard exists to
refuse.

A hook takes the other half. It runs on every tool call in a session. So it asks
`meetsNodeFloor`, and exits quietly, rather than write a refusal into someone's transcript.

## Tests

- A test lives under `tests/`, at the mirror of the code it covers: `tests/lib/args.test.ts` for
  `lib/args.ts`, `tests/plugins/<p>/subcommands/<command>.test.ts` for
  `plugins/<p>/src/subcommands/<command>.ts`. Fixtures go in `tests/plugins/<p>/fixtures/`.
  `.claude/rules/path-plugins.md` says why nothing test-only goes in a plugin.
- A test imports plugin code as `#<p>/...` and the harness as `#harness/...`, from the `imports`
  map in the root `package.json`. A plugin test reaches `lib/` as `#<p>/lib/...`, through the
  plugin's symlink, so it sees the same module the plugin sees.
- The shared harness is `harness/` at the repository root. `harness/README.md` has the rest of
  the test side.
- A slow test file can be in parts, `<command>.<part>.test.ts`, so that vitest runs the parts at
  the same time. The helpers of the parts go in `<command>.test-support.ts` beside them, so the
  parts share one copy of each helper.
- `gh` is an injected `GhClient`: `lib/gh.ts` `createGhClient` in production, `harness/gh.ts`
  `createGhMock` in tests, never a stub binary on `PATH`. An endpoint with no registration throws
  and names itself. This is the property a stub binary cannot give. A command that reached for
  `gh`, where the test expected no call, fails instead. It does not read an empty reply as an
  answer.
- git is not mocked. `harness/git.ts` builds real temporary repositories, with real local bare
  origins. So fetch, merge, ancestry, and worktree operations behave as they do in production.
- No call-count, call-order, or request-log assertions. Assert the verdict the command reached,
  and the effect it had. If you count calls instead, that pins an implementation detail, and it
  turns a refactor red.

## Boundaries

- The committed symlink `plugins/<p>/src/lib -> ../../../lib` is the only path out of a plugin.
  A `#` import is not a path out either: the installed plugin cannot resolve it.
  `tests/repo/repo-layout.test.ts` enforces this (`crossPluginImports`, `libLinkViolations`,
  `packageImports`).
- The link target is compared as the exact string `../../../lib`, not resolved to a path. This
  string is what Claude Code's installer classifies. A link elsewhere in the same marketplace is
  dereferenced into the cache copy. But another spelling that resolves here installs differently.
- Never reach the root `lib/` around the link. A `../../../lib` import from a plugin file
  resolves in this checkout only. It does not resolve for anyone who installed the plugin, so it
  is refused.
- Shipped code takes no dependency: node's own built-ins and its own tree, nothing else at run
  time.
- No plugin-level `package.json`. Claude Code runs a dependency install inside the cache copy,
  when it finds one with an npm or bun lockfile. That turns a plugin install into a network
  fetch, on someone else's machine. Dependencies are declared once, at the repository root.

## Language level

Erasable syntax only: no `enum`, no parameter properties, no namespaces. Node strips types,
rather than compile them, and rejects all three at launch with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. `erasableSyntaxOnly` in `tsconfig.json` turns that into a
failed gate on a pull request instead. Every import names the `.ts` extension explicitly, which
is what node's own resolver reads.

## Coverage

`vitest.config.ts`'s thresholds are the gate: 100 on lines, branches, functions, and statements.
This runs over a source set that is named, not discovered.

The gate does not move to fit the code. Do not lower a threshold. Do not add a name to
`coverage.exclude`, even for a file you judge a process boundary or a platform branch. The remedy
for a branch no test can reach is to restructure the code until the branch no longer exists. Lift
the decision into a function that takes, as an argument, what it depended on.

`docs/adr/002-quality-gate-venues.md` describes exclusion by name with a stated reason, as the
relief valve. To open it is a maintainer decision, argued on its own pull request. It is never a
step in the change you make.
