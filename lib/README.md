# lib

This directory holds the code shared between plugins. One copy lives at the repository root. A
plugin reaches it through a committed symlink at `plugins/<plugin>/src/lib -> ../../../lib`
(ADR 001, RFC 001 decision 4).

The Claude Code [plugins reference](https://code.claude.com/docs/en/plugins-reference) sorts a
symlink into three groups when it installs a plugin. A symlink with a target inside the plugin
stays as a symlink. A symlink with a target elsewhere in the same marketplace turns into a real
file in the cache copy. A symlink with a target outside the marketplace does not install at all.

This link is the second case. An installed plugin holds a real copy of these files. It needs
nothing at run time that the marketplace did not ship. The test `tests/repo/repo-layout.test.ts` checks
the link target as the exact string `../../../lib`, not as a resolved path. A different spelling of
the target could resolve to the same place. It could still install a different way.

**The Python code this directory ports was deleted at #127.** `plugins/gh/scripts/*.py`, its
`lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree. The file and line references
below point to what they held at `cd0d515`. Each reference stays because it says where a rule came
from. Nothing here changed with the deletion.

Everything here **ships**. Each file takes no dependency. Each file imports nothing outside this
directory except node's own built-in modules. Today that means `node:util` in `args.ts` and
`node:child_process` in `process.ts`. `node-floor.ts`, `dependencies.ts`, `hook-output.ts`,
`envelope.ts`, and `streams.ts` import nothing at all. `git.ts` and `gh.ts` reach node only
through `process.ts`.

Each file stays inside the erasable subset that node's type stripping handles: no `enum`, no
parameter properties, and no namespaces. The tests live in `tests/lib/`, not here, because every
plugin ships this directory through its `src/lib` symlink (ADR 004). `lib/**/*.ts` is measured at
100 percent on lines, branches, functions, and statements.

`tests/lib/fixtures/` holds the tiny programs that `tests/lib/process.test.ts` runs as real child
processes. One child sleeps. One child starts a child process of its own. One child exits before
it reads its stdin. Vitest and the coverage report skip these programs. Biome and `tsc` still
check them.

| Module | What it gives a plugin |
| --- | --- |
| `node-floor.ts` | The Node 22.18 floor. `assertNodeFloor` checks it for an entry point. `meetsNodeFloor` checks it for a hook that must stay silent. `belowFloorMessage` is the line a `SessionStart` hook writes instead, since it runs once. Imports nothing. |
| `dependencies.ts` | `absentDependencies`. One pure function over a plugin's declared table and a lookup, so no plugin keeps its own copy of the check (`.claude/rules/_design-principles.md`). |
| `hook-output.ts` | `emit` and `colour`, for a `SessionStart` hook's `systemMessage` and, when given one, `hookSpecificOutput.additionalContext`. The plugin prefix is a parameter, so more than one hook uses it. |
| `args.ts` | `parseArguments`, built on `node:util`'s `parseArgs`. It takes a declared option set. It returns an envelope. |
| `envelope.ts` | The answer a command gives back. Two renderers turn that answer into stdout, stderr, and an exit code. `failedOnThrow` turns a throw at an entry point into one stderr line and exit 1. |
| `process.ts` | `run`. It starts one child process, with no shell, with a cwd, an env, stdin, and a time bound. Its answer tells apart "could not start" from "ran and failed". |
| `git.ts` | The git calls the ported scripts make more than once, built on `process.ts`. Not a full git SDK. |
| `streams.ts` | Writers that go quiet only on a broken pipe. Also UTF-8 stdin. |
| `gh.ts` | `GhClient` and `createGhClient`. One method exists per operation. `gh` is the transport. A failure throws a `GhError`. |
| `typesafe.ts` | `createJev`. The generic ask/usage transport for TypeSafe's System One endpoint. It retries, backs off, and redacts. A failure throws a `JevError`. |
| `jev.ts` | `JevClient` and `createJevClient`. The audit's five judgment questions, built on `typesafe.ts`. Includes request batches and answer parsers. |

## The floor guard is the one static import

```ts
// plugins/<plugin>/scripts/<plugin>.ts
import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { run } = await import('../src/run.ts')
process.exitCode = run(process.argv.slice(2))
```

`import` declarations are hoisted. Node evaluates them before any statement in the file runs. A
second static import would load its whole module graph on the runtime the guard exists to refuse.
The user would then see a syntax error from inside a dependency, not the refusal sentence they
should read. `node-floor.ts` imports nothing. Everything else loads through `await import`, after
the check runs.

A hook takes the other half of this rule. It runs on every tool call in a session. It asks
`meetsNodeFloor` instead, and exits quietly. It does not write a refusal into someone's transcript
(ADR 001).

## Arguments and the envelope

```ts
const parsed = parseArguments(argv, {
  route: { type: 'string', default: 'view', choices: ['edit', 'view'] },
  theme: { type: 'string', default: 'default' },
})
if (parsed.outcome !== 'ok') return parsed // exit 2, the reason on stderr
```

`parseArguments` refuses a positional argument by design. No command today takes one. A stray word
on the command line is far more often a mistake in quoting than a real request.

`parseCommandLine(argv, spec)` is the same core, but with `allowPositionals: true`. It exists for
the one command that widens itself on purpose. That command is `plugins/audit`'s `/audit:context`
(#172, RFC 001), which takes the root it audits as a positional argument rather than inherit an
untested path. `parseCommandLine` answers with `Envelope<{ options; positionals: readonly
string[] }>`. `parseArguments` stays the no-positionals wrapper, so every other caller, including
`plugins/mermaid/src/subcommands/url.ts`, stays untouched.

Every declared option carries a default. So a parsed command line is never partial, and no command
needs a fallback branch for a flag nobody passed. A bad flag, a missing value, a stray positional
argument, or a value outside `choices`, all come back as `refused`. That is exit 2, the same status
Python's `argparse` already uses. A caller already set up to branch on that status needs no change.

An option that declares `choices` parses to those choices as a type, not to a bare `string`. A
command reads `parsed.value.route` without a proof of what the parser already refused.

Write a spec inline, or with `as const`. A spec annotated `: ArgSpec`, or written with `satisfies
ArgSpec`, widens the literal choices away and throws that narrowing out. Written the wrong way,
`tsc` refuses the spec at the call site itself. It does not silently answer with a plain index
signature instead.

A default outside its own option's choices is `failed`, not `refused`. That default is this code's
own mistake. A `refused` default would refuse every command line that left the flag off, even one
that named no bad flag at all. The defaults are checked before the command line is parsed, so a
broken spec is reported whatever the caller typed.

Three outcomes, because the scripts this file ports have three:

| Outcome | Status | Means |
| --- | --- | --- |
| `ok` | 0 | The payload is the answer. |
| `failed` | 1 | This code went wrong. |
| `refused` | 2 | The request cannot be carried out as asked. The reason says why. |

`renderJson` writes the payload as one line of JSON. `renderText` writes a payload that is already
the text to print. On a failure, both write **nothing** to stdout, and write the reason to stderr.
A caller that parses stdout can never read a refusal as a result. Neither renderer adds the
trailing newline. The entry point adds it.

## Running a child

```ts
const result = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: root })
result.status // 0, or the package manager's own status, or 127 and 126 (below)
result.combined // both streams in arrival order, for a caller that wants one transcript
```

`run` starts one child process, with no shell, and gives back an answer, not an exception. Every
ported call site already has a branch for a child that failed. None of them wants a `try` block
around the call. Three properties are why this exists instead of `execFile`:

- **A bound that stays.** `{ timeoutMs }` starts the child detached. When the bound fires, `run`
  kills the whole process group, not just the one child this process holds. `gh pr checks --watch`
  polls in a loop, and the sync fan-out starts one child per repository. A kill of only the parent
  would leave those children active on the network long after the caller gave up. `timedOut`
  says whether the bound fired. `elapsedMs` says how long the child actually took, because a
  watcher that returned early did not wait for the full bound.
- **"Could not start" apart from "ran and failed."** `startFailure` carries node's own error code.
  `status` carries the shell's convention for the same fact: 127 for a command that is not there,
  126 for one that is there but will not run. That mapping comes from `lib/install.py`, kept so a
  caller's one-line reason reads the way it always did. It is also how a preflight check tells
  "git is not on PATH" apart from "git is on PATH and still will not run".
- **No output ceiling.** `spawn` reads a pipe until it ends. There is no `maxBuffer` to size, and
  no truncated answer to mistake for a complete one.
- **A pipe that failed is reported, never swallowed.** All three of the child's pipes carry the
  same listener. `streamErrors` holds every error that was not a broken pipe. A broken pipe means
  only that the reader left. Any other error means the bytes in hand may be fewer than the bytes
  the child wrote, and a child handed half its stdin still exits 0. `gh.ts` turns a non-empty
  `streamErrors` list into a `GhError`. `git.ts` folds it into `null`, like every other failure,
  and reports it that way: `git.ts` calls `run` directly, and this repository does not write a
  branch that no test can reach.

`git.ts` sits on top of `run` with the git calls the ported scripts make more than once: `gitOut`
(stdout without its trailing newlines, or `null` when git failed), `gitOk`, `gitLines`, `toplevel`,
`currentBranch`, `defaultBranch`, and `hasRef`. It also has `runGit`, for the one preflight check
that needs git's own words. `null` and `""` are different answers here, and both occur:
`show-ref --quiet` succeeds with no output at all, and a `git status` that could not run is not the
same as a clean tree.

Three helpers answer with a NAME: `toplevel`, `currentBranch`, and `defaultBranch`. Each folds `""`
into `null`, because a checkout root, the branch HEAD sits on, and the ref `origin/HEAD` points at,
are each either a name or nothing. The Python reads all three that way. A real git does not exit 0
and print nothing for these questions, but a git the caller put on PATH might, and that is the only
git these helpers have. `gitOut`, `gitOk`, `gitLines`, `hasRef`, and `runGit` do not fold their
answers, for the reason given above.

Four helpers ask about one repository: `toplevel`, `currentBranch`, `defaultBranch`, and `hasRef`.
Each takes a required `cwd` **and** a required `env`. `GIT_DIR` outranks both `cwd` and `git -C`
for everything the git directory holds. With `GIT_DIR` set, git reads that repository's HEAD, its
`origin/HEAD`, and its refs, whatever directory the call named. `toplevel` is the exception:
`GIT_DIR` with no `GIT_WORK_TREE` makes the current directory the top of the work tree, so
`--show-toplevel` still answers about `cwd`. `GIT_WORK_TREE` is the variable that displaces
`toplevel`'s answer instead.

git exports `GIT_DIR` and `GIT_INDEX_FILE` into every child of a hook. A pre-commit hook is one of
the places this suite runs. So the environment is named at each call, rather than left to whatever
the process inherited.

A required `env` buys only the naming, not the scrubbing. `env: process.env` satisfies the type, and
inside a hook it still carries `GIT_DIR` at full strength. Nothing in `git.ts` strips anything. It
cannot: `git.ts` calls `run` directly and has no seam for that.

Pass `process.env` when there is nothing to pin, which is what every ported call site does today.
A caller that must be insulated builds an environment with the `GIT_*` keys removed, the way
`harness/sandbox.ts` does for the suite. The section "Decisions not taken", below, covers the
scrubbing helper.

## Writing to a reader that may have gone

```ts
const output = createOutput(process.stdout, process.stderr)
output.out.write(line) // silently dropped once the reader has gone away
```

`cmd | head` closes the pipe partway through a report. In node, the failed write arrives as an
`error` event, not as an exception at the call site. There is nothing to wrap in a `try` block, and
with no listener node crashes with an internal stack trace. A writer here goes quiet on EPIPE, and
the run finishes normally. By then the jobs have already run, and to stop the loop would only lose
the account of them. stdout and stderr are guarded independently, so a lost reader on one does not
block the channel a real failure still needs to reach.

**Only EPIPE is swallowed.** A listener registered at all silences node's default crash for every
code on that stream, so this file re-throws `ENOSPC` and `EIO`. `streamFailures` holds that rule as
one exported pure function, so the writer here and the three child pipes in `process.ts` decide it
the same way. It answers with the account of the error: zero entries for a broken pipe, one entry
for everything else. That is what lets `process.ts` attach the same function with no arm a real
child cannot reach.

Two of `streams.py`'s three duties have no counterpart here. `tests/lib/streams.test.ts` pins each against a
real child, rather than assert it in prose: node writes strings as UTF-8 whatever the locale
says, and node opens `/dev/null` over a stdio descriptor that was closed before the process
started. `readStdinText` is the third duty, on the way in.

## The `gh` client

```ts
const gh = createGhClient({ repository: 'acme/widgets' }) // or { cwd } for a checkout
const merged = await gh.listMergedPullRequests({ base: 'main', limit: 200 })
```

The endpoints are named after the operation, not after gh's own argv, so the interface still works
when gh changes a flag. A command takes a `GhClient` as an argument, rather than build one itself. That is
what makes `createGhMock`, in the harness, swappable in for it (ADR 001, RFC 001 decision 3).

`repository` names the repository on every call, for commands that run from wherever the agent
started. `cwd` is for commands that have already changed into the checkout. `env` is for a caller
with an environment to pin, because `GH_REPO` displaces `cwd` the way `GIT_DIR` does. Left out, the
child inherits this process's own environment, which is what every ported call site gets today.

`createGhClient` reaches gh as `--repo` everywhere except `gh repo view`. That command has no
`--repo` flag, and takes the repository as its positional argument instead. That is why the two
`repo view` calls in the Python code are the only two of the ten that pass no `--repo`.

Failure is a thrown `GhError` that carries gh's own words. It is never a result envelope, and never
an empty list: "nothing matched" and "the answer could not be read" are different facts. The error
carries `status` (gh's exit status, or 127 and 126 when gh could not start), `cause` (the whole
run), and `detail`. A caller branches on one of these values, not on prose.

`detail` is gh's own account, WITHOUT the `gh <argv> failed: ` prefix the full message carries. A
command quotes `detail`, not `message`, in a one-line reason. The ordinary refusal is a single line
of stderr ("gh: API rate limit exceeded"), so tailing `message` would put the whole argv inside the
report.

Every member of `GhError` is public. `lib/` is reachable under two paths, through the `src/lib`
symlink. A `private` or `protected` member would make the class nominal per declaration, and the
two identities would no longer be assignable to each other.

Three inputs are required, where an optional one would let back in a defect this layer exists to
close. `watchChecks`'s `boundMs` is one (round 5's handoff fact 1). `listMergedPullRequests`'s
`limit` is another: left out, gh substitutes 30, and the caller has no number to judge saturation
against, so a truncated window reads as a complete answer. `updateBranch`'s `rebase` is the third:
left out, gh writes a merge commit onto someone's head branch. Every ported call site already
passes all three, so nothing here asks a caller for something it does not have. The two remaining
`limit` filters stay optional, because neither consumer measures its own window.

`watchChecks` is the one blocking call, and the one exception to "a non-zero status is a failure".
Its bound is required, not optional: an optional bound is #154's unbounded watch, one line away,
and `process.ts` detaches only a bounded child, so an unbounded watch could not even be
group-killed. It answers with `{ status, timedOut, waitedMs, problem }`, and does not throw,
because the watch reports on the checks through its own exit status: 1 means a check failed, 8
means still pending. 1 is also gh's generic failure code, so an endpoint that threw on 1 would
report a red rollup as a broken token.

`watchChecks` carries no `--json`, and returns no check list. gh refuses `--watch` together with
`--json`. The caller reads the rollup afterwards with `viewPullRequest`, which is what
`gh-shepherd-pr.py` does.

`createGhClient` takes the process runner as an option. That option is the seam this directory's
own test suite substitutes. Through it, the suite exercises every endpoint, and every arm of every
failure, in-process, with nothing spawned and no `gh` on the machine.

### `issueStates`

```ts
const { states, unavailable } = await gh.issueStates({ numbers: [138, 164] })
// states: { '138': 'OPEN', '164': 'not_found' }
```

This is tier 0 of the context audit (#164/#170): every number's state, resolved through one or more
`gh api graphql` calls, in place of a `gh issue view` or `gh pr view` call per number. Owner and
name come from `viewRepository()`, not from a second `gh repo view --json owner,name` call.
`issueStates` splits `viewRepository()`'s `nameWithOwner` field on `/`; `REPOSITORY_FIELDS` already
carries that field. Numbers are batched at 100 per call (`ISSUE_BATCH`), each batch with its own
aliases, which start again from `i0`. GitHub rejects a GraphQL query by node count and complexity, not
by a fixed alias count, and 100 `state` fields sit far below either limit.

**Never throws.** A failure to resolve the repository, to reach `gh` at all, or to read what gh
printed, goes into `unavailable`, and never rejects the call. The one consumer reports on many
numbers at once, and a single bad chunk must not cost every other answer. `gh api graphql` exits 1
on a partial body that is still an answer, because one bad alias fails the whole call. So this
endpoint reads the body through `invoke`, never `succeeded`, whatever the exit status. A body with
no `data.repository` to align aliases against is `unavailable`, with `accountOf(result)` as the
reason, the same account every other failure in this file reads.

**One rule took two review rounds on the spike (#164) to get right, and this port's suite pins it
first:** an alias is `not_found` only when `errors` carries an entry of type `NOT_FOUND` whose
`path` ends in that alias.

Any other null or missing alias with an error beside it, such as a `FORBIDDEN`, a rate limit, or a
timeout, is left out of `states` entirely. A timeout carries no `path` at all. Each such error's
message folds into `unavailable` instead. `issueStates` never reports these as "this issue does not
exist": that report would be a finding invented out of a failure to ask.

A `NOT_FOUND` error on a named alias is a complete answer about that number. So it does not also
count toward `unavailable`.

A number's alias can also resolve to neither a recognised state nor a `NOT_FOUND` error. That
happens when the reply answers with something this endpoint does not read as a state, or leaves the
alias out with no error alongside it. Such a number is left out of `states` too, and, with no error
to fold in, out of `unavailable` as well. The caller reads a number missing from both sets the same
way the spike's own suite pins it (`refs.test.ts`, "leaves an unrecognised state out"): as
unresolved, not as a third, distinct outcome.

This endpoint ports the spike's `buildIssueQuery`, `parseIssueResponse`, and `parseIssueChunkBody`
as private helpers, adapted rather than copied. The spike's own endpoint never threw either, but it
called `execFileSync` directly and parsed what THAT call threw (`parseIssueChunkFailure`). Here,
the endpoint takes the argv through the injected `Runner` seam every other endpoint uses. That seam
answers, rather than rejects, so there is no caught error to parse a second way.

### `repositoryStatus`

```ts
const { repositories, unavailable } = await gh.repositoryStatus(['acme/widgets'], { boundMs: 4_000 })
// repositories['acme/widgets'] -> { alerts: 1, dependencies: 2, mergedPullRequests: [...] }
```

This is the GitHub half of the gh plugin's SessionStart status line (#230). It reads three
fields for each `owner/name`: the open Dependabot alerts, and the open pull requests that
Dependabot opened. The third field is the heads of the last 100 merged pull requests. Like
`issueStates`, it sends one aliased `gh api graphql` query. `issueStates` has one alias per
number. This endpoint has one alias per repository (`r0`, `r1`, and so on).

`Repository.pullRequests` cannot filter by author. So the Dependabot count reads the authors of
the first 100 open pull requests, and it is `null` when there are more. A search can filter by
author, but it gives 0 for a renamed or transferred repository. One failed search also makes
the whole reply's `data` null.

One query names five repositories at most (`STATUS_BATCH`). Each repository asks for 100 pull
request rows, so a small batch stays far below GitHub's node limit. The batches go at the same
time, so the small batch costs no time. Each call stops at `boundMs`, through the runner's
`timeoutMs`, which kills the whole process group.

**Never throws.** A failure costs only what it touches:

- Some failures cost all the repositories of a batch. These are a body that cannot be read, a gh
  that did not start, a pipe that failed, and a call past its bound. The reason goes into
  `unavailable`. The other batches keep their answers.
- A repository that GitHub could not resolve is left out of `repositories`. Its error message goes
  into `unavailable`.
- A field that is not the shape the query asked for is `null`, and the other fields stay. A token
  that cannot read Dependabot alerts gets `null` there, and an entry in `errors`. gh then exits 1,
  and the body is still an answer. So this endpoint reads the body whatever the exit status, the
  same as `issueStates`.
- One merged pull request row that is not the shape asked for makes the whole list `null`. A list
  one row short could hide the row that proves a squash merge.

Owner and name go into the query as text. `JSON.stringify` writes each one as a GraphQL string. The hook's URL parser lets only letters, digits, `-`, `_` and `.` into a name, so no
name can end the quoted string.

### `listMilestones`, `listIssues` and `listOpenPullRequests`

```ts
const milestones = await gh.listMilestones()
const issues = await gh.listIssues({ milestone: '4' })
// issues.rows[0].blockedBy -> [{ number: 127, state: 'CLOSED' }]
```

These are the sweep's three reads (#130). `listMilestones` reads the open milestones, with their
open and closed issue counts. `listIssues` reads open issues, with their labels, their `blockedBy`
and `blocking` relationships, and the pull requests that would close them. `listOpenPullRequests`
reads every open pull request, with its head and base. Each answers `{ rows, unavailable }`, the
{@link PagedResult} shape `issueStates` established, and none of them throws. A sweep asks about
several milestones at once, and one page that could not be read must not cost every other answer.

These three endpoints use GraphQL, not REST, because `blockedBy` and `blocking` are issue
dependencies, and they exist in GraphQL alone. Owner, name, cursor, and milestone arrive as GraphQL
VARIABLES, not as text spliced into the query, unlike the aliases `issueStates` builds. An alias
has to be text, because a variable cannot name a field. A cursor is an opaque server string that
has no business inside a query body. One query string per endpoint also means the argv gh receives
is the same bytes on every page, which lets a captured reply be replayed against the argv that
asked for it.

`listOpenPullRequests` is its own endpoint, not a wider `listPullRequests`. That other endpoint's
field list carries neither `headRefName` nor `baseRefName`. A wider list would change what every
consumer that already uses it receives, for a question none of them asked.

An answer can be short in three ways. Each way is reported through `unavailable`, never by a thrown
error and never by silence.

- **A row that is not the shape the query asked for** is counted, never dropped in silence. A
  `blockedBy` or `blocking` connection with one unreadable entry makes the WHOLE issue unreadable.
  A blocker list that is one entry short would report a blocked issue as unblocked. That is the one
  mistake a sweep must not make.

  A `blockedBy` or `blocking` connection answered at exactly the 100 the query asks for is also
  unreadable, on the same grounds. Those connections carry no page signal, so a complete list and
  the first page of a longer one look the same, and the conservative reading is the only safe one.
  `blocking` is in this rule because a caller reads it to find which issues a round unlocks, so a
  short list here would under-claim, not misclassify. `labels` and the closing pull requests are
  reported with nothing concluded from their length, so they stay as read.

  The refused rows are one count with one reason: that they could not be read. The reason does not
  name which of the two causes refused each row. Both are rows this read will not report, and a
  reason that claimed the shape was wrong would send a reader after a parser that is not broken.
- **A page that wants a successor but names no cursor** ends the read, and says so. A second ask
  with the same cursor would ask the same question forever. A truncated set handed over with no
  reason would read as a complete one.
- **More than 20 pages** ends the read, and says so. That is 2,000 rows in one repository, far past
  anything a round sweeps. A `hasNextPage` field that never turns false is a loop this process must
  not stay in.

`milestoneNumber: "none"` is NOT the query for issues on no milestone. Verified against the API on
2026-09-21: that filter matches nothing, not the unassigned issues. A caller reads that set from an
unfiltered `listIssues()` call, and a filter on `milestone === null`.

### `listOpenPullRequestHeads`

```ts
const heads = await gh.listOpenPullRequestHeads()
// heads.rows[0] -> { number, title, head, headSha, base, draft, checks }
```

Every open pull request, with the full oid of its head commit and the checks on that commit. One
paginated GraphQL read answers it all. The `watch` subcommand makes this read once for each poll,
and `intersect` makes it once for each run. So one poll is one view of every head at one time. It
is not one read for each pull request.

It is its own endpoint, not a wider `listOpenPullRequests` (round 10 ruling P8). The sweep's
acceptance test replays that endpoint by its exact argv, the query text included. A wider query
would break the replay. It would also change what the sweep gets, for a question the sweep does
not ask.

A check list longer than the 100 the query asks for makes its row unreadable. `unavailable` counts
it with the other rows that could not be read. A check list cut short could leave out the one
required context that failed. A watch would then conclude a head that did not pass.

### `requiredContexts`, `viewPullRequestDetail` and `listWorkflowRuns`

```ts
const { contexts } = await gh.requiredContexts({ branch: 'main' })
const { pullRequest } = await gh.viewPullRequestDetail({ pullRequest: 178 })
const runs = await gh.listWorkflowRuns({ branch: 'wktr-133-ws-review' })
```

These are the review loop's three reads (#133). Each answers with its rows or its record beside an
`unavailable` sentence, and none of them throws, for the same reason as the sweep reads. The loop
reads all three on every tick. One that could not be read must cost only its own fact, and nothing
else.

`requiredContexts` uses REST (`repos/{owner}/{name}/rules/branches/{branch}`), because GraphQL
exposes no equivalent. It asks PER BRANCH, not per repository, which is the whole point of it.
Verified against this repository on 2026-09-22: `main` must pass nine contexts, while
`wktr-130-ws-sweep`, a topic branch of the kind every stack layer is based on, must pass none. A
caller that read the default branch's list would report the wrong answer for exactly the pull
requests a stack is made of. An EMPTY list is therefore an answer, not a failure.

`requiredContexts` unions the contexts of every `required_status_checks` rule. One rule that could
not be read costs the whole answer, not just its own context, because a required context dropped in
silence is a pull request reported green that the ruleset would in fact refuse.

`viewPullRequestDetail` makes one GraphQL round trip for the refs, the head commit and its check
rollup, the unresolved review threads, and the comments. It is not `viewPullRequest`: that
endpoint's `--json` field list carries neither ref name, and cannot carry review threads at all,
since thread resolution exists in GraphQL alone. A check run and a commit status are read into one
`CheckContext` shape (`name`/`status`/`conclusion` against `context`/`state`), told apart by which
fields answered, not by `__typename`. A commit status has no status of its own, and its `PENDING`
and `EXPECTED` states are carried as NO conclusion, because both mean the check has not concluded,
and `CheckContext` promises null for that case. A reader that matched conclusions against the set
that satisfies a required check would otherwise call a preview deployment that is still in
progress a failure.

The threads and the comments are separate fields, because they are separate facts: the enterprise
coverage bot posts a COMMENT on every pull request here. All three connections ask for `pageInfo`,
unlike the dependency connections in the sweep query. A list at the page ceiling here says so
through `unavailable`, rather than refused outright, because here there is a real page signal
to read.

`unresolvedThreads` carries one `{ author, bot }` row per unresolved thread. `bot` says
whether that thread's first comment came from a bot account, read straight from
`__typename`. This is not like a check run and a commit status, told apart by which fields
answered. GraphQL names the type here, so the parse reads it directly. An author GitHub no
longer names gives `bot: false`, the safe side. `workstreams pr-state` then holds the loop
at `fixing` only for a thread from a person, and names a bot's apart.

`viewPullRequestDetail` also answers `missing`. This is true only when GraphQL names the pull
request field itself NOT_FOUND. The check reads the error's own `path`, the same way
`notFoundAlias` reads it for `issueStates`, over many numbers at once. Verified live against this
repository on 2026-09-25. `gh api graphql` for pull request 99999 answers a null node beside a
NOT_FOUND error whose path ends at `pullRequest`. gh then exits 1.

Every other reason leaves `missing` false. A NOT_FOUND for a field nested under the pull request
is one such reason. A null node with no error, a malformed reply, an unresolved repository, and a
refused read are four more. A caller must not read a failed read, or an unrelated nested one, as
proof the number is gone.

`listWorkflowRuns` uses REST (`actions/runs`), because `listRuns` asks `gh run list` for a field
list that carries neither `event` nor the head commit. So a caller cannot tell a `pull_request` run
from a `push` run, nor say which head either ran on. `listWorkflowRuns` filters with `?branch=`,
never `?head_sha=`: that filter once answered nothing for a head whose runs did exist, and cost a
close-and-reopen and a whole CI run.

A row that is not the shape REST promises is counted into `unavailable`, never dropped. A caller
that asserts a run exists for a head would otherwise read a dropped row as "no run".
`listWorkflowRuns` reads ONE page, newest first, bounded by `perPage`, and does not claim to be the
whole list. This repository held 1,733 runs when that was measured, and every caller wants the
recent ones, not all of them. Ask this endpoint only what the newest page can answer.

## The TypeSafe transport and the Jev client

```ts
const jev = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY ?? '' })
const { classifications, failures } = await jev.classify(units, 'per_unit')
```

Two files port the context-audit spike (#164, `spike/context-audit/jev.ts` and `questions.ts`).
They split the way `lib/process.ts` and `lib/gh.ts` split. `typesafe.ts` is the generic
`POST /v1/systemone` transport: `ask(state, questions)` and `usage()`, retried and redacted, with
no idea what a question is *about*. `jev.ts` is the audit's own client, built on `typesafe.ts`,
that knows the five judgment questions and their answers.

Nothing outside these two files needs to know the split exists. `jev.ts` re-exports `AnswerBag`,
`Entry`, and `TypeSafeOptions` from `typesafe.ts`, so a caller reaches both files through one
import.

**`typesafe.ts`.** `createJev(options)` takes `apiKey`, and, for a test, every other knob that
could otherwise sit in a branch nothing could steer: `fetch`, `sleep`, `random`, and `timeoutMs`.

A 429, a 529, or one of the proxy-layer 5xx codes (500, 502, 503, 504), is retried with full-jitter
backoff (`backoffMs`), capped at 30 seconds before jitter. A server-stated `Retry-After` header,
given in seconds or as an HTTP date (`retryAfterMs`), wins over the computed backoff. That header
value is itself capped at 120 seconds, since that number is the server's own choice, not this
code's. A timeout abort (`AbortSignal.timeout`) is a transport failure, and is retried the same way
a network error is.

A malformed 2xx body, and a 2xx body that fails to read, are each a non-retryable `JevError` that
carries the real status. In both cases, the request was already billed and answered, just not the
way the contract promises, so a resend of it would only bill it again.

`requests` counts logical calls, one per `ask`. `attempts` counts every HTTP attempt, including
retries. The two counts stay separate, because a call retried twice is one request and three
attempts.

`typesafe.ts` redacts the API key, both bare and as `Bearer <key>`, from every string it attaches
to a thrown `JevError`. That covers a server's error body, a foreign `Error#message` that happens
to echo a request header, and a malformed body that happens to contain the key. `JevError` carries
`status` (0 for a transport failure that never got a response) and `body`. Like `GhError`, it has no
private member: `tsc` sees a class exported from `lib/` under two identities, its real path and
`plugins/<p>/src/lib/typesafe.ts` through the committed symlink, and a `private` or `protected`
field would make the two identities no longer assignable to each other.

