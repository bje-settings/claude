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

**The Python this directory ports was deleted at #127.** `plugins/gh/scripts/*.py`, its `lib/`,
and `plugins/gh/hooks/hook-io.py` are gone from the tree; the file and line references below are
to what they held at `cd0d515`, kept because each says where a rule came from. Nothing here
changed with the deletion.

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
// plugins/<plugin>/bin/<plugin>.ts
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

`parseArguments` refuses a positional by design: nothing in front of it takes one, so a stray word
on the command line is far more often a quoting mistake than a request. `parseCommandLine(argv,
spec)` is the same core with `allowPositionals: true`, for the one command that widens itself
rather than inheriting an untested path (`plugins/audit`'s `/audit:context`, #170, names issue
numbers on the command line). It answers `Envelope<{ options; positionals: readonly string[] }>`;
`parseArguments` stays the no-positionals wrapper so every other caller, including
`plugins/mermaid/src/commands/url.ts`, is untouched.

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
- **A pipe that failed is reported, not swallowed.** All three of the child's pipes carry the same
  listener, and `streamErrors` holds every error that was not a broken pipe. A broken pipe is the
  reader leaving; anything else means the bytes in hand may be fewer than the bytes written, and a
  child handed half its stdin still exits 0. `gh.ts` turns a non-empty list into a `GhError`;
  `git.ts` folds it into `null` like every other failure and says so, because it calls `run`
  directly and a branch it could not reach is not a branch this repository writes.

`git.ts` sits on top of it with the calls the ported scripts make more than once: `gitOut` (stdout
without its trailing newlines, or `null` when git failed), `gitOk`, `gitLines`, `toplevel`,
`currentBranch`, `defaultBranch` and `hasRef`, plus `runGit` for the one preflight that needs
git's own words. `null` and `""` are different answers there and both are used: `show-ref --quiet`
succeeds with no output, and a `git status` that could not be run is not a clean tree.

The three that answer with a NAME (`toplevel`, `currentBranch`, `defaultBranch`) fold `""` into
`null`, because a checkout root, the branch HEAD is on and the ref `origin/HEAD` points at are each
a name or nothing, and the Python reads all three that way. A git that exits 0 and prints nothing
is not a real git's behaviour for those questions, but it is the behaviour of a git a caller put on
PATH, which is the only git these helpers have. `gitOut`, `gitOk`, `gitLines`, `hasRef` and
`runGit` do not fold, for the reason in the paragraph above.

The four that ask about one repository (`toplevel`, `currentBranch`, `defaultBranch`, `hasRef`)
take a required `cwd` **and** a required `env`, because `GIT_DIR` outranks both `cwd` and
`git -C` for everything the git directory holds: with it set, git reads that repository's HEAD,
its `origin/HEAD` and its refs whatever directory the call named. (`toplevel` is the exception:
`GIT_DIR` with no `GIT_WORK_TREE` makes the current directory the top of the work tree, so
`--show-toplevel` still answers about `cwd`, and `GIT_WORK_TREE` is what displaces that one.) git
exports `GIT_DIR` and `GIT_INDEX_FILE` into every child of a hook, and a pre-commit hook is one of
the places this suite runs, so the environment is named at the call rather than left to whatever
the process inherited.

Requiring it buys the naming and not the scrubbing: `env: process.env` satisfies the type and
inside a hook carries `GIT_DIR` at full strength. Nothing in `git.ts` strips anything, and it
cannot, because it calls `run` directly and has no seam. Pass `process.env` when there is nothing
to pin, which is what every ported call site inherits today; a caller that must be insulated builds
an environment without the `GIT_*` keys, the way `harness/sandbox.ts` does for the suite. The
scrubbing helper is below, under "Decisions not taken".

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
code on that stream, so `ENOSPC` and `EIO` are re-thrown. `streamFailures` is that rule as one
exported pure function, so the writer here and the three child pipes in `process.ts` decide it the
same way: it answers with the account of the error, zero entries for a broken pipe and one for
everything else, which is what lets `process.ts` attach it with no arm a real child cannot reach.

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
`repository` names the repository on every call, for the commands that run from wherever the agent
started; `cwd` is for the ones that have already changed into the checkout, and `env` is for a
caller with an environment to pin, because `GH_REPO` displaces `cwd` the way `GIT_DIR` does. Left
out, the child inherits this process's, which is what every ported call site gets today. It reaches gh as
`--repo` everywhere except `gh repo view`, which has no such flag and takes the repository as its
positional argument, which is why the two `repo view` calls in the Python are the only ones that
pass no `--repo`.

