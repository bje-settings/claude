// This file tests `gh.ts shepherd-pr` against the Python version's captured
// output. It ports `tests/gh/test_shepherd_pr.py` and the `gh-shepherd-pr.py`
// half of `test_shepherd_edges.py`.
//
// The parity block is the contract. Each case in
// `fixtures/shepherd-pr-output.json` replays the same canned pull-request set
// that the Python's stub `gh` answered. The test compares the JSON document,
// stderr, and exit status against what the Python printed, byte for byte.
// Only the divergences in `fixtures/README-shepherd.md` differ.
//
// The examples after the parity block cover cases that one captured run
// cannot show. One is an answer that changes between two polls: the rollup,
// or the compare of the base and the head (#460). Another is a failure that
// is not a refusal by gh.
//
// **No test waits.** The clock and the sleep are arguments. `fakeTime`
// advances the clock by the exact amount each sleep requests. A 90 second
// settle bound reaches its end at once. `waited` is a number this file set,
// not a number a machine measured.
//
// **Issue #127 deleted the Python this ports.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from the
// tree. The file and line references below point to what those files held at
// `cd0d515`. Each reference stays because it says where a rule came from.
import { chmodSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { createOutput, type OutputStream } from '#gh/lib/streams.ts'
import type { ShepherdContext } from '#gh/shepherd.ts'
import { HELP, runShepherdPr } from '#gh/subcommands/shepherd-pr.ts'
import { type GhClient, type GhResults, ghFails } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createGhServer, depPr, type GhServerOptions, type PullRequestRow } from '#harness/pulls.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export interface CapturedCase {
  argv: string[]
  env: Record<string, string>
  prs: PullRequestRow[] | null
  status: number
  stdout: string
  stderr: string
  ghCalls: string[]
}

export const CAPTURE: Record<string, CapturedCase> = JSON.parse(
  readFileSync(path.join(FIXTURES, 'shepherd-pr-output.json'), 'utf8'),
)

/**
 * Every place this port answers differently from the Python, as data.
 *
 * Layer 2's rule (`fixtures/README.md`) records a divergence where a test
 * reads it. This keeps divergences countable. A literal edited here cannot
 * add a ninth divergence.
 */

/**
 * The list of cases not replayed comes from that file. So do the two
 * sentences this file asserts. Neither comes from a constant beside them.
 */
export const DIVERGENCES: {
  notReplayed: Record<string, Record<string, { why: string; pinnedBy: string }>>
  sentences: { id: string; was: string; now: string; prefix?: string; cases: string[] }[]
  unchanged: { line: string; cases: string[] }
} = JSON.parse(readFileSync(path.join(FIXTURES, 'divergences-shepherd.json'), 'utf8'))

/** One recorded divergence, by the name it carries in that file. */
export const divergence = (
  id: string,
): { was: string; now: string; prefix?: string; cases: string[] } => {
  const row = DIVERGENCES.sentences.find((entry) => entry.id === id)
  if (row === undefined) throw new Error(`no divergence recorded as ${id}`)
  return row
}

/**
 * The capture recorded four fields as measurements, not as a contract:
 * `waited`, `watcher_rc`, `reads_ok`, and `read_failures`.
 */

/**
 * Nothing skips these four fields, and no list keeps them in step. The Python
 * measured them on the machine that ran the capture. The injected clock here
 * produces the same numbers. That is why this port uses an injected clock.
 * The test then compares the whole document byte for byte, like every other
 * key. A key that lost reproducibility would turn the comparison red, not
 * quietly join a list.
 */

/** What `gh repo view` answered with in the capture. */
export const REPOSITORY = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }

/** What `gh pr update-branch` prints when GitHub accepted the request. */
export const UPDATED = '✓ Pull request #1 branch has been updated\n'

/** A compare with this status, as `compareCommits` answers it. */
export const compared = (
  status: 'ahead' | 'behind' | 'diverged' | 'identical',
): GhResults['compareCommits'] => ({
  comparison: { status, files: [], filesAtLimit: false },
  unavailable: null,
})

/** A head that holds the tip of its base. Each replay answers the compare
 *  with this, so the captured pull requests read `behind: false`. */
export const AHEAD = compared('ahead')

/** A compare GitHub would not answer. `compareCommits` never throws. */
export const UNAVAILABLE: GhResults['compareCommits'] = {
  comparison: null,
  unavailable: 'gh api compare failed: HTTP 502',
}

