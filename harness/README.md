# harness

The harness is the shared test harness. It gives tests an isolated sandbox, an in-process `gh`
mock, real git repositories, and a spawn helper. It replaces the Python suite's
`tests/conftest.py` (deleted at #138) and `tests/gh/conftest.py` (deleted at #127).

The harness lives at the repository root. Test files are the only importers. Because of this, the
harness never sits inside a plugin and never ships (ADR 001). The harness has no dependency other
than node built-ins. It uses `vitest` only for one cleanup hook.

| Module | What it gives a test |
| --- | --- |
| `sandbox.ts` | A private temp directory. A `HOME` inside it. No `CLAUDE_PLUGIN_DATA`. No credentials. An `env` object for children. |
| `gh.ts` | `createGhMock` gives one reply per endpoint and a fail switch per endpoint. An unhandled endpoint throws an error. `GhClient` lives in the root `lib/`. The harness re-exports it. |
| `jev.ts` | `createJevMock` gives one reply per method (`classify`, `judgePair`, `judgeEvidence`). For `judgePair` and `judgeEvidence`, it can give a sequence of replies instead. Every method except `classify` has a fail switch. An unhandled method throws an error. `usage()` always answers zeros. `JevClient` lives in the root `lib/` and the harness re-exports it. |
| `pulls.ts` | The pull-request rows a test gives `gh` as answers: `pr`, `writePrs`, `noPrs`, `manyPrs`, `depPr`. `createGhServer` is the same mock, with a server's filter over those rows. It also gives a sequence of replies for an endpoint that a command polls. |
| `git.ts` | Real repositories with real (local, bare) origins, in the states the commands must handle. `importTree` commits a fixture directory into one repository. |
| `packages.ts` | A real pnpm project inside one of those repositories, and the three ways origin can move its lock file. |
| `spawn.ts` | One `scripts/` or `hooks/` entry point, run as its own process. `runScript` gives argv in, and status and streams out. `startScript` starts the process with its pipes open, so a test can take the reader. |
| `output.ts` | `captureOutput` gives an `Output` over the real `createOutput`. `stdout()` and `stderr()` give the text that each stream got. |
| `runner.ts` | `runResult` makes a `RunResult` for a child that did nothing wrong. `tableRunner` makes a `Runner` that answers from a table and records each call. |
| `paths.ts` | `ROOT` and `pluginFile`: the path to a plugin's script or hook, for a test that runs it as a process. |

Each module's claims are asserted in `tests/harness/<module>.test.ts`. The tiny programs that
`tests/harness/spawn.test.ts` runs are in `tests/harness/fixtures/`. Without these tests, a builder could
quietly stop producing its state. Every test built on that builder would then pass for the wrong
reason.

## Sandbox

```ts
const sandbox = createSandbox() // call it inside a test
sandbox.env // process.env, with HOME moved, CLAUDE_PLUGIN_DATA gone, git and gh swept out
sandbox.join('r') // a path inside the sandbox
sandbox.stubPath(directory) // put `directory` first on the sandbox's PATH
sandbox.pathWithout('jq') // a PATH of the real tools, minus jq
```

Nothing here touches `process.env`. Pytest undoes a monkeypatch when an example ends. Vitest runs
several test files in one worker process. An env change made in place would outlive the test that
made it. Instead, the sandbox hands out its own `env` object. `runScript` and the git builders
take this object. A test may edit it freely, because no other test can see it.

The sandbox registers cleanup with vitest's `onTestFinished`. This way, a test that throws still
removes its directory. `sandbox.cleanup()` removes the directory sooner.

Every fixture repository turns off `maintenance.auto` and `gc.auto` in its own config. Git spawns
both processes detached. Each process can outlive the git command that started it.

A repack can land after the sandbox has walked the tree. This makes the removal fail with
`ENOTEMPTY`, and a test that had already passed then fails. A retry does not help, because node
retries the `rmdir` call, not the tree walk.

The setting lives in the repository's config, not on the harness's own command lines. This is
because the git processes that race the cleanup are the same processes the command under test
runs.

`sandboxEnv` removes every `GIT_` and `GH_` variable, plus `GITHUB_TOKEN` and `TYPESAFE_API_KEY`.
This stops anything the suite spawns from reaching a real account with a developer's own
credentials. It also stops the machine from answering differently than CI. A test that wants one
of these variables back sets it on the sandbox's own `env`.

`pathWithout` refuses a name that is not in `COMMON_TOOLS`. This guard exists because a typo
would remove nothing, and the test would then pass for the wrong reason. `pathWithout` also
refuses to return a PATH that is missing an essential tool (`sh`, `bash`, `node`). Without this
guard, a later test could fail for a reason it never meant to test.

A directory that has a tool's name is not a match for that tool. Its traverse bit alone passes an
executable check. If a test links one in, the "not installed" branch it stands for stays
unreachable.

## The `gh` mock

```ts
const gh = createGhMock({
  listPullRequests: [{ headRefName: 'feature-a' }],
  viewRepository: ghFails('gh: could not resolve to a Repository'),
})
```

`gh` is an injected mock, not a stub binary on `PATH` (ADR 001). The one exception is the stand-in
`gh` that the hook tests put first on `PATH`
(`tests/plugins/gh/subcommands/hook-io.test-support.ts`). It answers nothing and always fails. It
lets the hook find a GitHub CLI on any machine, and it keeps a spawned run away from GitHub. Each
endpoint is named after its operation, not after gh's own argv. This way, the interface survives a
change to a gh flag. The endpoints are: `listPullRequests`, `listMergedPullRequests`,
`viewPullRequest`, `viewRepository`, `listRuns`, `readFailedRunLog`, `updateBranch`, `addComment`,
`issueStates`, `listMilestones`, `listIssues`, `searchPlanIssues`, `readPlanIssues`,
`listOpenPullRequests`, `listOpenPullRequestHeads`, `listOpenPullRequestLinks`, `requiredContexts`,
`requiredReviews`, `viewPullRequestDetail`, `listWorkflowRuns`, `compareCommits`,
`listPullRequestStatuses`, `createCommitStatus`, `repositoryStatus`.

`issueStates` answers with a record, `{ states, unavailable }`. It never throws.
So a test has nothing else to register beside its one reply.

The three sweep reads never throw, for the same reason, and each answers `{ rows, unavailable }`.
The review-loop reads follow the same pattern. `requiredContexts` answers
`{ contexts, unavailable }`. `viewPullRequestDetail` answers `{ pullRequest, unavailable, missing }`,
with a null pull request for one it could not read. `listWorkflowRuns` answers
`{ rows, unavailable }`. So does `listOpenPullRequestHeads`, the one read the watch and the
intersect make for every open head. So does `listOpenPullRequestLinks`, the read of the stack
links. `compareCommits` answers `{ comparison, unavailable }`, with a null comparison for one it
could not read. `requiredReviews` answers `{ reviews, unavailable }`, with null `reviews` for rules
it could not read. `listPullRequestStatuses` answers `{ rows, unavailable }`. `createCommitStatus`
is a write, and throws on a failure, as `addComment` does.

`repositoryStatus` answers `{ repositories, unavailable }` and never throws either. The
SessionStart hook reads it (#230).

`missing` is true only when GitHub itself said the number does not exist. It is false for every
other reason the read came back short. A test that registers a reply must say which case it means.

The double answers `listIssues` with the same reply for any milestone. One registration holds no
state and has no conditional logic. A test that needs a different answer per milestone must build
`createGhClient` over a runner that answers by argv instead. `tests/plugins/workstreams/subcommands/sweep.test.ts`
does this with its captured replies.

- A registered reply comes back on **every** call. The mock holds no state and has no
  conditional logic. So a test can measure only what a command does with the reply.
- `ghFails(message, status = 1)` is the per-endpoint fail switch. Only that one endpoint fails.
  It produces a `GhError` that carries that status, the same error the real client throws. This
  makes a command's own `error instanceof GhError && error.status === ...` branch reachable from
  its tests.
- Its `detail` field holds the message. On a real failure, `detail` holds gh's own account,
  without the `gh <argv> failed: ` prefix the message carries. A command reads `detail`, not
  `message`, for the one-line reason it prints. So the message a test writes is the line the
  command should print.
- An endpoint with **no** registration throws an error, and names itself in the error. A stub
  binary cannot give this property. If a command calls gh where the test expected no call, the
  command fails. It does not read an empty reply as an answer.
- Failure is a thrown `Error`, not a result envelope. An unregistered endpoint must throw anyway.
  The real client also wraps a non-zero `gh` exit as a thrown error.
- There is no request log, no call counter, and no call-order assertion. A call count is an
  implementation detail. A test that counts calls would turn a refactor red.

`GhClient`, `GhResults`, `GhEndpoint`, `PullRequestQuery`, `MergedPullRequestQuery`, `RunQuery`,
and `IssueState` live in `lib/gh.ts`. The result shapes that the sweep and the
review loop read also live there: `MilestoneSummary`, `IssueSummary`, `PullRequestSummary`,
`PagedResult`, `PullRequestDetail`, `CheckContext`, `WorkflowRun`, `CommitStatus`. The first of them moved there
at [#125](https://github.com/bje-settings/claude/issues/125), where `createGhClient` is written
against them. The status line reads `RepositoryStatus` and `MergedHead`, which also live there.

`gh.ts` imports these types back and re-exports them. This way, a test reaches the double and the
interface it implements through one module. The harness keeps only what does not ship: the
double, its reply map, and its fail switch.

`GhError`, the failure the real client throws, is re-exported beside them. This way, a test
reaches the double, the interface, and the error through one module. Inputs and outputs stay as
plain JSON values on purpose. The commands that consume them (#127 layers 2 and 3) shape them
with their own types.

## The Jev mock

```ts
const jev = createJevMock({
  classify: { classifications: [oneClassification], failures: [] },
  judgeEvidence: jevFails('jev: rate limited'), // the fail switch, for this one method alone
})
```

`createJevMock` has the same shape as `createGhMock`, over `JevClient` (`lib/jev.ts`, #173). A
reply registered per method (`classify`, `judgePair`, `judgeEvidence`) comes back on **every**
call. A `JevError` in its place is the fail switch for `judgePair` and `judgeEvidence` (see below
for why `classify` has none). A method with **no** registration throws an error and names itself.

`jevFails(message, status = 0)` is that fail switch, matching `ghFails`. A plain `Error` would
leave a command's own `error instanceof JevError && error.status === ...` branch unreachable from
its tests. `ghFails` closes the same gap for `GhError`.

`usage()` is not registrable. It always answers zeros, because the mock holds no state to add a
real total against. A test that cares what a run actually spent must use `tests/lib/jev.test.ts`'s
transport (`typesafe.ts`) instead, where the counting logic lives.

A second argument registers a **sequence** for `judgePair` or `judgeEvidence`. This has the same
shape as `createGhServer` (see below), with the same rules. Each call takes one entry, and the
last entry repeats. An entry that is an `Error` throws, for that one call. A sequence outranks the
single reply for that method. An empty sequence throws; it does not fall through to the single
reply.

```ts
const jev = createJevMock({}, { judgePair: [saysSameClaim(0.4), saysSameClaim(0.9)] })
```

One reply per method answers every call with the same value. This is right for a stage whose
calls are interchangeable. But it cannot state one fact: that two judgments of the same kind came
back with DIFFERENT confidences. A ranked findings list turns on this fact, and `report.ts`
orders its findings by it. `classify` takes no sequence, because a run asks it once, no matter how
many units there are.

`classify` has no fail switch. `classifyImpl` settles every request with `Promise.allSettled`. It
folds a rejected request into `ClassifyOutcome.failures`, instead of rejecting its own promise. So
`classify()` on the real client never rejects (the same reason `lib/gh.ts`'s `issueStates` never
throws either). `JevReplies['classify']` excludes `Error`. This makes `tsc` refuse
`classify: jevFails(...)`, so a test cannot pin a rejection the real client cannot produce.

`JevClient`, `ChoiceAnswer`, `Classification`, `ClassifyOutcome`, `EvidenceNeed`,
`EvidenceVerdict`, `JevRequest`, `JevUnit`, `PairVerdict`, `RequestShape`, and `UnitKind` moved to
`lib/jev.ts` at #173, where `createJevClient` is written against them. `jev.ts` imports them back
and re-exports them, the same way `gh.ts` does for `lib/gh.ts`'s types. `JevError`, the failure
the real client throws, is re-exported beside them.

## The `gh` server

```ts
const gh = createGhServer({
  prs: [depPr(1, { merge: 'BEHIND' }), depPr(2, { auto: false })],
  replies: { viewRepository: { nameWithOwner: 'acme/widgets' } },
  sequences: { viewPullRequest: [depPr(1), depPr(1, { state: 'MERGED' })] },
})
```

`createGhMock` answers each endpoint with one registered reply, by design. This is the right
double for a command that asks one question. Two things the ported commands do are not that
simple. Both are things the stub `gh` in the Python suite gave it:

- **One endpoint, two questions.** `sync-repo` asks for a window of merged pull requests. If that
  window is full, it then asks about one branch. Both calls are `gh pr list`. A double that
  cannot tell them apart cannot reach the per-branch fallback at all. `prs` answers with the same
  filter GitHub applies on its own server: `--state` (case-insensitive; a row with no state at
  all counts as merged), `--base`, `--head`, `--label`, and `--limit`. It also resolves
  `pr view <n>` against the same set, and fails a number that resolves to nothing, in gh's own
  words.
- **The same question twice, with a changing answer.** `settle` reads the pull request until
  GitHub decides. The Python suite arranged this by rewriting the canned file from a background
  thread, gated on the call log.
  `sequences` gives the same fact with no race: one entry per call, and the last entry repeats.
  So a poll that runs one read longer than the test expected still reads the settled answer,
  instead of falling off the end. An entry that is an `Error` throws, for that one call.

Precedence, highest first: `fail` (the stub's `GH_FIXTURE_FAIL`, every call), then the endpoint's
sequence, then its single reply, then the pull-request set, then the unregistered endpoint's
throw. `failHead` is the stub's `GH_FIXTURE_FAIL_HEAD`. Only a query that names a branch fails.
So a bulk window can still be answered, while the per-branch question is not.

`createGhServer` stays a filter over registered data. This is what ADR 001's rule, "the mock
holds no conditional logic," is about. Reproducing the SERVER's filter is fidelity; nothing in it
knows what a command decides.

`createGhServer` gives up one property of `createGhMock`, stated in its own doc comment. With
`prs` given, the three pull-request endpoints are always answered. So a test that means "this
must not be called" must register no set, or must register a failure for that endpoint.

The row builders are the port of the pull-request half of the `gh` plugin's Python conftest
(deleted at #127). `pr` and `manyPrs` build the merged rows that the sync layer reads.
`depPr(number, keys)` builds one `dependencies` pull request. It carries every field that
`PR_FIELDS` asks gh for, with the same keys and the same defaults the Python version had
(`state`, `merge`, `checks`, `auto`, `bot`, `draft`, `review`, `risk`, `created`, `head`). So a
captured Python run and the TypeScript example beside it are built from the same row.

`writePrs` and `noPrs` keep their names from the Python version. There, they wrote the set to the
file the stub read. Here, the set is passed to the server instead.

## The git builders

```ts
const git = createGitFixtures(sandbox)
const work = git.create(sandbox.join('r')) // work tree + bare origin
git.branchWithWork(work, 'feature')
git.mergeSquash(work, 'feature')
```

Git is not mocked. Every fixture is an actual repository with an actual (local, bare) origin. So
`git fetch`, `git merge --ff-only`, ancestry checks, and worktree operations all behave exactly as
they do in production. Nothing reaches the network.

Two constructors, because the two scopes need different shapes:

- `create(root)` puts the work tree at `<root>/work` and the bare origin at `<root>/origin.git`.
  Use it for single-repo tests.
- `createAt(parent, name)` puts the work tree at `<parent>/<name>` and parks the bare origin in
  `<parent>/.origins`. Use it for fan-out tests, where the scanned directory must contain work trees
  and nothing else. The origins directory is hidden, so a non-recursive scan skips it.

Both constructors copy one template repository, then point `origin` at the copy's own bare
repository with `git remote set-url`. The template is seeded with git one time for each test file
and removed when that file ends. A seed is about ten git processes, and a copy is one (#205).
`tests/harness/git.test.ts` proves that a test cannot tell a copy from a seeded repository.
`createGitFixtures(sandbox, { fresh: true })` seeds each repository and makes no copy. Only that
proof uses it.

| Builder | State it produces |
| --- | --- |
| `commit` / `push` / `branch` | One commit that adds to a tracked file. A push of one branch. A new branch, with no checkout move. |
| `branchWithWork` | A branch that carries one real commit. |
| `importTree` | A whole fixture directory, copied in and committed. This undoes two names a fixture cannot use: `_gitignore` becomes `.gitignore`, and a `.fixture.md` suffix becomes `.md`. A fixture `CLAUDE.md` file is then never read as guidance for this repository. |
| `mergeFf` | Fast-forwarded. The branch sits **at** the default tip. This is where the tip guard takes over, instead of ancestry. |
| `mergeCommit` | Merged with a merge commit. The branch sits strictly **behind** the default branch. Here, ancestry is the interesting signal. |
| `mergeSquash` | Squashed, with **no** ancestry left. Only a pull-request signal can prove the merge. |
| `dirty` / `untracked` | A tracked modification (blocks a sync) versus an untracked file (must not). |
| `corruptIndex` | `git status` exits non-zero with empty stdout. This is the shape a fail-closed preflight guards against. |
| `inProgress` | A rebase or merge marker: a directory for `rebase-merge`, a file that holds HEAD for `MERGE_HEAD`. |
| `worktree` | A linked worktree on a given branch. |
| `diverge` | A local commit and an origin commit, so the default branch cannot fast-forward. |
| `lockfile` | A committed lock file and its `package.json`, for install detection. |
| `remoteAdvance` | Origin gains a commit that the clone lacks. It can optionally touch a named file. |
| `removeOrigin` | Drops the `origin` remote, so a preflight refuses before any write. |
| `breakOrigin` | The remote exists but is unreachable, so fetch fails while the preflight still passes. |
| `forgetOriginHead` | Drops the cached `origin/HEAD`. This ref is *symbolic*, so the builder deletes it as one; `update-ref -d` would leave it resolvable instead. |
| `dropRemoteBranches` | Removes every remote-tracking branch, so no default branch resolves at all. |
| `lockIndex` | An index lock. `git status` tolerates it, but ref-writing commands refuse it. This lets a test provoke a mid-run git failure without damage to anything. |
| `gitShim` | A directory whose `git` refuses the named subcommands and forwards everything else. It also gives the `GIT_STUB_FAIL` value to pass beside it. Check for the `git stub: refusing ` line. A shim wired up wrong forwards silently instead. |
| `sha` / `headSha` / `branches` / `currentBranch` | Read the repository back. |
| `git` / `tryGit` | Any other git command. `git` throws on failure; `tryGit` reports it instead. |

Every call is isolated from the developer's own git configuration. That configuration may set a
different default branch, sign commits, install hooks, or hide untracked files. Any of these
would change what a fixture produces. The harness pins identity, signing, and hooks per command
with `-c`. It pins the rest with the sandbox's `env`, which points `GIT_CONFIG_GLOBAL` inside the
sandbox HOME and sets `GIT_CONFIG_NOSYSTEM`.

Moving HOME alone is not enough. `GIT_CONFIG_GLOBAL` overrides the HOME lookup, and this
repository's own workspace exports it from direnv. Without the pin, a fixture would read a file
that CI never sees.

These two pins are not enough either. So the sandbox's `env` carries no `GIT_` or `GH_` variable
that it did not set itself. Left alone, `GIT_DIR` would replace the repository that `-C` chose.
`GIT_CONFIG_COUNT` would carry configuration that neither pin displaces. `GIT_AUTHOR_NAME` would
beat the `-c user.name` pin above, so the identity that reads as pinned would not really be
pinned.

The harness runs a git hook with those variables exported. A pre-commit hook is one place this
suite runs. `GH_` variables go with them, because `gh` is an injected mock. Nothing here may
reach the real `gh`. A child holding the developer's token would turn that mistake into a live
API call, instead of a failure.

The distinction between the three merge builders is load-bearing. `tests/harness/git.test.ts` asserts each of
those claims directly.

## The package-manager builders

```ts
const packages = createPackageFixtures(sandbox, git)
packages.jsProject(work)        // package.json + the pnpm-lock.yaml pnpm wrote, committed
packages.remoteUpdateLock(work) // origin regenerates the lock file, so a pull moves it
```

pnpm only (the maintainer's ruling on #127, 2026-09-20). The port watches one lock file and runs
one command. So the `manager` argument that the Python builders took has nothing to select. Yarn
Berry and npm are not ported, and neither are `YARN_VERSION` and `has_yarn_berry`. The
`packageManager` field is not ported either; corepack read that field to pick a manager.

The real pnpm on PATH writes the lock file; the harness does not write it by hand. This way, a
lock-file diff and a real `pnpm install --frozen-lockfile` both run against the same file. CI has
pnpm from `pnpm/action-setup`, which the vitest jobs already run. CI needs no corepack step.

`COREPACK_HOME` is the one dependency on the machine. `corepackHome` is that resolution, as a pure
function. On a machine where `pnpm` is a corepack shim, not a binary, corepack's cache lives under
`HOME`. The sandbox moves `HOME`. Without the real cache carried in, every install example would
download a package manager over the network. A test that runs an install passes the real cache in
its own `env`. A test that needs no package manager must not quietly get one.

### Still deferred to #127 layer 3

The pull-request data builders (`pr`, `write_prs`, `no_prs`, `many_prs`, `dep_pr`) are **not**
ported here. They land with the shepherd layer, the port whose tests consume them. A build ahead
of any consumer would be a horizontal slice.

## The spawn helper

```ts
const result = runScript(entry, { args: ['--repo', 'acme/widgets'], env: sandbox.env })
result.status // exit code
result.stdout // decoded with replacement, never strictly
result.stdoutBytes // the raw bytes, for a contract that is about bytes
```

One spawned contract test covers each `scripts/` entry point. This is where the process boundary
is still real. A test reaches everything else by calling the command function with injected
clients. The child runs under `process.execPath`. So a run on the 22.18 floor leg genuinely tests
22.18. A child that could not start at all throws an error. It does not hand back a result full of
empty strings.

## The output capture and the table runner

```ts
const output = captureOutput() // pass it as the command's `output`
output.stdout() // text written to stdout
const run = tableRunner({ 'gh auth token': { stdout: 'token\n' } })
run.asked // [{ key: 'gh auth token', options }, ...]
```

Use these for a command function that a test runs in process. A call that the table does not name
answers as a child that exited 0 and wrote nothing. `runResult(reply)` makes one such answer.

## Running

```bash
pnpm test                                        # the whole suite, with coverage
pnpm exec vitest run tests/harness               # this directory's tests alone
pnpm exec tsc -p tsconfig.json                   # types, including the fixtures
pnpm exec biome ci . --error-on-warnings         # lint and format
```

`harness/**/*.ts` is measured at 100 on lines, branches, functions, and statements.