Failure is a thrown `GhError` carrying gh's own words, never a result envelope and never an empty
list: "nothing matched" and "the answer could not be read" are different facts. The error carries
`status` (gh's exit status, or 127 and 126 when gh could not be started), `cause` (the whole
run) and `detail`, so a caller branches on a value rather than on prose. `detail` is gh's own
account WITHOUT the `gh <argv> failed: ` prefix the message carries, and it is the field a command
quotes in a one-line reason: the ordinary refusal is a single line of stderr
("gh: API rate limit exceeded"), so tailing `message` would put the whole argv inside the report. Every member is public: `lib/` is
reachable under two paths through the `src/lib` symlink, and a `private` or `protected` member
would make the class nominal per declaration and the two identities no longer assignable.

Three inputs are required where an optional one would re-admit a defect the layer exists to close:
`watchChecks`'s `boundMs` (round 5's handoff fact 1), `listMergedPullRequests`'s `limit` (omitted,
gh substitutes 30 and the caller has no number to judge saturation against, so a truncated window
reads as a complete answer) and `updateBranch`'s `rebase` (omitted, gh writes a merge commit onto
someone's head branch). Every ported call site already passes all three, so nothing is being asked
for that a caller does not have. The two remaining `limit` filters stay optional because neither
consumer measures its window.

`watchChecks` is the one blocking call and the one exception to "non-zero is a failure". Its
bound is required rather than optional, because an optional one is #154's unbounded watch a line
away and `process.ts` detaches only a bounded child, so an unbounded watch could not be
group-killed either. It answers with `{ status, timedOut, waitedMs, problem }` instead of throwing,
because the watch reports on the checks through its own exit status (1 a check failed, 8 still
pending) and 1 is also gh's generic failure. An endpoint that threw on 1 would report a red rollup
as a broken token. It carries no `--json` and returns no check list: gh refuses `--watch` with
`--json`, and the caller reads the rollup afterwards with `viewPullRequest`, which is what
`gh-shepherd-pr.py` does.

`createGhClient` takes the process runner as an option, which is the seam this directory's own
suite substitutes so that every endpoint and every arm of every failure are exercised in-process,
with nothing spawned and no `gh` on the machine.

### `issueStates`

```ts
const { states, unavailable } = await gh.issueStates({ numbers: [138, 164] })
// states: { '138': 'OPEN', '164': 'not_found' }
```

