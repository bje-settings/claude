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

Everything here **ships**. Each file takes no dependency and imports nothing outside this
directory but node's own built-ins, which today is `node:util` in `args.ts` and
`node:child_process` in `gh.ts`; `node-floor.ts` and `envelope.ts` import nothing at all. Each
stays inside the erasable subset node's type stripping handles (no `enum`, no parameter
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

An option that declares `choices` parses to those choices as a type rather than to a bare
`string`, so a command reads `parsed.value.route` without re-proving what the parser already
refused. A spec is written inline or `as const`: annotating it `: ArgSpec`, or writing
`satisfies ArgSpec`, widens the literals and throws that away, and the annotated form is refused
at the call site rather than silently answering with an index signature. A default outside its
own option's choices is `failed` and not `refused`: it is this code's mistake, and it would
otherwise refuse every command line that left the flag off while naming a flag the caller never
typed. The defaults are audited before the command line is parsed, so a broken spec is reported
whatever the caller typed.

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

`watchChecks` runs `gh` twice, because gh refuses `--watch` together with `--json` and refuses
`--interval` without `--watch`: the watch blocks, and the read that follows is what the caller is
answered with. The watch's exit status is an answer there (1 a check failed, 8 still pending)
rather than a failure, which is `gh-shepherd-pr.py`'s `WATCHER_CODES` without that script's own
bound. 1 is also gh's generic non-zero, so a genuine failure at the watch is caught by the read
repeating it rather than by the watch itself. Nothing bounds the watch yet, and neither the
watch's status nor the failure's `code` reaches a caller; both land with the command that needs
them (#127).

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