**`jev.ts`.** `JevClient` wraps `typesafe.ts`'s `ask` with the five per-unit judgments (`kind`,
`volatile`, `self_contained`, `evidence`, `multi_assertion`), the pair check, and the evidence
check. It sends these in either of two request shapes: `per_unit` sends one request per unit;
`per_section` sends one request per heading path, batched against a token budget
(`batchSections`).

The instructions and criteria for all seven questions are copied VERBATIM from the spike's
`questions.ts`. They were tuned against the live model. Every measurement the spike made depends on
the wording, which must stay exactly as it is. That includes the measurement that Jev has no
question-count limit of its own, and refuses first on the 64k token budget, with HTTP 400
`max_tokens_exceeded`. A
pull request that touches this prose is reviewed as a rubric change, not as a refactor.

`lib/` cannot import a plugin, so the `Unit` type these methods take is not
`plugins/audit/src/types.ts`'s `Unit`. `JevUnit` is the minimal structural shape the client actually
reads off a unit: `id`, `file`, `headingPath`, `leadIn`, `prev`, `next`, `text`, and
`refs: { value: string }[]`. The plugin's richer `Unit` satisfies `JevUnit` structurally, with no
import in either direction.

`judgePair` and `judgeEvidence` answer with the bare `ChoiceAnswer`, not the spike's `PairJudgment`
or `EvidenceJudgment`. Those wrapper types carry a candidate's ids and similarity, or a unit's
source and excerpt: facts the plugin already has. The plugin attaches the verdict to that context
itself; that step is its own job.

