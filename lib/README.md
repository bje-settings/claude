# lib

The code shared between plugins. One copy at the repository root, reached from a plugin through a
committed symlink at `plugins/<plugin>/src/lib -> ../../../lib` (ADR 001, RFC 001 decision 4).

Claude Code's [plugins reference](https://code.claude.com/docs/en/plugins-reference) classifies a
symlink three ways when it installs a plugin: one whose target is inside the plugin is preserved,
one whose target is elsewhere in the same marketplace is dereferenced into the cache copy, and one
pointing outside the marketplace is skipped. This link is the middle case, so an installed plugin
carries a real copy of these files and needs nothing at run time the marketplace did not ship. That
is also why the link target is compared as the exact string `../../../lib` by
`tests/repo-layout.test.ts` rather than resolved: a different spelling that happens to resolve here
installs differently.

Everything here **ships**. Each file imports nothing outside this directory, takes no dependency,
and stays inside the erasable subset node's type stripping handles (no `enum`, no parameter
properties, no namespaces). Tests are co-located, and `lib/**/*.ts` is measured at 100 on lines,
branches, functions and statements, minus the test files.

| Module | What it gives a plugin |
| --- | --- |
| `node-floor.ts` | The Node 22.18 floor: `assertNodeFloor` for an entry point, `meetsNodeFloor` for a hook that must stay silent. Imports nothing. |
| `args.ts` | `parseArguments`, over `node:util`'s `parseArgs`: a declared option set in, an envelope out. |
| `envelope.ts` | What a command answers with, and the two renderers that turn an answer into stdout, stderr and an exit code. |
| `gh.ts` | `GhClient` and `createGhClient`: one method per operation, `gh` as the transport, failure as a thrown `Error`. |

## The floor guard is the one static import

```ts
// plugins/<plugin>/bin/<command>.ts
import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { run } = await import('../src/run.ts')
process.exitCode = run(process.argv.slice(2))
```

`import` declarations are hoisted and evaluated before any statement in the file runs, so a second
static import would load its whole module graph on the runtime the guard exists to refuse, and the
sentence a user should have read would be a syntax error from inside a dependency instead.
`node-floor.ts` imports nothing, and everything else is reached by `await import` after the check.

A hook takes the other half: it runs on every tool call in a session, so it asks `meetsNodeFloor`
and exits quietly rather than writing a refusal into someone's transcript (ADR 001).

## Arguments and the envelope

```ts
const parsed = parseArguments(argv, {
  route: { type: 'string', default: 'view', choices: ['edit', 'view'] },
  theme: { type: 'string', default: 'default' },
})
if (parsed.outcome !== 'ok') return parsed // exit 2, the reason on stderr
```

Every declared option carries a default, so a parsed command line is never partial and no command
grows a fallback branch for a flag nobody passed. A bad flag, a missing value, a stray positional
or a value outside `choices` all come back as `refused`, which is exit 2: the status Python's
`argparse` already uses, so a caller branching on it keeps branching on it.

Three outcomes, because the scripts being ported have three:

| Outcome | Status | Means |
| --- | --- | --- |
| `ok` | 0 | The payload is the answer. |
| `failed` | 1 | This code went wrong. |
| `refused` | 2 | The request cannot be carried out as asked, and the reason says why. |

`renderJson` writes the payload as one line of JSON; `renderText` writes a payload that is already
the text to print. Both write **nothing** to stdout on a failure and the reason to stderr, so a
caller parsing stdout can never parse a refusal into a result. Neither adds the trailing newline;
the entry point does.

## The `gh` client

```ts
const gh = createGhClient() // or createGhClient({ cwd }) for a repository elsewhere
const merged = await gh.listPullRequests({ state: 'merged', base: 'main' })
```

The endpoints are named after the operation rather than after gh's argv, so the interface survives
gh changing a flag, and a command takes a `GhClient` as an argument rather than constructing one,
which is what makes it swappable for `createGhMock` in the harness (ADR 001, RFC 001 decision 3).
Failure is a thrown `Error` carrying gh's own words, never a result envelope and never an empty
list: "nothing matched" and "the answer could not be read" are different facts.

`createGhClient` takes node's `execFile` as an option, which is the seam this directory's own suite
substitutes so that every endpoint and the adapter itself are exercised in-process, with nothing
spawned and no `gh` on the machine. It is not a general process runner: the root lib's process
runner and its git helpers arrive with [#127](https://github.com/bje-settings/claude/issues/127),
their first consumer.

## Running

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run lib                         # this directory alone
pnpm exec tsc -p tsconfig.json                   # types
pnpm exec biome ci . --error-on-warnings         # lint and format
```