Tier 0 of the context audit (#164/#170): every number's state, resolved through one or more `gh
api graphql` calls in place of a `gh issue view` or `gh pr view` per number. Owner and name come
from `viewRepository()` rather than a second `gh repo view --json owner,name` call, splitting its
`nameWithOwner` field on `/`; `REPOSITORY_FIELDS` already carries it. Numbers are batched at 100
per call (`ISSUE_BATCH`), each with its own aliases starting again from `i0`: GitHub rejects a
GraphQL query by node count and complexity rather than by a fixed alias count, and 100 `state`
fields are far below either.

**Never throws.** A failure to resolve the repository, to reach `gh` at all, or to read what it
printed goes into `unavailable` rather than rejecting, because the one consumer reports on many
numbers at once and a single bad chunk must not cost every other answer. `gh api graphql` exits 1
on a partial body that is still an answer (one bad alias fails the whole call), so this endpoint
reads the body through `invoke`, never `succeeded`, whatever the exit status; a body with no
`data.repository` to align aliases against is `unavailable`, with `accountOf(result)` as the
reason, the same account every other failure in this file reads.

**The one rule that took two review rounds on the spike (#164) to get right, pinned first in this
port's suite:** an alias is `not_found` only when `errors` carries an entry of type `NOT_FOUND`
whose `path` ends in that alias. Any other null or missing alias with an accompanying error, such
as a `FORBIDDEN`, a rate limit, or a timeout, which carries no `path` at all, is left out of
`states` entirely, with its message folded into `unavailable`, never reported as "this issue does
not exist": that is a finding fabricated out of a failure to ask. A `NOT_FOUND` on a named alias is
a complete answer about that number, so it is not also counted toward `unavailable`. A number whose
alias resolves to neither a recognised state nor a `NOT_FOUND` error (the reply answered something
this endpoint does not read as a state, or left the alias out with no error alongside it) is also
left out of `states`, and, with no error to fold in, out of `unavailable` too: the caller reads a
number missing from both the same way the spike's own suite pins it (`refs.test.ts`, "leaves an
unrecognised state out"), as unresolved rather than as a third, distinct outcome.

Ported from the spike's `buildIssueQuery`, `parseIssueResponse` and `parseIssueChunkBody` as
private helpers, adapted rather than copied: the spike's own endpoint never threw either, but it
called `execFileSync` directly and parsed what THAT threw (`parseIssueChunkFailure`); here the
endpoint takes the argv through the injected `Runner` seam every other endpoint uses, which answers
rather than rejects, so there is no caught error to parse a second way.

### `listMilestones`, `listIssues` and `listOpenPullRequests`

```ts
const milestones = await gh.listMilestones()
const issues = await gh.listIssues({ milestone: '4' })
// issues.rows[0].blockedBy -> [{ number: 127, state: 'CLOSED' }]
```

The sweep's three reads (#130): the open milestones with their open and closed issue counts, open
issues with their labels, their `blockedBy` and `blocking` relationships and the pull requests
that would close them, and every open pull request with its head and base. Each answers
`{ rows, unavailable }`, the {@link PagedResult} shape `issueStates` established, and none of them
throws: a sweep asks about several milestones, and one page that could not be read must not cost
every other answer.

GraphQL rather than REST, because `blockedBy` and `blocking` are issue dependencies and exist in
GraphQL alone. Owner, name, cursor and milestone are GraphQL VARIABLES rather than text spliced
into the query the way `issueStates` builds its aliases: an alias has to be text because a
variable cannot name a field, a cursor is an opaque server string that has no business inside a
query body, and one query string per endpoint means the argv is the same bytes on every page,
which is what lets a captured reply be replayed against the argv that asked for it.

`listOpenPullRequests` is its own endpoint rather than a wider `listPullRequests`, whose field
list carries neither `headRefName` nor `baseRefName`: widening that list would change what every
existing consumer is handed for a question none of them asked.

Three ways an answer can be short, each reported through `unavailable` rather than by throwing or
by silence:

- **A row that is not the shape the query asked for** is counted, never dropped quietly, and a
  `blockedBy` or `blocking` connection with one unreadable entry makes the WHOLE issue unreadable.
  A blocker list one entry short is a blocked issue reported as unblocked, which is the one
  mistake a sweep must not make. A `blockedBy` or `blocking` answered at exactly the 100 the query
  asks for is unreadable on the same grounds: those connections carry no page signal, so a
  complete list and the first page of a longer one arrive identical, and the conservative reading
  is the only safe one. `blocking` is in that rule because it is what a caller reads to say which
  issues a round unlocks, so a short list under-claims rather than misclassifies. `labels` and the
  closing pull requests are reported without anything being concluded from their length, so they
  are kept. The refused rows are one count with one reason, which says they could not be read
  rather than naming which of the two causes refused each: both are rows this read will not
  report, and a reason that claimed the shape was wrong would send a reader after a parser that
  is not broken.
- **A page that wants a successor but names no cursor** ends the read and says so. Asking again
  with the cursor already used asks the same question forever, and a truncated set handed over
  without a reason reads as a complete one.
- **More than 20 pages** ends the read and says so. That is 2,000 rows in one repository, far past
  anything a round sweeps, and a `hasNextPage` that never goes false is a loop this process would
  not leave.

`milestoneNumber: "none"` is NOT the query for the issues on no milestone: verified against the
API on 2026-09-21, it matches nothing rather than matching the unassigned. A caller reads that set
from an unfiltered `listIssues()` by filtering on `milestone === null`.

## Decisions not taken

Recorded rather than fixed, each with the condition that reopens it. `lib/` gets what has a user
now (round 5 ruling 2, round 6 ruling 4): a fix written before anything calls it is the argument
RFC 001 decision 3 records against this whole directory.

- **No helper builds an environment with the `GIT_*` and `GH_*` keys removed.** `RepoOptions`
  requires an `env` and `GhClientOptions` accepts one, and both document that naming an environment
  is not the same as scrubbing it. The only worked scrub in the tree is `harness/sandbox.ts`, which
  is test code and does not ship, and no Python call site scrubs anything: every one of them
  inherits. A helper written here would be a typed function with no caller, which is the argument
  RFC 001 decision 3 records against this directory. **Reopens at** the `hook-io.py` port (#127
  layer 4), which is the first consumer that genuinely must not answer about the hook's own
  `GIT_DIR`, and which is therefore where such a helper earns its place and its tests.

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