/**
 * `gh`, with the compare answered from `replies` in order. The last reply
 * repeats.
 *
 * `createGhServer` takes a sequence only for the endpoints it routes, and
 * the compare is not one of them. So this wraps the server, as
 * {@link recording} does. The poll in `wait` needs a base that moves
 * between two reads.
 */
export const comparing = (
  options: GhServerOptions,
  replies: readonly GhResults['compareCommits'][],
): GhClient => {
  const server = createGhServer(options)
  let taken = 0
  return {
    ...server,
    compareCommits: async () => {
      const reply = replies[Math.min(taken, replies.length - 1)] as GhResults['compareCommits']
      taken += 1
      return reply
    },
  }
}

/** A clock that moves only when something sleeps. A bound then arrives
 *  without a real wait. */
export const fakeTime = (): {
  now: () => number
  sleep: (ms: number) => Promise<void>
  at: () => number
} => {
  let elapsed = 0
  return {
    now: () => elapsed,
    sleep: async (milliseconds: number) => {
      elapsed += milliseconds
    },
    at: () => elapsed,
  }
}

/** The pair of writers a command reports through, over two buffers.
 *
 *  `reader` replaces the stdout stream. This models a reader that walks away.
 *  `lib/streams.ts` owns the writer's own EPIPE guard. This test asserts only
 *  the layer above that guard: the action's write already happened. */
export const capture = (reader?: (into: string[]) => OutputStream) => {
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

export const normalise = (text: string, sandbox: Sandbox): string => {
  let answer = text
  for (const root of new Set([sandbox.path, realpathSync(sandbox.path)])) {
    answer = answer.split(root).join('<sandbox>')
  }
  return answer
}

export interface RunOptions {
  readonly argv: readonly string[]
  readonly gh?: GhClient
  readonly env?: NodeJS.ProcessEnv
  /** A stdout stream of the caller's own, for the reader that went away. */
  readonly reader?: (into: string[]) => OutputStream
}

export interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly document: Record<string, unknown>
  readonly sandbox: Sandbox
  readonly elapsed: number
  /** Every argument passed to `createGh`, in order. In this port, `--repo`
   *  is not part of any request object. It is a construction option of the
   *  client (`lib/gh.ts`). So this test asserts the repository half of the
   *  whole request here, or nowhere else. The Python put `--repo self.repo`
   *  on every call but the one that resolves it (`gh-shepherd-pr.py:483`,
   *  `:538`, `:928`, against `:958`). */
  readonly ghOptions: readonly unknown[]
}

/** A sandbox that holds one repository, at the path the capture used. The
 *  test runs the command against it, with a clock nobody has to wait for. */
export const drive = async (
  build: (sandbox: Sandbox, repo: string) => RunOptions,
): Promise<RunResult> => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const options = build(sandbox, repo)
  const writers = capture(options.reader)
  const time = fakeTime()
  const gh = options.gh ?? createGhServer({ replies: { viewRepository: REPOSITORY } })
  const ghOptions: unknown[] = []
  const context: ShepherdContext = {
    cwd: repo,
    env: options.env ?? sandbox.env,
    output: writers.output,
    createGh: (target) => {
      ghOptions.push(target)
      return gh
    },
    now: time.now,
    sleep: time.sleep,
  }
  const status = await runShepherdPr(options.argv, context)
  const stdout = writers.stdout()
  return {
    status,
    stdout,
    stderr: writers.stderr(),
    // The usage text is the one answer that is not a JSON document.
    document: stdout.startsWith('{') ? JSON.parse(stdout) : {},
    sandbox,
    elapsed: time.at(),
    ghOptions,
  }
}

/** Every action builds two clients. The first uses the checkout alone, and
 *  its call answers what the repository IS. The second names both the
 *  checkout and that repository. This second client is what puts `--repo` on
 *  every later call. */
export const clients = (target: string): unknown[] => [
  { cwd: target },
  { cwd: target, repository: 'acme/widgets' },
]

/** The environment a case ran under, minus the variables that drove the stub
 *  `gh` rather than the command. */
export const shepherdEnv = (sandbox: Sandbox, env: Record<string, string>): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  ...Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('SHEPHERD_'))),
})

