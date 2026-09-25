# harness

The shared test harness: an isolated sandbox, an in-process `gh` mock, real git repositories, and
a spawn helper. It is the port of what the Python suite got from `tests/conftest.py` (deleted at
#138) and `tests/gh/conftest.py` (deleted at #127).

It lives at the repository root and is imported **only from test files**, so it never sits inside a
plugin and never ships (ADR 001). Nothing here has a dependency: node built-ins, plus `vitest` for
the one cleanup hook.

| Module | What it gives a test |
| --- | --- |
| `sandbox.ts` | A private temp directory, a `HOME` inside it, no `CLAUDE_PLUGIN_DATA`, no credentials, and an `env` object to hand to children. |
| `gh.ts` | `createGhMock`: one reply per endpoint, a fail switch per endpoint, an unhandled endpoint throws. `GhClient` itself lives in the root `lib/` and is re-exported here. |
| `jev.ts` | `createJevMock`: one reply per method (`classify`, `judgePair`, `judgeEvidence`), or a sequence of them for `judgePair` and `judgeEvidence`; a fail switch on every method except `classify`, an unhandled method throws, `usage()` always answers zeros. `JevClient` itself lives in the root `lib/` and is re-exported here. |
| `pulls.ts` | The pull-request rows a test answers `gh` with (`pr`, `writePrs`, `noPrs`, `manyPrs`, `depPr`), and `createGhServer`: the same mock with a server's filtering over those rows, and a sequence of replies for an endpoint a command polls. |
| `git.ts` | Real repositories with real (local, bare) origins, in the states the commands have to handle, and `importTree` to commit a fixture directory into one. |
| `packages.ts` | A real pnpm project inside one of those repositories, and the three ways origin can move its lock file. |
| `spawn.ts` | One `scripts/` or `hooks/` entry point run as its own process: argv in, status and streams out (`runScript`), or started with its pipes still open so a test can take the reader away (`startScript`). |
| `fixtures/` | The tiny programs `spawn.test.ts` runs. Excluded from vitest and from coverage; still linted and type-checked. |

Each module's own claims are asserted in the `*.test.ts` beside it. Without that, a builder that
quietly stopped producing its state would make every test built on it pass for the wrong reason.

## Sandbox

```ts
const sandbox = createSandbox() // call it inside a test
sandbox.env // process.env, with HOME moved, CLAUDE_PLUGIN_DATA gone, git and gh swept out
sandbox.join('r') // a path inside the sandbox
sandbox.stubPath(directory) // put `directory` first on the sandbox's PATH
sandbox.pathWithout('jq') // a PATH of the real tools, minus jq
```

Nothing here touches `process.env`. pytest undoes a monkeypatch when the example ends; vitest runs
several test files through one worker process, so an env rewritten in place would outlive the test
that set it. The sandbox hands out an `env` object instead, which `runScript` and the git builders
take, and which a test may edit freely because nobody else can see it.

Cleanup is registered with vitest's `onTestFinished`, so a test that throws still removes its
directory; `sandbox.cleanup()` removes it sooner.

Every fixture repository turns `maintenance.auto` and `gc.auto` off in its own config. git spawns
both detached, and they outlive the git that started them: a repack landing after the sandbox has
walked the tree fails the removal with `ENOTEMPTY`, and so fails a test that had already passed.
Retrying does not help, because node retries the `rmdir` rather than the walk. It is set in the
repository's config rather than on the harness's own command lines, since the git processes that
race the cleanup are the ones the command under test runs.

`sandboxEnv` sweeps every `GIT_` and `GH_` variable, `GITHUB_TOKEN` and `TYPESAFE_API_KEY`, so
nothing the suite spawns can reach a real account with a developer's own credentials or answer
differently on that machine than in CI. A test that wants one back sets it on the sandbox's own
`env`.

`pathWithout` refuses a name that is not in `COMMON_TOOLS` (a typo would remove nothing and the test
would pass for the wrong reason) and refuses to return a PATH missing an essential tool (`sh`,
`bash`, `node`), which would fail a later test for a reason it never meant to provoke. A directory
named after a tool is not a match for it: the traverse bit passes an executable check, and linking
one in would leave the "not installed" branch it stands for unreachable.

## The `gh` mock

```ts
const gh = createGhMock({
  listPullRequests: [{ headRefName: 'feature-a' }],
  viewRepository: ghFails('gh: could not resolve to a Repository'),
})
```

`gh` is an injected mock rather than a stub binary on `PATH` (ADR 001). The endpoints are named
after the operation rather than after gh's argv, so the interface survives gh changing a flag:
`listPullRequests`, `listMergedPullRequests`, `viewPullRequest`, `viewRepository`, `listRuns`,
`readFailedRunLog`, `updateBranch`, `addComment`, `watchChecks`, `issueStates`,
`listMilestones`, `listIssues`, `listOpenPullRequests`, `requiredContexts`,
`viewPullRequestDetail`, `listWorkflowRuns`.

`watchChecks` is the one endpoint whose exit status is itself the answer rather than a failure: the
bounded watch answers with `{ status, timedOut, waitedMs, problem }`, because gh reports on the
checks through its own exit status and a test about a red rollup has to be able to register one.
(`issueStates` also answers with a record, `{ states, unavailable }`, but unlike `watchChecks` it
never throws at all, so there is nothing else for a test to register beside its one reply. The
three sweep reads answer `{ rows, unavailable }` and never throw for the same reason, as do
the three review-loop reads: `requiredContexts` answers `{ contexts, unavailable }`,
`viewPullRequestDetail` answers `{ pullRequest, unavailable }` with a null pull request for one
it could not read, and `listWorkflowRuns` answers `{ rows, unavailable }`.)

The double answers `listIssues` with the same reply whatever milestone is asked for, since one
registration holds no state and has no conditional logic. A test that needs a different answer
per milestone builds `createGhClient` over a runner that answers by argv instead, which is what
`plugins/workstreams/src/commands/sweep.test.ts` does with its captured replies.

- A registered reply comes back on **every** call. The mock holds no state and has no conditional
  logic, so what a command does with the reply is the only thing a test can be measuring.
- `ghFails(message, status = 1)` is the per-endpoint fail switch, and only that endpoint fails. It
  produces a `GhError` carrying that status, which is what the real client throws, so a command's
  own `error instanceof GhError && error.status === ...` arm is reachable from its tests. Its
  `detail` is the message: on a real failure `detail` is gh's own account without the
  `gh <argv> failed: ` prefix the message carries, and a command reads it rather than `message`
  for the one-line reason it prints, so the message a test writes is the line it should expect.
- An endpoint with **no** registration throws and names itself. That is the property a stub binary
  cannot give: a command that reached for gh where the test expected no call fails, instead of
  reading an empty reply as an answer.
- Failure is a thrown `Error`, not a result envelope, because an unregistered endpoint has to throw
  anyway and the real client wraps a non-zero `gh` exit the same way.
- There is no request log, no call counter, and no call-order assertion. Counting calls pins an
  implementation detail and turns a refactor red.

`GhClient`, `GhResults`, `GhEndpoint`, `PullRequestQuery`, `MergedPullRequestQuery`, `RunQuery`,
`WatchResult`, `IssueState`, and the result shapes the sweep and the review loop read
(`MilestoneSummary`, `IssueSummary`, `PullRequestSummary`, `PagedResult`, `PullRequestDetail`,
`CheckContext`, `WorkflowRun`) live in `lib/gh.ts`, the first of them moved there at
[#125](https://github.com/bje-settings/claude/issues/125), where `createGhClient` is written
against them; `gh.ts` imports them back and re-exports them, so a test reaches the double and the
interface it implements through one module. What stays in the harness is what does not ship: the
double, its reply map and its fail switch. `GhError`, the failure the real client throws, is
re-exported beside them so a test reaches the double, the interface and the error through one
module. Inputs and outputs are still plain JSON values on purpose: the commands that consume them
(#127 layers 2 and 3) shape them with their own types.

## The Jev mock

```ts
const jev = createJevMock({
  classify: { classifications: [oneClassification], failures: [] },
  judgeEvidence: jevFails('jev: rate limited'), // the fail switch, for this one method alone
})
```

`createJevMock` is the same shape as `createGhMock`, over `JevClient` (`lib/jev.ts`, #173): a reply
registered per method (`classify`, `judgePair`, `judgeEvidence`) comes back on **every** call, a
`JevError` in its place is `judgePair` and `judgeEvidence`'s own fail switch (see below for why
`classify` has none), and a method with **no** registration throws and names itself.
`jevFails(message, status = 0)` is that fail switch, mirroring `ghFails`: a plain `Error` would make
a command's own `error instanceof JevError && error.status === ...` arm unreachable from its tests,
the same gap `ghFails` closes for `GhError`. `usage()` is not registrable: it always answers zeros,
because the mock holds no state to accumulate a real total against, and a test that cares what a run
actually spent belongs against `lib/jev.test.ts`'s transport (`typesafe.ts`), which is where the
counting logic lives.

A second argument registers a **sequence** for `judgePair` or `judgeEvidence`, the same shape
`createGhServer` has (see below) and with the same rules: one entry per call, the last entry
repeats, and an entry that is an `Error` is thrown for that call alone. A sequence outranks the
single reply for that method; an empty one throws rather than falling through to it.

```ts
const jev = createJevMock({}, { judgePair: [saysSameClaim(0.4), saysSameClaim(0.9)] })
```

One reply per method answers every call with the same value, which is right for a stage whose
calls are interchangeable. It cannot state the fact a ranked findings list turns on: that two
judgments of the same kind came back with DIFFERENT confidences, which is what `report.ts` orders
its findings by. `classify` takes no sequence, because a run asks it once however many units there
are.

`classify` has no fail switch: `classifyImpl` settles every request with `Promise.allSettled` and
folds a rejected one into `ClassifyOutcome.failures` rather than rejecting its own promise, so
`classify()` on the real client never rejects (the same reason `lib/gh.ts`'s `issueStates` never
throws either). `JevReplies['classify']` excludes `Error` so `tsc` refuses `classify:
jevFails(...)` rather than letting a test pin a rejection the real client cannot produce.

`JevClient`, `ChoiceAnswer`, `Classification`, `ClassifyOutcome`, `EvidenceNeed`, `EvidenceVerdict`,
`JevRequest`, `JevUnit`, `PairVerdict`, `RequestShape` and `UnitKind` moved to `lib/jev.ts` at #173,
where `createJevClient` is written against them; `jev.ts` imports them back and re-exports them, the
same as `gh.ts` does for `lib/gh.ts`'s types. `JevError`, the failure the real client throws, is
re-exported beside them.

## The `gh` server

```ts
const gh = createGhServer({
  prs: [depPr(1, { merge: 'BEHIND' }), depPr(2, { auto: false })],
  replies: { viewRepository: { nameWithOwner: 'acme/widgets' } },
  sequences: { viewPullRequest: [depPr(1), depPr(1, { state: 'MERGED' })] },
})
```

`createGhMock` answers each endpoint with one registered reply, by design, and that is the right
double for a command that asks a question once. Two things the ported commands do are not that,
and both are what the stub `gh` the Python suite carried gave it:

- **One endpoint, two questions.** `sync-repo` asks for a window of merged pull requests and then,
  if that window saturated, about one branch; both are `gh pr list`. A double that cannot tell them
  apart cannot reach the per-branch fallback at all. `prs` is answered with the filtering GitHub
  applies server-side: `--state` (case-insensitively, and a row with no state at all is merged),
  `--base`, `--head`, `--label` and `--limit`, plus resolving `pr view <n>` against the same set
  and failing a number that resolves to nothing in gh's own words.
- **The same question twice, with the answer changing in between.** `settle` reads the pull request
  until GitHub decides and `recreate` polls the head SHA until Dependabot moves it. The Python
  arranged that by rewriting the canned file from a background thread, gated on the call log;
  `sequences` is the same fact with no race: one entry per call, and the last entry repeats, so a
  poll that runs one read longer than the test expected reads the settled answer rather than
  falling off the end. An entry that is an `Error` is thrown for that call alone.

Precedence, highest first: `fail` (the stub's `GH_FIXTURE_FAIL`, every call), then the endpoint's
sequence, then its single reply, then the pull-request set, then the unregistered endpoint's throw.
`failHead` is the stub's `GH_FIXTURE_FAIL_HEAD`: only a query that names a branch fails, so a bulk
window can be answered while the per-branch question is not.

It stays a filter over registered data, which is what ADR 001's "the mock holds no conditional
logic" is about: reproducing the SERVER's filter is fidelity, and nothing in it knows what a
command decides. The one property of `createGhMock` it gives up is stated in its own doc comment:
with `prs` given, the three pull-request endpoints are always answered, so a test that means "this
must not be called" registers no set (or registers a failure for that endpoint).

The row builders are the port of the pull-request half of the gh plugin's Python conftest
(deleted at #127). `pr` and
`manyPrs` build the merged rows the sync layer reads; `depPr(number, keys)` builds one
`dependencies` pull request carrying every field `PR_FIELDS` asks gh for, with the same keys and
the same defaults the Python's had (`state`, `merge`, `checks`, `auto`, `bot`, `draft`, `review`,
`risk`, `created`, `head`), so a captured Python run and the TypeScript example beside it are built
from the same row. `writePrs` and `noPrs` keep their names from the Python, where they wrote the
set to the file the stub read; here the set is passed to the server instead.

## The git builders

```ts
const git = createGitFixtures(sandbox)
const work = git.create(sandbox.join('r')) // work tree + bare origin
git.branchWithWork(work, 'feature')
git.mergeSquash(work, 'feature')
```

git is not mocked. Every fixture is an actual repository with an actual (local, bare) origin, so
`git fetch`, `git merge --ff-only`, ancestry checks and worktree operations behave exactly as they
do in production. Nothing reaches the network.

Two constructors, because the two scopes need different shapes:

- `create(root)` puts the work tree at `<root>/work` and the bare origin at `<root>/origin.git`.
  Use it for single-repo tests.
- `createAt(parent, name)` puts the work tree at `<parent>/<name>` and parks the bare origin in
  `<parent>/.origins`. Use it for fan-out tests, where the scanned directory must contain work trees
  and nothing else. The origins directory is hidden, so a non-recursive scan skips it.

| Builder | State it produces |
| --- | --- |
| `commit` / `push` / `branch` | One commit appending to a tracked file; a push of one branch; a branch created without moving the checkout. |
| `branchWithWork` | A branch carrying one real commit. |
| `importTree` | A whole fixture directory copied in and committed, undoing the two names a fixture cannot be stored under: `_gitignore` becomes `.gitignore`, and a `.fixture.md` suffix becomes `.md` so a fixture `CLAUDE.md` is never read as guidance for this repository. |
| `mergeFf` | Fast-forwarded, leaving the branch **at** the default tip, which is where the tip guard takes over instead of ancestry. |
| `mergeCommit` | Merged with a merge commit, leaving the branch strictly **behind** the default branch, which is where ancestry is the interesting signal. |
| `mergeSquash` | Squashed, leaving **no** ancestry, so only a pull-request signal can prove it. |
| `dirty` / `untracked` | A tracked modification (blocks a sync) versus an untracked file (must not). |
| `corruptIndex` | `git status` exits non-zero with empty stdout, the shape a fail-closed preflight guards against. |
| `inProgress` | A rebase or merge marker: a directory for `rebase-merge`, a file holding HEAD for `MERGE_HEAD`. |
| `worktree` | A linked worktree on a given branch. |
| `diverge` | A local commit and an origin commit, so the default branch cannot fast-forward. |
| `lockfile` | A committed lock file and its `package.json`, for install detection. |
| `remoteAdvance` | Origin gains a commit the clone lacks, optionally touching a named file. |
| `removeOrigin` | Drops the `origin` remote, so a preflight refuses before anything is written. |
| `breakOrigin` | The remote exists but is unreachable, so fetch fails while the preflight still passes. |
| `forgetOriginHead` | Drops the cached `origin/HEAD`. It is a *symbolic* ref, so it is deleted as one; `update-ref -d` leaves it resolvable. |
| `dropRemoteBranches` | Removes every remote-tracking branch, so no default branch resolves at all. |
| `lockIndex` | An index lock, which `git status` tolerates but ref-writing commands refuse, so a mid-run git failure can be provoked without corrupting anything. |
| `gitShim` | A directory whose `git` refuses the named subcommands and forwards everything else, plus the `GIT_STUB_FAIL` value to pass beside it. Assert on the `git stub: refusing ` line: a shim that was wired up wrong forwards silently. |
| `sha` / `headSha` / `branches` / `currentBranch` | Read the repository back. |
| `git` / `tryGit` | Any other git command, throwing on failure or reporting it. |

Every call is isolated from the developer's own git configuration, which may set a different default
branch, sign commits, install hooks, or hide untracked files, any of which would change what a
fixture produces. Identity, signing and hooks are pinned per command with `-c`; the rest is pinned
by the sandbox's `env`, which points `GIT_CONFIG_GLOBAL` inside the sandbox HOME and sets
`GIT_CONFIG_NOSYSTEM`. Moving HOME alone is not enough: `GIT_CONFIG_GLOBAL` overrides the HOME
lookup, and this repository's own workspace exports it from direnv, so a fixture would otherwise
read a file CI never sees.

Pinning those two is not enough either, so the sandbox's `env` carries no `GIT_` or `GH_` variable
it did not set itself. `GIT_DIR` replaces the repository `-C` chose, `GIT_CONFIG_COUNT` carries
configuration neither pin displaces, and `GIT_AUTHOR_NAME` beats the `-c user.name` above, so the
identity that reads as pinned is not. A git hook is run with those exported, and a pre-commit hook
is one of the places this suite runs. `GH_` goes with them because `gh` is an injected mock: nothing
here may reach the real one, and a child holding the developer's token would make that mistake a
live API call rather than a failure.

The distinction between the three merge builders is load-bearing, and `git.test.ts` asserts each of
those claims directly.

## The package-manager builders

```ts
const packages = createPackageFixtures(sandbox, git)
packages.jsProject(work)        // package.json + the pnpm-lock.yaml pnpm wrote, committed
packages.remoteUpdateLock(work) // origin regenerates the lock file, so a pull moves it
```

pnpm only (the maintainer's ruling on #127, 2026-09-20): the port watches one lock file and runs
one command, so the `manager` argument the Python's builders took has nothing to select. Yarn
Berry and npm, `YARN_VERSION` and `has_yarn_berry` are not ported, and neither is the
`packageManager` field they existed to drive, which is what corepack reads.

The lock file is written by the real pnpm on PATH rather than by hand, so that a lock-file diff and
a real `pnpm install --frozen-lockfile` are both exercised against the same file. CI has pnpm from
`pnpm/action-setup`, which the vitest jobs already run, and needs no corepack step.

`COREPACK_HOME` is the one dependency on the machine, and `corepackHome` is that resolution as a
pure function. On a machine whose `pnpm` is a corepack shim rather than a binary, corepack's cache
lives under `HOME` and the sandbox moves `HOME`, so without carrying the real cache in every
install example downloads a package manager over the network. A test that runs an install passes
it in its own `env`; a test that needs no package manager must not quietly acquire one.

### Still deferred to #127 layer 3

The pull-request data builders (`pr`, `write_prs`, `no_prs`, `many_prs`, `dep_pr`) are **not**
ported here. They land with the shepherd layer, the port whose tests consume them: building them
ahead of any consumer would be a horizontal slice.

## The spawn helper

```ts
const result = runScript(entry, { args: ['--repo', 'acme/widgets'], env: sandbox.env })
result.status // exit code
result.stdout // decoded with replacement, never strictly
result.stdoutBytes // the raw bytes, for a contract that is about bytes
```

One spawned contract test per `scripts/` entry point, which is where the process boundary is still
real; everything else is tested by calling the command function with injected clients. The child
runs under `process.execPath`, so a run on the 22.18 floor leg genuinely exercises 22.18. A child
that could not be started at all throws, rather than handing back a result full of empty strings.

## Running

```bash
pnpm test                                        # the whole suite, with coverage
pnpm exec vitest run harness                     # this directory alone
pnpm exec tsc -p tsconfig.json                   # types, including fixtures/
pnpm exec biome ci . --error-on-warnings         # lint and format
```

`harness/**/*.ts` is measured at 100 on lines, branches, functions and statements, minus the test
files and `fixtures/`.
