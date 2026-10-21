// This suite tests `shepherd.ts shepherd-status` against the Python's own captured
// output. It is the port of `tests/gh/test_shepherd_status.py` and of the
// `gh-shepherd-status.py` half of `test_shepherd_edges.py`.
//
// The parity block is the contract. Every case in
// `fixtures/shepherd-status-output.json` replays here, from the same canned
// pull-request set the Python's stub `gh` answered from. The suite compares
// the document, stderr and exit status against what the Python printed, byte
// for byte. Only the divergences that `fixtures/README-shepherd.md` records
// are different.
//
// The examples after the parity block prove two claims the captured output
// alone cannot prove. One is which query the command sent. The other is what
// happens when something other than `gh` fails.
//
// git is real (`harness/git.ts`). `gh` is the injected client
// (`harness/pulls.ts`). The sandbox builds its repository at the same path
// the capture used. So the two sets of paths match with no rewrite step.
//
// **#127 deleted the Python code this file ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree. The file and line references below point to what they held at
// `cd0d515`. Each reference stays because it shows where a rule came from.
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { type GhClient, type GhResults, ghFails } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createGhServer, depPr, type GhServerOptions, type PullRequestRow } from '#harness/pulls.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'
import { createOutput, type OutputStream } from '#shepherd/lib/streams.ts'
import type { ShepherdContext } from '#shepherd/shepherd.ts'
import { HELP, runShepherdStatus } from '#shepherd/subcommands/shepherd-status.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

interface CapturedCase {
  argv: string[]
  env: Record<string, string>
  prs: PullRequestRow[] | null
  status: number
  stdout: string
  stderr: string
  ghCalls: string[]
}

const CAPTURE: Record<string, CapturedCase> = JSON.parse(
  readFileSync(path.join(FIXTURES, 'shepherd-status-output.json'), 'utf8'),
)

/** This file lists every place this port answers differently from the
 *  Python, as data. Layer 2's rule requires this
 *  (`tests/plugins/gh/fixtures/README.md`). A data list keeps each
 *  divergence countable. It also stops a ninth divergence. An edited
 *  literal here cannot add one. */
const DIVERGENCES: {
  notReplayed: Record<string, Record<string, { why: string; pinnedBy: string }>>
  sentences: { id: string; was: string; now: string; prefix?: string; cases: string[] }[]
} = JSON.parse(readFileSync(path.join(FIXTURES, 'divergences-shepherd.json'), 'utf8'))

const divergence = (id: string): { was: string; now: string; prefix?: string; cases: string[] } => {
  const row = DIVERGENCES.sentences.find((entry) => entry.id === id)
  if (row === undefined) throw new Error(`no divergence recorded as ${id}`)
  return row
}

/** Rules with no `pull_request` entry, as `requiredReviews` answers them. */
const NO_RULE = {
  reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
  unavailable: null,
}

/** What `gh repo view` answered with in the capture. */
const REPOSITORY = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }

/** This builds one `gh run list` row from a
 *  `"<seconds>[:<branch>[:<status>]]"` spec. It is the port of the capture
 *  script's `runs_file`, itself the port of the Python suite's `write_runs`.
 *  It moves the end stamp to set a run's wall time. */
const runRow = (spec: string): Record<string, unknown> => {
  const [seconds = '0', branch = 'main', status = 'completed'] = spec.split(':')
  const end = new Date((1767225600 + Number(seconds)) * 1000).toISOString()
  return {
    headBranch: branch,
    status,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: `${end.slice(0, 19)}Z`,
  }
}

/** These are the rows `gh run list --branch main --status completed` would
 *  answer with. The stub applies this filter server side, and the real `gh`
 *  applies it too. The example below this block checks that the command
 *  asks for it. */
const completedOnMain = (...specs: string[]): Record<string, unknown>[] =>
  specs.map(runRow).filter((row) => row.headBranch === 'main' && row.status === 'completed')

/** This builds the pair of writers a command reports through, over two
 *  buffers.
 *
 *  The `reader` argument replaces the stdout stream. This is how the test
 *  gives the command a reader that has left. `lib/streams.ts` owns the EPIPE
 *  guard itself. This file checks only the half above that guard. */