/**
 * A server that records what the one write, the branch update, sends.
 *
 * The write this command makes is its whole reason to exist. A captured
 * run cannot show its arguments. The capture records what the Python's
 * stub `gh` received, while this port reaches `gh` through the injected
 * client instead. So this test asserts the request here, in full, the way
 * `shepherd-status.test.ts` asserts the two listings it sends.
 */
export const recording = (options: GhServerOptions): { gh: GhClient; updates: unknown[] } => {
  const server = createGhServer(options)
  const updates: unknown[] = []
  return {
    updates,
    gh: {
      ...server,
      updateBranch: async (pull) => {
        updates.push(pull)
        return server.updateBranch(pull)
      },
    },
  }
}

// --- parity with the Python ----------------------------------------------------

/** ARRANGEMENTS holds what each case needs beyond its captured pull-request
 *  set. This is the registrations for the stub `gh`, matched to what the
 *  case's environment turns on. The stub `gh` answers a case with no entry
 *  from its rows alone. */

/** A REFUSAL case deliberately registers no write endpoint. This is how the
 *  test proves there is no write on a refusal. If nobody registers an
 *  endpoint, `createGhServer` throws `no reply registered for <endpoint>`.
 *  `ghAccount` rethrows anything that is not a `GhError`. Then the run ends
 *  as an internal error, with a status the capture does not hold. */

/** A guard moved below its write turns the case red. This ports the
 *  Python's eleven `comments(gh) == "NONE"` and `"update-branch" not in
 *  call_log` assertions (`test_shepherd_pr.py:321`, `:332`, `:353`, `:360`,
 *  `:676`, `:869`, `:1021`, `:1041`, `:1050`, `:1058`,
 *  `test_shepherd_edges.py:410`). */
export const ARRANGEMENTS: Record<string, GhServerOptions> = {
  gh_cannot_resolve_the_repository: { fail: ghFails('gh: simulated failure') },
  // This port does not include the `shutil.which` preflight (#158). When gh
  // is not on PATH, the runner throws 127, and the real client throws the
  // same error.
  gh_is_not_on_path: { fail: ghFails('cannot run gh: spawn gh ENOENT', 127) },
  rebase_moves_the_head: {
    replies: { updateBranch: UPDATED },
    // The stub rewrote the row it held. A sequence states the same fact
    // without a file to rewrite.
    sequences: {
      viewPullRequest: [
        depPr(1, { merge: 'BEHIND' }),
        depPr(1, { merge: 'BLOCKED', head: 'rebased-sha1' }),
      ],
    },
  },
  rebase_reports_an_update_that_has_only_been_queued: { replies: { updateBranch: UPDATED } },
  rebase_reports_a_branch_that_was_already_up_to_date: {
    replies: { updateBranch: '✓ Pull request #1 already up-to-date with base branch\n' },
  },
  rebase_reports_a_failure_without_a_new_head: {
    replies: {
      updateBranch: ghFails(
        'GraphQL: merge conflict between base and head (updatePullRequestBranch)',
      ),
    },
  },
  wait_answers_failed_and_carries_the_log_tail: {
    replies: { readFailedRunLog: 'line 1\nline 2\nline 3\n' },
  },
  wait_keeps_only_the_requested_number_of_log_lines: {
    replies: { readFailedRunLog: 'line 1\nline 2\nline 3\n' },
  },
  wait_walks_past_a_failing_row_that_is_not_an_actions_job: {
    replies: { readFailedRunLog: 'the failing step\n' },
  },
}

/** USAGE_TEXT maps each such case to what comes in front of the usage text.
 *  Each case's stderr ends in this command's own usage text. That usage text
 *  names `gh.ts shepherd-pr`, where the Python named a script file. The test
 *  compares both halves: the line, against the Python's own, and the usage,
 *  against this command's. */
export const USAGE_TEXT = new Map([
  ['usage_with_too_few_arguments', ''],
  ['an_unknown_action', 'unknown action: dance\n'],
])

/** The cases that the command function cannot replay. This set comes from
 *  the divergence record, not from a list here. Each case carries why, and
 *  names the example that pins the contract another way. */
export const NOT_REPLAYED = new Set(Object.keys(DIVERGENCES.notReplayed['shepherd-pr'] ?? {}))

