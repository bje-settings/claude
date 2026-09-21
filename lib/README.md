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
`node:child_process` in `process.ts`; `node-floor.ts`, `envelope.ts` and `streams.ts` import
nothing at all, and `git.ts` and `gh.ts` reach node only through `process.ts`. Each
stays inside the erasable subset node's type stripping handles (no `enum`, no parameter
properties, no namespaces). Tests are co-located, and `lib/**/*.ts` is measured at 100 on lines,
branches, functions and statements, minus the test files and `fixtures/`.

`fixtures/` holds the tiny programs `process.test.ts` runs as real children: a child that sleeps,
one that starts a child of its own, one that exits before reading its stdin. They live here rather
than in `harness/fixtures/` because that directory has no equivalent of any of the three and was
outside the file set of the change that needed them. They are excluded from vitest and from
coverage, and still linted and type-checked.

| Module | What it gives a plugin |
| --- | --- |
| `node-floor.ts` | The Node 22.18 floor: `assertNodeFloor` for an entry point, `meetsNodeFloor` for a hook that must stay silent. Imports nothing. |
| `args.ts` | `parseArguments`, over `node:util`'s `parseArgs`: a declared option set in, an envelope out. |
| `envelope.ts` | What a command answers with, and the two renderers that turn an answer into stdout, stderr and an exit code. |
| `process.ts` | `run`: one child, no shell, with cwd, env, stdin and a time bound, and an answer that separates "could not start" from "ran and failed". |
| `git.ts` | The git calls the ported scripts make more than once, over `process.ts`. Not a git SDK. |
| `streams.ts` | Writers that go quiet on a broken pipe and on nothing else, and UTF-8 stdin. |
| `gh.ts` | `GhClient` and `createGhClient`: one method per operation, `gh` as the transport, failure as a thrown `GhError`. |

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

## Running a child

```ts
const result = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: root })
result.status // 0, or the package manager's own status, or 127 and 126 (below)
result.combined // both streams in arrival order, for a caller that wants one transcript
```

One child, no shell, and an answer rather than an exception: every ported call site already has a
branch for a child that failed, and none of them wants a `try` around the call. Three properties
are the reason this exists rather than `execFile`:

- **A bound that sticks.** `{ timeoutMs }` starts the child detached, so when the bound fires the
  whole process group is killed and not just the child this process holds. `gh pr checks --watch`
  polls in a loop and the sync fan-out starts a child per repository; killing the parent alone
  leaves those running against the network long after the caller gave up. `timedOut` says whether
  the bound fired, and `elapsedMs` says how long the child actually took, because a watcher that
  returned early did not wait the bound.
- **"Could not start" apart from "ran and failed."** `startFailure` carries node's code, and
  `status` carries the shell's convention for it: 127 for a command that is not there, 126 for one
  that is there and will not run. That is `lib/install.py`'s mapping, kept so a caller's one-line
  reason reads as it always did, and it is how a preflight tells "git is not on PATH" from "git is
  on PATH and still would not run".
- **No output ceiling.** `spawn` reads a pipe until it ends, so there is no `maxBuffer` to size and
  no truncated answer to mistake for a complete one.

`git.ts` sits on top of it with the calls the ported scripts make more than once: `gitOut` (stdout
without its trailing newlines, or `null` when git failed), `gitOk`, `gitLines`, `toplevel`,
`currentBranch`, `defaultBranch` and `hasRef`, plus `runGit` for the one preflight that needs
git's own words. `null` and `""` are different answers there and both are used: `show-ref --quiet`
succeeds with no output, and a `git status` that could not be run is not a clean tree.

## Writing to a reader that may have gone

```ts
const output = createOutput(process.stdout, process.stderr)
output.out.write(line) // silently dropped once the reader has gone away
```

