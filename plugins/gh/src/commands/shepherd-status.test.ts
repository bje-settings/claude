// `gh.ts shepherd-status`, against the Python's own captured output: the port
// of `tests/gh/test_shepherd_status.py` and of the `gh-shepherd-status.py`
// half of `test_shepherd_edges.py`.
//
// The parity block is the contract. Every case in
// `fixtures/shepherd-status-output.json` is replayed here from the same canned
// pull-request set the Python's stub `gh` answered from, and the document,
// stderr and exit status are compared with what the Python printed, byte for
// byte, with only the divergences `fixtures/README-shepherd.md` records. The
// examples after it are the claims the captured output alone does not prove:
// which query the command actually sent, and what it does when something that
// is not `gh` goes wrong.
//
// git is real (`harness/git.ts`), `gh` is the injected client
// (`harness/pulls.ts`), and the sandbox's repository is built at the same path
// the capture ran in, so the two sets of paths line up with no rewriting.
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { type GhClient, ghFails } from '../../../../harness/gh.ts'
import { createGitFixtures } from '../../../../harness/git.ts'
import {
  createGhServer,
  depPr,
  type GhServerOptions,
  type PullRequestRow,
} from '../../../../harness/pulls.ts'
import { createSandbox, type Sandbox } from '../../../../harness/sandbox.ts'
import { createOutput, type OutputStream } from '../lib/streams.ts'
import type { ShepherdContext } from '../shepherd.ts'
import { HELP, runShepherdStatus } from './shepherd-status.ts'

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

/** Every place this port answers differently from the Python, as data: layer
 *  2's rule (`fixtures/README.md`), so a divergence stays countable and a
 *  ninth cannot appear by editing a literal here. */
const DIVERGENCES: {
  notReplayed: Record<string, Record<string, { why: string; pinnedBy: string }>>
  sentences: { id: string; was: string; now: string; prefix?: string; cases: string[] }[]
} = JSON.parse(readFileSync(path.join(FIXTURES, 'divergences-shepherd.json'), 'utf8'))

const divergence = (id: string): { was: string; now: string; prefix?: string; cases: string[] } => {
  const row = DIVERGENCES.sentences.find((entry) => entry.id === id)
  if (row === undefined) throw new Error(`no divergence recorded as ${id}`)
  return row
}

/** What `gh repo view` answered with in the capture. */
const REPOSITORY = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }

/** One `gh run list` row from a `"<seconds>[:<branch>[:<status>]]"` spec: the
 *  port of the capture script's `runs_file`, which is the port of the Python
 *  suite's `write_runs`. A run's wall time is expressed by moving the end
 *  stamp. */
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

/** The rows `gh run list --branch main --status completed` would answer with,
 *  which is the filter the stub applied server-side and the real gh applies
 *  too. The example below this block asserts that the command asks for it. */
const completedOnMain = (...specs: string[]): Record<string, unknown>[] =>
  specs.map(runRow).filter((row) => row.headBranch === 'main' && row.status === 'completed')

/** The pair of writers a command reports through, over two buffers. */
const capture = () => {
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
    output: createOutput(stream(out), stream(err)),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

/** The capture's `<sandbox>` vocabulary, so the port's output is compared in
 *  the same words the Python's was recorded in. */
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
}

/** A sandbox holding one repository at the path the capture used, and the
 *  command run against it. */
const drive = async (
  build: (sandbox: Sandbox, repo: string) => RunOptions,
): Promise<{ status: number; stdout: string; stderr: string; sandbox: Sandbox }> => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const options = build(sandbox, repo)
  const writers = capture()
  const context: ShepherdContext = {
    cwd: repo,
    env: options.env ?? sandbox.env,
    output: writers.output,
    createGh: () =>
      options.gh ?? createGhServer({ prs: [], replies: { viewRepository: REPOSITORY } }),
    now: options.now ?? (() => 0),
    // Never called by this command; a timer here would be a promise nothing
    // resolves rather than a wait nobody notices.
    sleep: async () => {
      throw new Error('shepherd-status must not sleep')
    },
  }
  const status = await runShepherdStatus(options.argv, context)
  return { status, stdout: writers.stdout(), stderr: writers.stderr(), sandbox }
}

// --- parity with the Python ---------------------------------------------------

/** What each case needs beyond its captured pull-request set: the stub `gh`
 *  switches the case's environment turned on, as this client's registrations.
 *  A case with no entry is answered from its rows alone. */
const ARRANGEMENTS: Record<string, GhServerOptions> = {
  gh_cannot_answer_for_the_repository: { fail: ghFails('gh: simulated failure') },
  gh_is_not_on_path: {
    // No `shutil.which` preflight is ported (#158): gh not being on PATH is
    // the runner's 127, which is what the real client throws here.
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
    // The Python pointed GH_FIXTURE_RUNS at a file that was not there and the
    // stub answered with no rows; the real gh answers a repository with no
    // Actions the same way, and a gh that refuses the listing is the case
    // below.
    replies: { listRuns: [] },
  },
}

/** The cases that cannot be replayed through the command function, read from
 *  the divergence record rather than listed here: each carries why, and the
 *  example that pins the contract another way. */
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