const capture = (reader?: (into: string[]) => OutputStream) => {
  const out: string[] = []
  const err: string[] = []
  const stream = (into: string[]): OutputStream => ({
    write(text: string) {
      into.push(text)
      return true
    },
    on() {
      return undefined
    },
  })
  return {
    output: createOutput((reader ?? stream)(out), stream(err)),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

/** This is a stdout stream whose reader leaves after the first line, the
 *  way `| head` does. The failure arrives as an event, not at the call. */
const closedPipe = (into: string[]): OutputStream => {
  let listener: ((error: NodeJS.ErrnoException) => void) | undefined
  return {
    write(text: string) {
      listener?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      into.push(text)
      return true
    },
    on(_event: 'error', handler: (error: NodeJS.ErrnoException) => void) {
      listener = handler
      return undefined
    },
  }
}

/** This applies the capture's `<sandbox>` vocabulary. It lets the test
 *  compare the port's output against the same words used to record the
 *  Python's output. */
const normalise = (text: string, sandbox: Sandbox): string => {
  let answer = text
  for (const root of new Set([sandbox.path, realpathSync(sandbox.path)])) {
    answer = answer.split(root).join('<sandbox>')
  }
  return answer
}

interface RunOptions {
  readonly argv: readonly string[]
  readonly gh?: GhClient
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  /** A stdout stream from the caller, for the reader that has left. */
  readonly reader?: (into: string[]) => OutputStream
}

/** This drives one command run. A sandbox holds one repository at the path
 *  the capture used, and the command runs against it. */
const drive = async (
  build: (sandbox: Sandbox, repo: string) => RunOptions,
): Promise<{
  status: number
  stdout: string
  stderr: string
  sandbox: Sandbox
  /** This is everything `createGh` was asked for, in order. `--repo` and the
   *  checkout path are construction options of the client (`lib/gh.ts`).
   *  They are not fields of any single request. So this field asserts the
   *  repository half of "the whole request" claim. The Python named `--repo`
   *  on both listings. It did not name `--repo` on the `gh repo view` call
   *  that resolves the repository (`gh-shepherd-status.py:104`, `:163`,
   *  `:185`). */
  ghOptions: readonly unknown[]
}> => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const options = build(sandbox, repo)
  const writers = capture(options.reader)
  const ghOptions: unknown[] = []
  const context: ShepherdContext = {
    cwd: repo,
    env: options.env ?? sandbox.env,
    output: writers.output,
    createGh: (target) => {
      ghOptions.push(target)
      return options.gh ?? createGhServer({ prs: [], replies: { viewRepository: REPOSITORY } })
    },
    now: options.now ?? (() => 0),
    // This command never reads the wall clock either.
    clock: () => {
      throw new Error('shepherd-status must not read the wall clock')
    },
    // This command never calls `sleep`. A timer here would create a promise
    // that never resolves, not a wait that nobody notices.
    sleep: async () => {
      throw new Error('shepherd-status must not sleep')
    },
  }
  const status = await runShepherdStatus(options.argv, context)
  return { status, stdout: writers.stdout(), stderr: writers.stderr(), sandbox, ghOptions }
}

/** These are the two clients this command builds. The first comes from the
 *  checkout alone: it is the call that answers what the repository IS. The
 *  second names both the checkout and the repository. That second client
 *  puts `--repo` on the two listings. */
const clients = (target: string): unknown[] => [
  { cwd: target },
  { cwd: target, repository: 'acme/widgets' },
]

// --- parity with the Python ---------------------------------------------------

/** This lists what each case needs beyond its captured pull-request set. It
 *  turns on the stub `gh`'s extra behavior, as registrations on this case's
 *  client. A case with no entry here answers from its rows alone. */
const ARRANGEMENTS: Record<string, GhServerOptions> = {
  gh_cannot_answer_for_the_repository: { fail: ghFails('gh: simulated failure') },
  gh_is_not_on_path: {
    // This port skips the `shutil.which` preflight (#158). When `gh` is not
    // on PATH, the runner reports exit code 127. The real client throws that
    // same error here.
    fail: ghFails('cannot run gh: spawn gh ENOENT', 127),
  },
  the_median_of_recent_run_durations: {
    replies: { listRuns: completedOnMain('30', '900', '60', '45', '50') },
  },
  only_completed_runs_on_the_default_branch: {
    replies: {
      listRuns: completedOnMain('40', '50', '60', '5000:main:in_progress', '6000:feature'),
    },
  },
  a_non_positive_duration_falls_back: { replies: { listRuns: completedOnMain('0') } },
  a_run_listing_that_is_unavailable: {
    // The Python pointed `GH_FIXTURE_RUNS` at a file that did not exist. The
    // stub then answered with no rows. The real `gh` answers a repository
    // with no Actions the same way. A `gh` that refuses the listing is the
    // case below.
    replies: { listRuns: [] },
  },
}

/** These are the cases that the command function cannot replay. The suite
 *  reads them from the divergence record instead of listing them here. Each
 *  entry carries why, and the example that pins the contract another way. */
const NOT_REPLAYED = new Set(Object.keys(DIVERGENCES.notReplayed['shepherd-status'] ?? {}))

const PATHS: Record<string, (sandbox: Sandbox, repo: string) => string> = {
  '<sandbox>/r/work': (_sandbox, repo) => repo,
  '<sandbox>/plain': (sandbox) => {
    const plain = sandbox.join('plain')
    mkdirSync(plain, { recursive: true })
    return plain
  },
  '<sandbox>/nope': (sandbox) => sandbox.join('nope'),
  '<sandbox>/closed': (sandbox) => {
    const closed = sandbox.join('closed')
    mkdirSync(closed, { recursive: true })
    chmodSync(closed, 0o000)
    return closed
  },
}

/** Root can enter a directory with no permissions. The Python's own skip
 *  says this (`test_shepherd_edges.py:374`). Neither venue that runs this
 *  suite is root. */
const asRoot = process.getuid?.() === 0

const replayable = Object.keys(CAPTURE).filter((name) => !NOT_REPLAYED.has(name))

/** This is the one case a run as root cannot prove. Root can enter a
 *  directory with no permissions, so the refusal never happens. */
const needsAUser = (name: string): boolean =>
  (CAPTURE[name] as CapturedCase).argv[0] === '<sandbox>/closed'

/** This split makes a root run report the case as skipped. That matches
 *  what the Python's own `skipif` did (`test_shepherd_edges.py:374`). A bare
 *  `return` inside the example would report a pass with nothing asserted.
 *  That would say the access probe ran when it did not. The hundred percent
 *  coverage gate is the second line of defense. Without this split, the
 *  refusal arm in `directoryRefusal` goes unreached, and the gate fails. */
const replayAlways = replayable.filter((name) => !needsAUser(name))
const replayAsAUser = replayable.filter(needsAUser)

const replay = async (name: string): Promise<void> => {
  const expected = CAPTURE[name] as CapturedCase

  const result = await drive((sandbox, repo) => ({
    // Every capture was recorded against the Python's own hardcoded
    // `dependencies` filter. This port sends no label unless one is given,
    // so the replay adds it here to keep the captured semantics: the same
    // rows, filtered the same way.
    argv: [
      ...expected.argv.map((argument) => (PATHS[argument] ?? (() => argument))(sandbox, repo)),
      'dependencies',
    ],
    gh: createGhServer({
      prs: expected.prs ?? [],
      ...ARRANGEMENTS[name],
      // These are the defaults the stub uses when a case turns nothing on.
      // The merge keeps them; it does not replace them. An arrangement that
      // registers one reply must not remove the two every case needs.
      // No capture recorded a review rule (#465), so each base has none.
      replies: {
        viewRepository: REPOSITORY,
        listRuns: [],
        requiredReviews: NO_RULE,
        ...ARRANGEMENTS[name]?.replies,
      },
    }),
  }))

  expect(result.status).toBe(expected.status)
  expect(normalise(result.stdout, result.sandbox)).toBe(expected.stdout)
  if (expected.argv[0] === '<sandbox>/closed') {
    // Node reports the refused access differently from Python. Python's own
    // message was `[Errno 13] Permission denied`. The sentence before it
    // stays the same; the divergence record supplies it. The line ends with
    // a newline and has some text after the colon.
    expect(normalise(result.stderr, result.sandbox)).toMatch(
      new RegExp(`^${divergence('cannotEnter').prefix}<sandbox>/closed: [^\\n]+\\n$`),
    )
  } else {
    expect(normalise(result.stderr, result.sandbox)).toBe(expected.stderr)
  }
}

it.each(replayAlways)('prints what the Python printed for %s', replay)
it.skipIf(asRoot).each(replayAsAUser)('prints what the Python printed for %s', replay)

it('has an arrangement for every case it replays, and replays every case', () => {
  // A case that lost its entry would replay against an empty `gh`. It would
  // then pass for the wrong reason. A case dropped from the capture would
  // simply go unchecked.
  expect(replayable.length + NOT_REPLAYED.size).toBe(Object.keys(CAPTURE).length)
  for (const name of Object.keys(ARRANGEMENTS)) {
    expect(Object.keys(CAPTURE)).toContain(name)
  }
})

// --- what the captured output does not prove -----------------------------------

it('prints its own usage for --help, naming the command rather than a script', async () => {
  const result = await drive(() => ({ argv: ['--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  expect(result.stdout).toContain('Usage:\n  shepherd.ts shepherd-status [path] [label]')
  expect(result.stderr).toBe('')
})

it('answers -h the same way it answers --help', async () => {
  const result = await drive(() => ({ argv: ['-h'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('takes the working directory as the target when none is given', async () => {
  // `context.cwd` is the checkout here. So an argv with no path still
  // reports on it. The default is the caller's directory, not this module's.
  let target = ''
  const result = await drive((_sandbox, repo) => {
    target = repo
    return {
      argv: [],
      gh: createGhServer({
        prs: [depPr(1)],
        replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
      }),
    }
  })

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).targets).toHaveLength(1)
  // Every call uses the directory it defaulted to.
  expect(result.ghOptions).toEqual(clients(target))
})

it('asks for every open pull request, with the window it reads, when no label is given', async () => {
  // This checks the whole request, not how many times it was sent. GitHub
  // applies the filters. So a query missing one filter would report a
  // different set of pull requests.
  const queries: unknown[] = []
  const server = createGhServer({
    prs: [],
    replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
  })

  let target = ''
  const result = await drive((_sandbox, repo) => {
    target = repo
    return {
      argv: [repo],
      gh: {
        ...server,
        listPullRequests: async (query) => {
          queries.push(query)
          return server.listPullRequests(query)
        },
      },
    }
  })

  expect(queries).toEqual([{ state: 'open', limit: 500 }])
  // This also checks the repository the query targets. `--repo` is not part
  // of the query; it is a property of the client that sends the query.
  expect(result.ghOptions).toEqual(clients(target))
})

it('passes the one label given through to the query', async () => {
  const queries: unknown[] = []
  const server = createGhServer({
    prs: [],
    replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
  })

  const result = await drive((_sandbox, repo) => ({
    argv: [repo, 'dependencies'],
    gh: {
      ...server,
      listPullRequests: async (query) => {
        queries.push(query)
        return server.listPullRequests(query)
      },
    },
  }))

  expect(queries).toEqual([{ state: 'open', label: 'dependencies', limit: 500 }])
  expect(result.status).toBe(0)
})

it('refuses a third argument, naming one label per run', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, 'dependencies', 'enhancement'],
    gh: createGhServer({
      prs: [],
      replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
    }),
  }))

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('one label per run\n')
})

it('answers --help in the second position, ahead of the too-many-arguments refusal', async () => {
  const result = await drive((_sandbox, repo) => ({ argv: [repo, '--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('answers --help in the third position too, ahead of the too-many-arguments refusal', async () => {
  // Three arguments alone are "one label per run" (refuse, exit 2). Help
  // must still win: the loop that looks for it runs over every position,
  // before the length check that would otherwise refuse this line.
  const result = await drive((_sandbox, repo) => ({ argv: [repo, 'dependencies', '--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('exits 1 when the open window saturates, and names the fix', async () => {
  // A repository with more open pull requests than the limit would
  // silently drop the oldest rows. `manyPrs`'s rows are MERGED, so this
  // builds its own OPEN set instead.
  const openPrs = Array.from({ length: 500 }, (_unused, index) => depPr(index + 1))
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: openPrs,
      replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
    }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'more than 500 open pull requests for acme/widgets; use a label to narrow the window\n',
  )
  expect(result.stdout).toBe('')
})

it('does not saturate one below the limit', async () => {
  const openPrs = Array.from({ length: 499 }, (_unused, index) => depPr(index + 1))
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: openPrs,
      replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
    }),
  }))

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).targets).toHaveLength(499)
})

it('asks for the completed runs on the default branch, with the sample size', async () => {
  const queries: unknown[] = []
  const server = createGhServer({
    prs: [],
    replies: { viewRepository: { ...REPOSITORY, defaultBranchRef: { name: 'trunk' } } },
  })

  let target = ''
  const result = await drive((_sandbox, repo) => {
    target = repo
    return {
      argv: [repo],
      gh: {
        ...server,
        listRuns: async (query) => {
          queries.push(query)
          return []
        },
      },
    }
  })

  expect(queries).toEqual([{ branch: 'trunk', status: 'completed', limit: 20 }])
  expect(result.ghOptions).toEqual(clients(target))
})

it.each([
  ['answered without one at all', { defaultBranchRef: { name: 'm' } }],
  // `view.get("nameWithOwner") or None` (`gh-shepherd-status.py:107`). A
  // repository named `""` means `gh` answered nothing. A null guard catches
  // this case.
  ['named the empty string', { nameWithOwner: '', defaultBranchRef: { name: 'm' } }],
])('refuses a repository gh %s', async (_name, view) => {
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({ prs: [], replies: { viewRepository: view } }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'could not resolve the repository with gh: gh answered without nameWithOwner\n',
  )
  expect(result.stdout).toBe('')
})

it.each([
  ['answered without one', { nameWithOwner: 'acme/widgets' }],
  // `(view.get("defaultBranchRef") or {}).get("name") or None`
  // (`gh-shepherd-status.py:108`). A branch named `""` is no branch at all.
  // The run listing would then go out with `--branch ""`.
  ['named the empty string', { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: '' } }],
])('refuses a repository whose default branch gh %s', async (_name, view) => {
  // Half an answer is not an answer. The run listing needs the branch name.
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({ prs: [], replies: { viewRepository: view } }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'could not resolve the repository with gh: gh answered without a default branch\n',
  )
})

it('refuses a default branch reference that is not an object', async () => {
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: [],
      replies: { viewRepository: { nameWithOwner: 'acme/widgets', defaultBranchRef: 'main' } },
    }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('gh answered without a default branch')
})

it('carries gh’s own words when the pull request listing fails', async () => {
  // A reason from `gh` and a bare exit code call for different next steps.
  // The words come from `GhError.detail`, never from the message, which
  // carries the argv.
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: [],
      replies: {
        viewRepository: REPOSITORY,
        listPullRequests: ghFails('HTTP 502: Bad gateway'),
      },
    }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'could not list pull requests for acme/widgets: HTTP 502: Bad gateway\n',
  )
  expect(result.stdout).toBe('')
})

