# harness

The shared test harness for the TypeScript side of the repository: an isolated sandbox, an
in-process `gh` mock, real git repositories, and a spawn helper. It is the port of what the Python
suite gets from `tests/conftest.py` and `tests/gh/conftest.py`.

It lives at the repository root and is imported **only from test files**, so it never sits inside a
plugin and never ships (ADR 001). Nothing here has a dependency: node built-ins, plus `vitest` for
the one cleanup hook.

| Module | What it gives a test |
| --- | --- |
| `sandbox.ts` | A private temp directory, a `HOME` inside it, no `CLAUDE_PLUGIN_DATA`, and an `env` object to hand to children. |
| `gh.ts` | `createGhMock`: one reply per endpoint, a fail switch per endpoint, an unhandled endpoint throws. `GhClient` itself lives in the root `lib/` and is re-exported here. |
| `git.ts` | Real repositories with real (local, bare) origins, in the states the commands have to handle. |
| `spawn.ts` | One `bin/` entry point run as its own process: argv in, status and streams out. |
| `fixtures/` | The tiny programs `spawn.test.ts` runs. Excluded from vitest and from coverage; still linted and type-checked. |

Each module's own claims are asserted in the `*.test.ts` beside it, the way
`tests/gh/test_gh_fixtures.py` asserts the Python fixtures'. Without that, a builder that quietly
stopped producing its state would make every test built on it pass for the wrong reason.

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
`readFailedRunLog`, `updateBranch`, `addComment`, `watchChecks`.

`watchChecks` is the one endpoint whose reply is a record rather than a list or a string: the
bounded watch answers with `{ status, timedOut, waitedMs, problem }`, because gh reports on the
checks through its own exit status and a test about a red rollup has to be able to register one.

- A registered reply comes back on **every** call. The mock holds no state and has no conditional
  logic, so what a command does with the reply is the only thing a test can be measuring.
- `ghFails(message)` is the per-endpoint fail switch, and only that endpoint fails.
- An endpoint with **no** registration throws and names itself. That is the property a stub binary
  cannot give: a command that reached for gh where the test expected no call fails, instead of
  reading an empty reply as an answer.
- Failure is a thrown `Error`, not a result envelope, because an unregistered endpoint has to throw
  anyway and the real client wraps a non-zero `gh` exit the same way.
- There is no request log, no call counter, and no call-order assertion. Counting calls pins an
  implementation detail and turns a refactor red.

`GhClient`, `GhResults`, `GhEndpoint`, `PullRequestQuery`, `MergedPullRequestQuery`, `RunQuery`
and `WatchResult` moved to `lib/gh.ts` at
[#125](https://github.com/bje-settings/claude/issues/125), where `createGhClient` is written
against them; `gh.ts` imports them back and re-exports them, so a test reaches the double and the
interface it implements through one module. What stays in the harness is what does not ship: the
double, its reply map and its fail switch. `GhError`, the failure the real client throws, is
re-exported beside them so a test reaches the double, the interface and the error through one
module. Inputs and outputs are still plain JSON values on purpose: the commands that consume them
(#127 layers 2 and 3) shape them with their own types.

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

### Deferred to #127

The package-manager builders (`js_project`, `remote_update_lock`, `remote_break_lock`,
`remote_drop_lockfile`, `corepack_cache`) and the pull-request data (`pr`, `write_prs`, `no_prs`,
`many_prs`, `dep_pr`) are **not** ported here. They land with
[#127](https://github.com/bje-settings/claude/issues/127), the port whose tests consume them:
building them ahead of any consumer would be a horizontal slice, and the package-manager ones would
skip on a machine without all three managers, leaving this directory below its own coverage floor
locally.

## The spawn helper

```ts
const result = runScript(entry, { args: ['--repo', 'acme/widgets'], env: sandbox.env })
result.status // exit code
result.stdout // decoded with replacement, never strictly
result.stdoutBytes // the raw bytes, for a contract that is about bytes
```

One spawned contract test per `bin/` entry point, which is where the process boundary is still
real; everything else is tested by calling the command function with injected clients. The child
runs under `process.execPath`, so a run on the 22.18 floor leg genuinely exercises 22.18. A child
that could not be started at all throws, rather than handing back a result full of empty strings.

The closed-reader variant of `run_script` in `tests/conftest.py` is not ported until a command needs
it.

## Running

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run harness                     # this directory alone
pnpm exec tsc -p tsconfig.json                   # types, including fixtures/
pnpm exec biome ci . --error-on-warnings         # lint and format
```

`harness/**/*.ts` is measured at 100 on lines, branches, functions and statements, minus the test
files and `fixtures/`.