/** Root can enter a directory with no permissions, which is what the Python's
 *  own skip says (`test_shepherd_edges.py:374`). Neither venue this suite runs
 *  in is root. */
const asRoot = process.getuid?.() === 0

const replayable = Object.keys(CAPTURE).filter((name) => !NOT_REPLAYED.has(name))

/** The one case a run as root cannot prove: root can enter a directory with
 *  no permissions, so the refusal never happens. */
const needsAUser = (name: string): boolean =>
  (CAPTURE[name] as CapturedCase).argv[0] === '<sandbox>/closed'

/** Split so that a root run REPORTS the case as skipped, which is what the
 *  Python's own `skipif` did (`test_shepherd_edges.py:374`). A bare `return`
 *  inside the example reported a pass with nothing asserted in it, which says
 *  the access probe was checked when it was not. The hundred percent coverage
 *  gate is the second line of defence: the refusal arm in `directoryRefusal`
 *  then goes unreached and the gate fails. */
const replayAlways = replayable.filter((name) => !needsAUser(name))
const replayAsAUser = replayable.filter(needsAUser)

const replay = async (name: string): Promise<void> => {
  const expected = CAPTURE[name] as CapturedCase

  const result = await drive((sandbox, repo) => ({
    argv: expected.argv.map((argument) => (PATHS[argument] ?? (() => argument))(sandbox, repo)),
    gh: createGhServer({
      prs: expected.prs ?? [],
      ...ARRANGEMENTS[name],
      // The defaults the stub answered with when the case turned nothing on,
      // merged rather than replaced: an arrangement that registers one reply
      // must not unregister the two every case needs.
      replies: {
        viewRepository: REPOSITORY,
        listRuns: [],
        ...ARRANGEMENTS[name]?.replies,
      },
    }),
  }))

  expect(result.status).toBe(expected.status)
  expect(normalise(result.stdout, result.sandbox)).toBe(expected.stdout)
  if (expected.argv[0] === '<sandbox>/closed') {
    // node's account of the refused access where Python's was
    // `[Errno 13] Permission denied`; the sentence in front of it is the
    // same, and is read from the divergence record. One line, ending in a
    // newline, saying something after the colon.
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
  // A case that lost its entry would otherwise be replayed against an empty
  // gh and pass for the wrong reason, and a case dropped from the capture
  // would simply stop being checked.
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
  expect(result.stdout).toContain('Usage:\n  gh.ts shepherd-status [path]')
  expect(result.stderr).toBe('')
})

it('answers -h the same way it answers --help', async () => {
  const result = await drive(() => ({ argv: ['-h'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('takes the working directory as the target when none is given', async () => {
  // `context.cwd` is the checkout here, so an argv with no path at all still
  // reports on it: the default is the caller's directory, not this module's.
  const result = await drive(() => ({
    argv: [],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY, listRuns: [] } }),
  }))

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).targets).toHaveLength(1)
})

it('asks for the open dependencies pull requests, with the window it reads', async () => {
  // The whole request, rather than how many times it was sent: the filters are
  // applied by GitHub, so a query that lost one would report on a different
  // set of pull requests entirely.
  const queries: unknown[] = []
  const server = createGhServer({
    prs: [],
    replies: { viewRepository: REPOSITORY, listRuns: [] },
  })

  await drive(() => ({
    argv: [],
    gh: {
      ...server,
      listPullRequests: async (query) => {
        queries.push(query)
        return server.listPullRequests(query)
      },
    },
  }))

  expect(queries).toEqual([{ state: 'open', label: 'dependencies', limit: 100 }])
})

it('asks for the completed runs on the default branch, with the sample size', async () => {
  const queries: unknown[] = []
  const server = createGhServer({
    prs: [],
    replies: { viewRepository: { ...REPOSITORY, defaultBranchRef: { name: 'trunk' } } },
  })

  await drive(() => ({
    argv: [],
    gh: {
      ...server,
      listRuns: async (query) => {
        queries.push(query)
        return []
      },
    },
  }))

  expect(queries).toEqual([{ branch: 'trunk', status: 'completed', limit: 20 }])
})

it.each([
  ['answered without one at all', { defaultBranchRef: { name: 'm' } }],
  // `view.get("nameWithOwner") or None` (`gh-shepherd-status.py:107`): a
  // repository named `""` is gh answering nothing, and a null guard takes it.
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
  // (`gh-shepherd-status.py:108`): a branch named `""` is no branch, and the
  // run listing would go out with `--branch ""`.
  ['named the empty string', { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: '' } }],
])('refuses a repository whose default branch gh %s', async (_name, view) => {
  // Half an answer is not an answer: the run listing needs the branch name.
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
  // A reason gh gave and a bare exit code call for different next steps, and
  // the words are `GhError.detail`, never the message, which carries the argv.
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
  // Exit 3 is outside the documented set on purpose: a caller parsing the JSON
  // on stdout must not read a crash as an answer. The Python provoked this by
  // making `os.path.isdir` raise; here the seam is the client itself.
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
  // The fallback is for a gh that would not answer. Anything else is a defect
  // in this process, and swallowing it would report a repository with no
  // Actions.
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