it('puts gh’s words on one line when they arrived on several', async () => {
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: [],
      replies: {
        viewRepository: REPOSITORY,
        listPullRequests: ghFails('HTTP 502\n  Bad gateway\n'),
      },
    }),
  }))

  expect(result.stderr).toBe(
    'could not list pull requests for acme/widgets: HTTP 502 Bad gateway\n',
  )
})

it('falls back to 300 seconds when gh refuses the run listing', async () => {
  // A repo without Actions is normal, and the loop only needs a wait bound.
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: [],
      replies: { viewRepository: REPOSITORY, listRuns: ghFails('HTTP 502: Bad gateway') },
    }),
  }))

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).ci_seconds).toBe(300)
})

it('reports an internal error rather than a stack trace, and exits 3', async () => {
  // Exit 3 sits outside the documented set on purpose. A caller that parses
  // the JSON on stdout must not read a crash as an answer. The Python
  // provoked this: it made `os.path.isdir` raise. Here, the seam is the
  // client itself.
  const result = await drive(() => ({
    argv: [],
    gh: {
      ...createGhServer({ prs: [] }),
      viewRepository: async () => {
        throw new RangeError('boom')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(`${divergence('internalErrorStatus').now}RangeError: boom\n`)
  expect(result.status).toBe(CAPTURE.an_internal_error?.status)
  expect(result.stdout).toBe(CAPTURE.an_internal_error?.stdout)
  expect(CAPTURE.an_internal_error?.stderr).toContain(divergence('internalErrorStatus').was)
  expect(result.stdout).toBe('')
})

it('reports something that is not an Error at all as an internal error too', async () => {
  const result = await drive(() => ({
    argv: [],
    gh: {
      ...createGhServer({ prs: [] }),
      viewRepository: async () => {
        throw 'a string nobody should throw'
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(
    `${divergence('internalErrorStatus').now}string: a string nobody should throw\n`,
  )
})

it('lets a failure that is not gh’s out of the run listing’s fallback', async () => {
  // The fallback exists for a `gh` that does not answer. Anything else is a
  // defect in this process. If this code swallowed it, the report would
  // wrongly show a repository with no Actions.
  const result = await drive(() => ({
    argv: [],
    gh: {
      ...createGhServer({ prs: [], replies: { viewRepository: REPOSITORY } }),
      listRuns: async () => {
        throw new TypeError('not an array')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('internal error: TypeError: not an array')
})

// --- a reader that walked away ----------------------------------------------------------

it('lets a reader that left stop the report, and nothing else', async () => {
  // `test_shepherd_status.py:263` asserted the same composite for this
  // command too. The one document this command exists to print gets cut
  // off, and that cutoff is not an error. Round 1 pinned this pair for
  // `shepherd-pr` and left this command's version for later. This test
  // finishes that later work. It costs one extra writer.
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({
      prs: [depPr(1)],
      replies: { viewRepository: REPOSITORY, listRuns: [], requiredReviews: NO_RULE },
    }),
    reader: closedPipe,
  }))

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
})

// --- the review rules and --all (#465) --------------------------------------------------

/** The review rules of one base, as `requiredReviews` answers them. */
const rules = (
  approvals: number,
  flags: { threadResolution?: boolean; lastPush?: boolean } = {},
): GhResults['requiredReviews'] => ({
  reviews: { approvals, codeOwner: false, threadResolution: false, lastPush: false, ...flags },
  unavailable: null,
})

/** A pull request read with this many unresolved review threads. */
const detail = (unresolved: number): GhResults['viewPullRequestDetail'] => ({
  pullRequest: {
    number: 1,
    title: 'build(deps): bump dep-1',
    state: 'OPEN',
    draft: false,
    base: 'main',
    head: 'dep-1',
    headSha: 'sha1',
    mergeable: 'MERGEABLE',
    checks: [],
    unresolvedThreads: Array.from({ length: unresolved }, () => ({
      author: 'octocat',
      bot: false,
    })),
    commentAuthors: [],
  },
  unavailable: null,
  missing: false,
})

/** A run of `shepherd-status` with these arguments, over these pull
 *  requests, with `extra` as the endpoints that #465 added. */
const statusOf = (argv: readonly string[], prs: PullRequestRow[], extra: Partial<GhClient>) =>
  drive((_sandbox, repo) => ({
    argv: [repo, ...argv],
    gh: {
      ...createGhServer({ prs, replies: { viewRepository: REPOSITORY, listRuns: [] } }),
      ...extra,
    },
  }))

const numbers = (rows: { number: number }[]): number[] => rows.map((row) => row.number)

it('leaves out a pull request with no review when its base requires one', async () => {
  // Rule 15 (a) on #465.
  const result = await statusOf(['dependencies'], [depPr(1)], {
    requiredReviews: async () => rules(1),
  })

  expect(result.status).toBe(0)
  const document = JSON.parse(result.stdout)
  expect(document.targets).toEqual([])
  expect(document.not_ready).toEqual([
    {
      number: 1,
      title: 'build(deps): bump dep-1',
      author: 'app/dependabot',
      reasons: ['needs an approval'],
    },
  ])
})

it('makes the same pull request a target with --all, in any position, beside a label', async () => {
  // Rule 15 (b) and (i) on #465.
  for (const argv of [
    ['--all', 'dependencies'],
    ['dependencies', '--all'],
  ]) {
    const queries: unknown[] = []
    const server = createGhServer({
      prs: [depPr(1)],
      replies: { viewRepository: REPOSITORY, listRuns: [] },
    })
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, ...argv],
      gh: {
        ...server,
        requiredReviews: async () => rules(1),
        listPullRequests: async (query) => {
          queries.push(query)
          return server.listPullRequests(query)
        },
      },
    }))

    const document = JSON.parse(result.stdout)
    expect(numbers(document.targets)).toEqual([1])
    expect(document.targets[0].approval).toBe('missing')
    expect(document.not_ready).toEqual([])
    expect(queries).toEqual([{ state: 'open', label: 'dependencies', limit: 500 }])
  }
})

it('makes an approved pull request a target, with today’s output', async () => {
  // Rule 15 (c) on #465: one APPROVED review against a count of 1.
  const approved = {
    ...depPr(1),
    reviews: [{ author: { login: 'octocat' }, state: 'APPROVED', commit: { oid: 'sha1' } }],
  }
  const result = await statusOf([], [approved], { requiredReviews: async () => rules(1) })

  const document = JSON.parse(result.stdout)
  expect(numbers(document.targets)).toEqual([1])
  expect(document.targets[0].approval).toBe('met')
})

it('refuses a second label beside --all, and any other flag', async () => {
  const label = await drive((_sandbox, repo) => ({
    argv: [repo, 'dependencies', '--all', 'enhancement'],
  }))
  expect(label.status).toBe(2)
  expect(label.stderr).toBe('one label per run\n')

  const flag = await drive((_sandbox, repo) => ({ argv: [repo, '--dry-run'] }))
  expect(flag.status).toBe(2)
  expect(flag.stdout).toBe('')
  expect(flag.stderr).toBe('unknown flag: --dry-run\n')

  // One dash is a flag too, not a label.
  const short = await drive((_sandbox, repo) => ({ argv: [repo, '-x'] }))
  expect(short.status).toBe(2)
  expect(short.stderr).toBe('unknown flag: -x\n')
})

it('reads the rules of each base, and judges each pull request by its own', async () => {
  // Rule 15 (h) on #465: the answer differs by branch, so a pull request
  // judged by the rules of the other base would land on the other side.
  const prs = [depPr(1), { ...depPr(2), baseRefName: 'release' }]
  const result = await statusOf([], prs, {
    requiredReviews: async ({ branch }) => (branch === 'main' ? rules(1) : rules(0)),
  })

  const document = JSON.parse(result.stdout)
  expect(numbers(document.targets)).toEqual([2])
  expect(numbers(document.not_ready)).toEqual([1])
  expect(document.targets[0].approval).toBe('not_required')
})

it('falls back to reviewDecision when the rules cannot be read, and names the branch', async () => {
  // Rule 15 (g) on #465 and ruling 5.
  const result = await statusOf([], [depPr(1), depPr(2, { review: 'REVIEW_REQUIRED' })], {
    requiredReviews: async () => ({ reviews: null, unavailable: 'gh: HTTP 502' }),
  })

  expect(result.status).toBe(0)
  const document = JSON.parse(result.stdout)
  expect(numbers(document.targets)).toEqual([1])
  expect(document.targets[0].approval).toBeNull()
  expect(numbers(document.not_ready)).toEqual([2])
  expect(result.stderr).toBe(
    'the review rules of main are unavailable: gh: HTTP 502; approval rests on reviewDecision\n',
  )
})

it('leaves out a pull request with unresolved threads when its base asks', async () => {
  const approved = {
    ...depPr(1),
    reviews: [{ author: { login: 'octocat' }, state: 'APPROVED', commit: { oid: 'sha1' } }],
  }
  const result = await statusOf([], [approved], {
    requiredReviews: async () => rules(1, { threadResolution: true }),
    viewPullRequestDetail: async () => detail(5),
  })

  const document = JSON.parse(result.stdout)
  expect(document.targets).toEqual([])
  expect(document.not_ready[0].reasons).toEqual(['has unresolved review threads'])
})

it('names both reasons for a pull request with no approval and open threads', async () => {
  const result = await statusOf([], [depPr(1)], {
    requiredReviews: async () => rules(1, { threadResolution: true }),
    viewPullRequestDetail: async () => detail(1),
  })

  expect(JSON.parse(result.stdout).not_ready[0].reasons).toEqual([
    'needs an approval',
    'has unresolved review threads',
  ])
})

it('keeps a pull request whose threads cannot be read, and says why', async () => {
  const result = await statusOf([], [depPr(1)], {
    requiredReviews: async () => rules(0, { threadResolution: true }),
    viewPullRequestDetail: async () => ({
      pullRequest: null,
      unavailable: 'gh: HTTP 502',
      missing: false,
    }),
  })

  const document = JSON.parse(result.stdout)
  expect(numbers(document.targets)).toEqual([1])
  expect(document.targets[0].threads).toBeNull()
  expect(result.stderr).toBe(
    'the review threads of #1 cannot be proven resolved: gh: HTTP 502; threads is null\n',
  )
})

it('reads a short thread page with no unresolved thread as unread', async () => {
  // More threads can be past the page, so zero is not proof.
  const result = await statusOf([], [depPr(1)], {
    requiredReviews: async () => rules(0, { threadResolution: true }),
    viewPullRequestDetail: async () => ({ ...detail(0), unavailable: 'more review threads' }),
  })

  expect(JSON.parse(result.stdout).targets[0].threads).toBeNull()
  expect(result.stderr).toContain('the review threads of #1 cannot be proven resolved')
})

it('reads the threads of each pull request by its own number', async () => {
  const prs = [depPr(1), depPr(2)]
  const result = await statusOf([], prs, {
    requiredReviews: async () => rules(0, { threadResolution: true }),
    viewPullRequestDetail: async ({ pullRequest }) => detail(pullRequest === 2 ? 3 : 0),
  })

  const document = JSON.parse(result.stdout)
  expect(numbers(document.targets)).toEqual([1])
  expect(numbers(document.not_ready)).toEqual([2])
})

it('keeps unresolved threads unresolved when the same read reports a problem', async () => {
  // A thread found is proof, whatever else the read missed.
  const result = await statusOf([], [depPr(1)], {
    requiredReviews: async () => rules(0, { threadResolution: true }),
    viewPullRequestDetail: async () => ({ ...detail(2), unavailable: 'more checks' }),
  })

  const document = JSON.parse(result.stdout)
  expect(document.targets).toEqual([])
  expect(document.not_ready[0].reasons).toEqual(['has unresolved review threads'])
})

it('reads resolved threads as resolved, and asks for no threads when the rule does not', async () => {
  const resolved = await statusOf([], [depPr(1)], {
    requiredReviews: async () => rules(0, { threadResolution: true }),
    viewPullRequestDetail: async () => detail(0),
  })
  expect(JSON.parse(resolved.stdout).targets[0].threads).toBe('resolved')

  // No `viewPullRequestDetail` is registered, so a read here would throw
  // and exit 3.
  const unasked = await statusOf([], [depPr(1)], { requiredReviews: async () => rules(0) })
  expect(unasked.status).toBe(0)
  expect(JSON.parse(unasked.stdout).targets[0].threads).toBe('not_required')
})
