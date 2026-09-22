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
The floor is node 22.18; `.npmrc` pins the 22.x release pnpm runs by default.
`docs/rfc/001-typescript-port.md` is the record ("Shape", "The testing seam", the fourteen
decisions), with `docs/adr/001-typescript-on-node-22-18.md` for the runtime and the shared `lib/`
and `docs/adr/002-quality-gate-venues.md` for where each gate runs. This page is the rules.

## Shape

```
lib/                           # shared across plugins; the only thing that crosses a boundary
plugins/<plugin>/
  bin/<plugin>.ts              # thin adapter: one dispatcher, one arm per command
  src/
    lib -> ../../../lib        # committed symlink
    commands/<command>.ts      # one exported function per command: the seam
    commands/<command>.test.ts # co-located with the code it covers
    fixtures/                  # for the tests under commands/
  hooks/*.ts
```

## The command function is the seam

Parsed arguments and injected clients in, an envelope out. Everything a command decides is then
reachable in-process, with nothing spawned and no stub binary on `PATH`.

`lib/envelope.ts` has three outcomes and they are the exit statuses: `ok` is 0 and the payload is
the answer, `failed` is 1 and means this code went wrong, `refused` is 2 and means the request
cannot be carried out as asked. A failure writes nothing to stdout and the reason to stderr, so a
caller parsing stdout can never parse a refusal into a result. `renderJson` and `renderText` turn
an envelope into stdout, stderr and a status; the entry point writes the trailing newline.

Arguments come from `lib/args.ts` `parseArguments`. Every declared string option carries a default,
so a parsed command line is never partial and no command grows a branch for a flag nobody passed.
A bad flag, a missing value, a stray positional or a value outside `choices` is `refused`, exit 2.
`lib/README.md` has the worked examples and the rest of the contract.

## `bin/` is an adapter

It turns `process.argv` into the command function's arguments, constructs the real clients, calls,
and maps the result onto an exit code and a stream. It holds no decisions, which is what lets one
spawned contract test per plugin (`harness/spawn.ts` `runScript`) cover all of it.

One dispatcher per plugin, with an arm per command, so the plugin carries one floor guard, one
EPIPE guard and one contract test (RFC 001 decision 15). The import inside each arm is dynamic, so
a command nobody asked for is never loaded.

It carries exactly one static import, `../src/lib/node-floor.ts`, calls
`assertNodeFloor(process.version)`, and reaches everything else by `await import` after the check.
Import declarations are hoisted and evaluated before any statement runs, so a second static import
would load its whole module graph on the runtime the guard exists to refuse.

A hook takes the other half: it runs on every tool call in a session, so it asks `meetsNodeFloor`
and exits quietly rather than writing a refusal into someone's transcript.

## Tests

- A test sits beside the code it covers: `lib/args.test.ts` next to `lib/args.ts`,
  `plugins/<p>/src/commands/<command>.test.ts` next to the command, with that plugin's fixtures at
  `plugins/<p>/src/fixtures/`. `vitest.config.ts` names the collected globs rather than discovering
  them, so a new source directory is added there deliberately. The shared harness is `harness/` at
  the repository root, imported only from test files so it never ships (`harness/README.md`, which
  has the rest of the test side).
- `gh` is an injected `GhClient`: `lib/gh.ts` `createGhClient` in production, `harness/gh.ts`
  `createGhMock` in tests, never a stub binary on `PATH`. An endpoint with no registration throws
  and names itself, which is the property a stub binary cannot give: a command that reached for
  `gh` where the test expected no call fails instead of reading an empty reply as an answer.
- git is not mocked. `harness/git.ts` builds real temporary repositories with real local bare
  origins, so fetch, merge, ancestry and worktree operations behave as they do in production.
- No call-count, call-order or request-log assertions. Assert the verdict the command reached and
  the effect it had; counting calls pins an implementation detail and turns a refactor red.

## Boundaries

- The committed symlink `plugins/<p>/src/lib -> ../../../lib` is the only path out of a plugin. A
  test file may additionally import `harness/`. `tests/repo-layout.test.ts` enforces both
  (`crossPluginImports`, `libLinkViolations`).
- The link target is compared as the exact string `../../../lib` rather than resolved, because the
  string is what Claude Code's installer classifies: a link elsewhere in the same marketplace is
  dereferenced into the cache copy, and another spelling that resolves here installs differently.
- Never reach the root `lib/` around the link. A `../../../lib` import from a plugin file
  resolves in this checkout and for nobody who installed the plugin, so it is refused.
- Shipped code takes no dependency: node's own built-ins and its own tree, nothing else at run
  time.
- No plugin-level `package.json`. Claude Code runs a dependency install inside the cache copy when
  it finds one with an npm or bun lockfile, which turns installing a plugin into a network fetch on
  someone else's machine. Dependencies are declared once, at the repository root.

## Language level

Erasable syntax only: no `enum`, no parameter properties, no namespaces. Node strips types rather
than compiling them and rejects all three at launch with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`;
`erasableSyntaxOnly` in `tsconfig.json` turns that into a failed gate on a pull request instead.
Every import names the `.ts` extension explicitly, which is what node's own resolver reads.

## Coverage

`vitest.config.ts`'s thresholds are the gate: 100 on lines, branches, functions and statements,
over a source set that is named rather than discovered.

The gate does not move to fit the code. Do not lower a threshold, and do not add a name to
`coverage.exclude`, including for a file you judge to be a process boundary or a platform branch.
The remedy for a branch no test can reach is to restructure until the branch does not exist: lift
the decision into a function that takes what it depended on as an argument.

`docs/adr/002-quality-gate-venues.md` describes exclusion by name with a stated reason as the
relief valve. Opening it is a maintainer decision argued on its own pull request, never a step in
the change you are making.