`classify`'s failure rule ports the spike's `cli.ts` `classifyUnits`. Every request is settled on
its own (`Promise.allSettled`), so one bad request never costs the others. A **rejected request**
loses only the units it covered; those units are simply absent from `classifications`. `classify`
records one failure for that request, naming the request and not each unit, because the request is
what actually failed. A unit whose answer DID arrive but does not parse, such as an unknown option,
an out-of-range probability, or a NaN confidence, gets its own failure instead, named by the unit,
since that unit alone is what is wrong.

Every parser, `readChoice` and `readNoul`, refuses rather than defaults. A Noul or a probability
outside `[0, 1]`, a non-finite value, an array where an object is expected, or a chosen option with
no probability of its own: each of these throws an `Error`. None of them is clamped or filled in
with zero in silence.

An option that Jev omits from `probabilities`, because it scored zero, DOES read as `0`. That is
the one omission the API's own contract promises. The chosen option's own probability is the one
field that is never defaulted, because an answer that names its choice but carries no confidence in
it is not an answer this code can trust.

## Decisions not taken

Each decision below is recorded, not fixed, with the condition that reopens it. `lib/` gets only
what has a user now (round 5 ruling 2, round 6 ruling 4). A fix written before anything calls it is
the argument RFC 001 decision 3 records against this whole directory.