/** What a case's positional argument held, for a case that names a reason
 *  file. #216 deleted the one case that used it (`skip`'s reason file), and
 *  the `PATHS` builder that read it. Nothing reads this map today. It stays
 *  empty only so the parity test's existence check still lists it. A future
 *  case that names a reason file needs its own `PATHS` builder too. */
export const REASONS: Record<string, string> = {}

export const PATHS: Record<string, (sandbox: Sandbox, repo: string, name: string) => string> = {
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
 *  note says the same thing (`test_shepherd_edges.py:387`). Neither venue
 *  that runs this suite is root. */
export const asRoot = process.getuid?.() === 0

export const replayable = Object.keys(CAPTURE).filter((name) => !NOT_REPLAYED.has(name))

/** A run as root cannot prove one case. Root can enter a directory with no
 *  permissions, so the refusal never happens. */
export const needsAUser = (name: string): boolean =>
  (CAPTURE[name] as CapturedCase).argv[0] === '<sandbox>/closed'

/** This test splits the cases so a root run reports one as skipped. This
 *  matches what the Python's own `skipif` did (`test_shepherd_edges.py:387`).
 *  A bare `return` inside the example would report a pass with nothing
 *  asserted. That would wrongly claim the example checked the access probe
 *  when it did not. The hundred percent coverage gate is the second line of
 *  defence. If the refusal arm in `directoryRefusal` goes unreached, the gate
 *  fails. */
export const replayAlways = replayable.filter((name) => !needsAUser(name))

export const replayAsAUser = replayable.filter(needsAUser)

/** `replayAlways` in two halves, one for each parity file, so that the two
 *  halves run at the same time. Together they are all of `replayAlways`. */
const half = Math.ceil(replayAlways.length / 2)
export const replayFirstHalf = replayAlways.slice(0, half)
export const replaySecondHalf = replayAlways.slice(half)

export const replay = async (name: string): Promise<void> => {
  const expected = CAPTURE[name] as CapturedCase

  const result = await drive((sandbox, repo) => ({
    argv: expected.argv.map((argument) =>
      (PATHS[argument] ?? (() => argument))(sandbox, repo, name),
    ),
    env: shepherdEnv(sandbox, expected.env),
    gh: createGhServer({
      prs: expected.prs ?? [],
      ...ARRANGEMENTS[name],
      // Merged rather than replaced: an arrangement that registers one reply
      // must not unregister the one every case needs.
      // The compare is #460's, so no capture registers it. Every captured
      // head holds the tip of its base.
      replies: {
        viewRepository: REPOSITORY,
        compareCommits: AHEAD,
        ...ARRANGEMENTS[name]?.replies,
      },
    }),
  }))

  expect(result.status).toBe(expected.status)
  expect(normalise(result.stdout, result.sandbox)).toBe(expected.stdout)
  const before = USAGE_TEXT.get(name)
  if (before !== undefined) {
    // The Python printed its own docstring here, which named a script file.
    // The test compares two things for the same reason. It checks the line
    // in front of the usage against the Python's own. It checks the usage
    // itself against this command's.
    expect(expected.stderr.startsWith(before)).toBe(true)
    expect(result.stderr).toBe(`${before}${HELP}\n`)
  } else if (expected.argv[0] === '<sandbox>/closed') {
    // Node reports the refused access differently from Python's
    // `[Errno 13] Permission denied`. The sentence in front of it stays the
    // same. That sentence comes from the divergence record. The expected
    // text is one line that ends in a newline, with some text after the
    // colon. It matches everything from the Python's byte comparison, except
    // the OS error text itself.
    expect(normalise(result.stderr, result.sandbox)).toMatch(
      new RegExp(`^${divergence('cannotEnter').prefix}<sandbox>/closed: [^\\n]+\\n$`),
    )
  } else {
    expect(normalise(result.stderr, result.sandbox)).toBe(expected.stderr)
  }
}

// --- settle -------------------------------------------------------------------------

export const settleEnv = (sandbox: Sandbox, bound = '3', poll = '1'): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  SHEPHERD_SETTLE_BOUND: bound,
  SHEPHERD_SETTLE_POLL: poll,
})

// --- a reader that walked away ----------------------------------------------------------

/** stdout whose reader leaves on the first line, the way `| head` does. The
 *  failure arrives as an event, not at the call
 *  (`subcommands/sync-repo.worktrees.test.ts` uses the same shape). */
export const closedPipe = (into: string[]): OutputStream => {
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