`cmd | head` closes the pipe partway through a report. In node the failed write arrives as an
`error` event rather than as an exception at the call, so there is nothing to wrap in a `try`, and
with no listener node crashes with an internals stack trace. A writer goes quiet on EPIPE and the
run finishes normally, because by then the jobs have already run and abandoning the loop would
only lose the account of it. stdout and stderr are guarded independently, so a lost reader does
not take the channel a real failure still has to reach.

**Only EPIPE is swallowed.** Registering a listener at all silences node's default crash for every
code on that stream, so `ENOSPC` and `EIO` are re-thrown.

Two of `streams.py`'s three duties have no counterpart here, and `streams.test.ts` pins each
against a real child rather than asserting it in prose: node writes strings as UTF-8 whatever the
locale says, and node opens /dev/null over a stdio descriptor that was closed before it started.
`readStdinText` is the third duty, on the way in.

## The `gh` client

```ts
const gh = createGhClient({ repository: 'acme/widgets' }) // or { cwd } for a checkout
const merged = await gh.listMergedPullRequests({ base: 'main', limit: 200 })
```

The endpoints are named after the operation rather than after gh's argv, so the interface survives
gh changing a flag, and a command takes a `GhClient` as an argument rather than constructing one,
which is what makes it swappable for `createGhMock` in the harness (ADR 001, RFC 001 decision 3).
`repository` adds `--repo` to every call, for the commands that run from wherever the agent
started; `cwd` is for the ones that have already changed into the checkout.

Failure is a thrown `GhError` carrying gh's own words, never a result envelope and never an empty
list: "nothing matched" and "the answer could not be read" are different facts. The error carries
`status` (gh's exit status, or 127 and 126 when gh could not be started) and `cause` (the whole
run), so a caller branches on a value rather than on prose. Every member is public: `lib/` is
reachable under two paths through the `src/lib` symlink, and a `private` or `protected` member
would make the class nominal per declaration and the two identities no longer assignable.

`watchChecks` is the one blocking call and the one exception to "non-zero is a failure". It takes
a bound, and it answers with `{ status, timedOut, waitedMs, problem }` instead of throwing,
because the watch reports on the checks through its own exit status (1 a check failed, 8 still
pending) and 1 is also gh's generic failure. An endpoint that threw on 1 would report a red rollup
as a broken token. It carries no `--json` and returns no check list: gh refuses `--watch` with
`--json`, and the caller reads the rollup afterwards with `viewPullRequest`, which is what
`gh-shepherd-pr.py` does.

`createGhClient` takes the process runner as an option, which is the seam this directory's own
suite substitutes so that every endpoint and every arm of every failure are exercised in-process,
with nothing spawned and no `gh` on the machine.

## Decisions not taken

Recorded rather than fixed, each with the condition that reopens it. `lib/` gets what has a user
now (round 5 ruling 2, round 6 ruling 4): a fix written before anything calls it is the argument
RFC 001 decision 3 records against this whole directory.

- **`OptionSpec` admits `choices` on a boolean, and an empty `choices`.** The union's boolean arm
  does not declare `choices`, but TypeScript's excess property check accepts a property that any
  member of the union declares, so `{ type: 'boolean', choices: [...] }` type-checks and the
  parser ignores it; `choices: []` infers `never` and refuses every value. Neither is reachable
  from a spec any command writes today. **Reopens when** a command declares a boolean option with
  `choices`, or builds a `choices` list from a value rather than writing it out, at which point
  the spec has to refuse both at the call site rather than at the first command line.
- **The floor comparison's patch term is unpinned.** `compareTriples` compares patch, and
  `NODE_FLOOR` is 22.18.**0**, so every candidate patch compares greater or equal and no test can
  tell a correct patch comparison from one that ignores patch entirely. **Reopens when** the floor
  moves to a release with a non-zero patch (a 22.18.1 that fixes type stripping, say), which is
  the first time the term decides an answer; the comparison then needs its own example either way.

## Running

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run lib                         # this directory alone
pnpm exec tsc -p tsconfig.json                   # types
pnpm exec biome ci . --error-on-warnings         # lint and format
```