- **No helper builds an environment with the `GIT_*` and `GH_*` keys removed.** `RepoOptions`
  requires an `env`, and `GhClientOptions` accepts one. Both document that naming an environment is
  not the same as scrubbing it. The only worked scrub in the tree is `harness/sandbox.ts`, which is
  test code and does not ship. No Python call site scrubs anything: every one of them inherits its
  environment. A helper written here now would be a typed function with no caller.

  **Reopens at** the `hook-io.py` port (#127 layer 4). That is the first consumer that genuinely
  must not answer about the hook's own `GIT_DIR`. It is therefore where such a helper earns its
  place, and its tests.
- **`OptionSpec` admits `choices` on a boolean, and admits an empty `choices` list.** The union's
  boolean arm does not declare `choices`. But TypeScript's excess property check accepts a property
  that any member of the union declares, so `{ type: 'boolean', choices: [...] }` still
  type-checks, and the parser then ignores it. `choices: []` infers `never` and refuses every value
  instead. Neither case is reachable from a spec any command writes today.

  **Reopens when** a command declares a boolean option with `choices`, or builds a `choices` list
  from a value instead of a literal written by hand. At that point the spec must refuse both cases at
  the call site, not only at the first command line that hits them.
- **The floor comparison's patch term is unpinned.** `compareTriples` compares the patch number, and
  `NODE_FLOOR` is 22.18.**0**. So every candidate patch compares greater than or equal, and no test
  can tell a correct patch comparison from one that ignores patch entirely.

  **Reopens when** the floor moves to a release with a non-zero patch, such as a 22.18.1 that fixes
  type stripping. That is the first time the patch term decides an answer, so the comparison then
  needs its own test example either way.

## Running

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run tests/lib                   # this directory's tests alone
pnpm exec tsc -p tsconfig.json                   # types
pnpm exec biome ci . --error-on-warnings         # lint and format
```
