// `gh.ts shepherd-pr`, against the Python's own captured output: the port of
// `tests/gh/test_shepherd_pr.py` and of the `gh-shepherd-pr.py` half of
// `test_shepherd_edges.py`.
//
// The parity block is the contract. Every case in
// `fixtures/shepherd-pr-output.json` is replayed from the same canned
// pull-request set the Python's stub `gh` answered from, and the JSON
// document, stderr and exit status are compared with what the Python printed,
// byte for byte, with only the divergences `fixtures/README-shepherd.md`
// records. The examples after it are what a single captured run cannot show:
// an answer that CHANGES between two polls, a watcher that failed for a reason
// of its own, and a failure that is not `gh` refusing.
//
// **No test waits.** The clock and the sleep are arguments, and `fakeTime`
// advances the clock by exactly what each sleep was asked for, so a 90 second
// settle bound is driven to its end in no time at all and `waited` is a number
// this file decided rather than a number the machine happened to measure.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { type GhClient, ghFails, type WatchResult } from '../../../../harness/gh.ts'
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
import { HELP, runShepherdPr } from './shepherd-pr.ts'

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
  readFileSync(path.join(FIXTURES, 'shepherd-pr-output.json'), 'utf8'),
)

/**
 * Every place this port answers differently from the Python, as data.
 *
 * Layer 2's rule (`fixtures/README.md`): a divergence is recorded where a test
 * reads it, so it stays countable and a ninth cannot appear by editing a
 * literal in here. Which cases are not replayed, and the two sentences this
 * file asserts, come from that file rather than from a constant beside them.
 */
const DIVERGENCES: {
  notReplayed: Record<string, Record<string, { why: string; pinnedBy: string }>>
  sentences: { id: string; was: string; now: string; prefix?: string; cases: string[] }[]
  unchanged: { line: string; cases: string[] }
} = JSON.parse(readFileSync(path.join(FIXTURES, 'divergences-shepherd.json'), 'utf8'))

/** One recorded divergence, by the name it carries in that file. */
const divergence = (id: string): { was: string; now: string; prefix?: string; cases: string[] } => {
  const row = DIVERGENCES.sentences.find((entry) => entry.id === id)
  if (row === undefined) throw new Error(`no divergence recorded as ${id}`)
  return row
}

/**
 * The four fields the capture recorded as a measurement rather than as a
 * contract: `waited`, `watcher_rc`, `reads_ok` and `read_failures`.
 *
 * They are NOT skipped and there is no list of them to keep in step. The
 * Python measured them on the machine the capture ran on; here the injected
 * clock is made to produce the same numbers, which is what an injected clock
 * is for, so the whole document is compared byte for byte like every other
 * key. A key that stopped being reproducible would turn the comparison red
 * rather than quietly joining a list.
 */

/** What `gh repo view` answered with in the capture. */
const REPOSITORY = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }

/** What the stub printed for a comment it posted. */
const COMMENT_URL = 'https://github.com/acme/widgets/pull/1#issuecomment-1\n'

/** What `gh pr update-branch` prints when GitHub accepted the request. */
const UPDATED = '✓ Pull request #1 branch has been updated\n'

/** A watch that answered at once because the rollup was already pending, which
 *  is `gh pr checks` exit 8. */
const WATCH_PENDING: WatchResult = { status: 8, timedOut: false, waitedMs: 0, problem: '' }

/** A watch this command's own bound killed: no status of its own, and
 *  `timedOut` is the only thing that says what happened. */
const WATCH_BOUND: WatchResult = { status: null, timedOut: true, waitedMs: 1000, problem: '' }

/** A clock that only moves when something waits, so a bound is reached without
 *  any of it being waited out. */
const fakeTime = (): {
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
 *  `reader` replaces the stdout stream, which is how the reader that walked
 *  away is given to the command: the writer's own EPIPE guard is
 *  `lib/streams.ts`'s, and what is asserted here is the half above it, that
 *  the write the action already made still happened. */
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
  /** A stdout stream of the caller's own, for the reader that went away. */
  readonly reader?: (into: string[]) => OutputStream
}

interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly document: Record<string, unknown>
  readonly sandbox: Sandbox
  readonly elapsed: number
  /** Everything `createGh` was asked for, in order. `--repo` is not part of
   *  any request object in this port: it is a construction option of the
   *  client (`lib/gh.ts`), so the repository half of "the whole request" is
   *  asserted here or nowhere. The Python put `--repo self.repo` on every
   *  call but the one that resolves it (`gh-shepherd-pr.py:483`, `:538`,
   *  `:928`, against `:958`). */
  readonly ghOptions: readonly unknown[]
}

/** A sandbox holding one repository at the path the capture used, and the
 *  command run against it with a clock nobody has to wait for. */
const drive = async (build: (sandbox: Sandbox, repo: string) => RunOptions): Promise<RunResult> => {
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

/** The two clients every action builds: one from the checkout alone, which is
 *  the call that answers what the repository IS, and then one that names both
 *  the checkout and that repository, which is what puts `--repo` on every
 *  later call. */
const clients = (target: string): unknown[] => [
  { cwd: target },
  { cwd: target, repository: 'acme/widgets' },
]

/** The environment a case ran under, minus the variables that drove the stub
 *  `gh` rather than the command. */
const shepherdEnv = (sandbox: Sandbox, env: Record<string, string>): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  ...Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('SHEPHERD_'))),
})

/**
 * A server that keeps what each write was actually asked to send.
 *
 * The three writes this command makes are its whole reason to exist, and a
 * captured run cannot show their arguments: the capture records what the
 * Python's stub `gh` was given, and the port reaches `gh` through the injected
 * client instead. So the request is asserted here, whole, the way
 * `shepherd-status.test.ts` asserts the two listings it sends. What was sent,
 * never how often: the Python asserted the posted text positively in seven of
 * its own examples (`test_shepherd_pr.py:371`, `:402`, `:417`, `:466`, `:483`,
 * `:1011`, `:1162`).
 */
const recording = (
  options: GhServerOptions,
): { gh: GhClient; comments: unknown[]; updates: unknown[] } => {
  const server = createGhServer(options)
  const comments: unknown[] = []
  const updates: unknown[] = []
  return {
    comments,
    updates,
    gh: {
      ...server,
      addComment: async (comment) => {
        comments.push(comment)
        return server.addComment(comment)
      },
      updateBranch: async (pull) => {
        updates.push(pull)
        return server.updateBranch(pull)
      },
    },
  }
}

// --- parity with the Python ----------------------------------------------------

/** What each case needs beyond its captured pull-request set: the stub `gh`
 *  switches the case's environment turned on, as this client's registrations.
 *  A case with no entry is answered from its rows alone. */
const ARRANGEMENTS: Record<string, GhServerOptions> = {
  gh_cannot_resolve_the_repository: { fail: ghFails('gh: simulated failure') },
  // No `shutil.which` preflight is ported (#158): gh not being on PATH is the
  // runner's 127, which is what the real client throws.
  gh_is_not_on_path: { fail: ghFails('cannot run gh: spawn gh ENOENT', 127) },
  rebase_moves_the_head: {
    replies: { updateBranch: UPDATED },
    // The stub rewrote the row it was holding; a sequence is the same fact
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
  recreate_gives_up_when_the_head_never_moves: { replies: { addComment: COMMENT_URL } },
  recreate_polls_at_least_once_when_the_ci_estimate_is_zero: {
    replies: { addComment: COMMENT_URL },
  },
  recreate_reports_a_comment_it_could_not_post: {
    replies: { addComment: ghFails('HTTP 403: Resource not accessible by integration') },
  },
  skip_posts_the_reason: { replies: { addComment: COMMENT_URL } },
  skip_reports_a_comment_it_could_not_post: {
    replies: { addComment: ghFails('HTTP 403: Resource not accessible by integration') },
  },
  wait_reports_pending_when_its_bound_is_hit: { replies: { watchChecks: WATCH_BOUND } },
  wait_clamps_the_bound_to_the_maximum: { replies: { watchChecks: WATCH_PENDING } },
  wait_reports_the_rollup_once_the_watcher_returns: { replies: { watchChecks: WATCH_PENDING } },
  wait_says_a_bound_override_was_ignored: { replies: { watchChecks: WATCH_PENDING } },
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

/** The cases whose stderr ends in this command's own usage text, which names
 *  `gh.ts shepherd-pr` where the Python's named a script file, mapped to what
 *  comes in front of it. Both halves are compared: the line, against the
 *  Python's own, and the usage, against this command's. */
const USAGE_TEXT = new Map([
  ['usage_with_too_few_arguments', ''],
  ['an_unknown_action', 'unknown action: dance\n'],
])

/** The cases that cannot be replayed through the command function, read from
 *  the divergence record rather than listed here: each carries why, and the
 *  example that pins the contract another way. */
const NOT_REPLAYED = new Set(Object.keys(DIVERGENCES.notReplayed['shepherd-pr'] ?? {}))

/** What the reason file held in each case that names one. Only its existence
 *  and its size decide anything. */
const REASONS: Record<string, string> = { skip_refuses_an_empty_reason_file: '' }

const PATHS: Record<string, (sandbox: Sandbox, repo: string, name: string) => string> = {
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
  '<sandbox>/reason.md': (sandbox, _repo, name) => {
    const reason = sandbox.join('reason.md')
    writeFileSync(reason, REASONS[name] ?? 'reason\n')
    return reason
  },
}

/** Root can enter a directory with no permissions, which is what the Python's
 *  own skip says (`test_shepherd_edges.py:387`). Neither venue this suite runs
 *  in is root. */
const asRoot = process.getuid?.() === 0

const replayable = Object.keys(CAPTURE).filter((name) => !NOT_REPLAYED.has(name))

/** The one case a run as root cannot prove: root can enter a directory with
 *  no permissions, so the refusal never happens. */
const needsAUser = (name: string): boolean =>
  (CAPTURE[name] as CapturedCase).argv[0] === '<sandbox>/closed'

/** Split so that a root run REPORTS the case as skipped, which is what the
 *  Python's own `skipif` did (`test_shepherd_edges.py:387`). A bare `return`
 *  inside the example reported a pass with nothing asserted in it, which says
 *  the access probe was checked when it was not. The hundred percent coverage
 *  gate is the second line of defence: the refusal arm in `directoryRefusal`
 *  then goes unreached and the gate fails. */
const replayAlways = replayable.filter((name) => !needsAUser(name))
const replayAsAUser = replayable.filter(needsAUser)

const replay = async (name: string): Promise<void> => {
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
      replies: { viewRepository: REPOSITORY, ...ARRANGEMENTS[name]?.replies },
    }),
  }))

  expect(result.status).toBe(expected.status)
  expect(normalise(result.stdout, result.sandbox)).toBe(expected.stdout)
  const before = USAGE_TEXT.get(name)
  if (before !== undefined) {
    // The Python printed its own docstring here, which named a script file.
    // What is compared is that the same thing was said for the same reason:
    // the line in front of the usage is the Python's, and the usage is this
    // command's.
    expect(expected.stderr.startsWith(before)).toBe(true)
    expect(result.stderr).toBe(`${before}${HELP}\n`)
  } else if (expected.argv[0] === '<sandbox>/closed') {
    // node's account of the refused access where Python's was
    // `[Errno 13] Permission denied`; the sentence in front of it is the same,
    // and is read from the divergence record. One line, ending in a newline,
    // saying something after the colon: everything the Python's byte
    // comparison gave except the account itself.
    expect(normalise(result.stderr, result.sandbox)).toBe(
      `${divergence('cannotEnter').prefix}<sandbox>/closed: ${normalise(
        result.stderr,
        result.sandbox,
      )
        .split(': ')
        .slice(1)
        .join(': ')}`,
    )
    expect(normalise(result.stderr, result.sandbox)).toMatch(
      new RegExp(`^${divergence('cannotEnter').prefix}<sandbox>/closed: [^\\n]+\\n$`),
    )
  } else {
    expect(normalise(result.stderr, result.sandbox)).toBe(expected.stderr)
  }
}

it.each(replayAlways)('prints what the Python printed for %s', replay)
it.skipIf(asRoot).each(replayAsAUser)('prints what the Python printed for %s', replay)

it('replays every captured case, and arranges only cases that exist', () => {
  expect(replayable.length + NOT_REPLAYED.size).toBe(Object.keys(CAPTURE).length)
  for (const name of [
    ...Object.keys(ARRANGEMENTS),
    ...USAGE_TEXT.keys(),
    ...Object.keys(REASONS),
  ]) {
    expect(Object.keys(CAPTURE)).toContain(name)
  }
  // Every case a divergence names is a case the capture actually holds, so a
  // row cannot be recorded against a run that is not there.
  for (const row of [...DIVERGENCES.sentences, DIVERGENCES.unchanged]) {
    for (const name of row.cases) expect(Object.keys(CAPTURE)).toContain(name)
  }
  // And the sentence that deliberately did not change is still in the
  // document, because it is output rather than prose.
  expect(CAPTURE[DIVERGENCES.unchanged.cases[0] ?? '']?.stdout).toContain(
    DIVERGENCES.unchanged.line,
  )
})

// --- usage and the preflight ----------------------------------------------------

it('prints its own usage for --help, naming every action it accepts', async () => {
  const result = await drive(() => ({ argv: ['--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'skip', 'merged']) {
    expect(result.stdout).toContain(`gh.ts shepherd-pr <path> <number> ${action}`)
  }
  expect(result.stderr).toBe('')
})

it('opens its usage with the sentence the Python opened with', async () => {
  // The divergence recorded for `help` is the command name, and nothing else:
  // the sentence in front of it is read off the capture rather than restated,
  // so a rewrite of the opening line is a divergence that has to be argued.
  const opening = (CAPTURE.help?.stdout ?? '').split('\n')[0]?.split(' \u2014 ')[1] ?? ''

  expect(opening).not.toBe('')
  // The Python's docstring opened `gh-shepherd-pr.py \u2014 the ...`, so the
  // sentence is the same one with a capital where the script name used to be.
  expect(HELP.split('\n')[0]?.toLowerCase()).toBe(opening.toLowerCase())
})

it('answers -h the same way it answers --help', async () => {
  const result = await drive(() => ({ argv: ['-h'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('accepts every action it advertises', async () => {
  // An action the command runs but does not advertise is one nobody calls; one
  // it advertises and rejects is worse.
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'skip', 'merged']) {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', action, 'reason-file-that-is-not-there'],
      gh: createGhServer({ prs: [], replies: { viewRepository: REPOSITORY } }),
    }))

    expect(result.stderr, action).not.toContain(`unknown action: ${action}`)
  }
})

// --- state, merged and the reads that failed -------------------------------------

it('reports a gh failure with nothing to say as an answer it did not get', async () => {
  // The fallback the Python carried for a `gh` that exited non-zero and said
  // nothing at all. Truthiness, not a null check: an empty account is no
  // account.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, viewPullRequest: ghFails('') },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe('could not read pull request #1: gh returned no JSON object')
})

it('carries gh’s own words, on one line, when the pull request cannot be read', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({
      replies: {
        viewRepository: REPOSITORY,
        viewPullRequest: ghFails('HTTP 502\n  Bad gateway\n'),
      },
    }),
  }))

  expect(result.status).toBe(0)
  expect(result.document.detail).toBe('could not read pull request #1: HTTP 502 Bad gateway')
})

it('refuses an answer missing any field the loop decides from', async () => {
  // `summary` shapes whatever it is handed, so a projection missing everything
  // else comes back as a pull request with no checks, which `wait` reads as
  // nothing left to watch.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, viewPullRequest: { number: 1, state: 'OPEN' } },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('gh answered without headRefOid')
})

// --- rebase -----------------------------------------------------------------------

it('reports an update that worked and a read that did not, as ok', async () => {
  // `ok: false` here would have the caller decide again and rebase a second
  // time, which costs another CI run for a read that failed.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
      sequences: {
        viewPullRequest: [depPr(1, { merge: 'BEHIND' }), ghFails('HTTP 502: Bad gateway')],
      },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe(
    'update-branch succeeded but the pull request could not be re-read: HTTP 502: Bad gateway',
  )
  expect(result.document.after).toBe('')
  expect(result.document.pr).toBeNull()
})

it('reads a head gh answered as an empty string as no head at all', async () => {
  // Truthiness: `""` is gh answering nothing, and the Python folded it to ""
  // before comparing. A `??` here would compare `""` against the old SHA and
  // report a rebase that moved the head.
  const rebased = { ...depPr(1, { merge: 'BEHIND' }), headRefOid: '' }
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
      // A head of "" fails `missingField`, so the read fails; what this pins
      // is that the empty answer never reaches the comparison as a SHA.
      sequences: { viewPullRequest: [depPr(1, { merge: 'BEHIND' }), rebased] },
    }),
  }))

  expect(result.document.detail).toContain('gh answered without headRefOid')
  expect(result.document.after).toBe('')
})

it('asks for a rebase of the pull request it was given, and never a merge', async () => {
  // Omitting `rebase` writes a merge commit onto someone else's branch, and
  // the number is the one the caller named: both are the whole request, which
  // is what `gh-shepherd-pr.py:483` sends.
  const record = recording({
    replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
    sequences: { viewPullRequest: [depPr(7, { merge: 'BEHIND' })] },
  })

  let target = ''
  const result = await drive((_sandbox, repo) => {
    target = repo
    return { argv: [repo, '7', 'rebase'], gh: record.gh }
  })

  expect(record.updates).toEqual([{ pullRequest: 7, rebase: true }])
  expect(result.ghOptions).toEqual(clients(target))
})

// --- recreate ----------------------------------------------------------------------

const recreateEnv = (sandbox: Sandbox): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  SHEPHERD_CI_SECONDS: '4',
  SHEPHERD_POLL_SECONDS: '1',
})

it('comments and returns once the head moves', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: recreateEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'DIRTY' }),
          depPr(1, { merge: 'DIRTY', head: 'recreated' }),
        ],
      },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe('recreated')
  expect(result.document.before).toBe('sha1')
  expect(result.document.after).toBe('recreated')
  // The snapshot reported is the one the moved head was read from, not the
  // one the poll started with (`test_shepherd_pr.py:370`).
  expect((result.document.pr as Record<string, unknown>).headRefOid).toBe('recreated')
})

it('posts the words Dependabot answers, on the pull request it was given', async () => {
  // `@dependabot recreate` is answered by one bot and by nothing else: any
  // other text is a comment that will sit on a stranger's pull request
  // forever. `gh-shepherd-pr.py:533` to `:541`.
  const record = recording({
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
    sequences: {
      viewPullRequest: [depPr(7, { merge: 'DIRTY' }), depPr(7, { merge: 'DIRTY', head: 'new' })],
    },
  })

  let target = ''
  const result = await drive((sandbox, repo) => {
    target = repo
    return { argv: [repo, '7', 'recreate'], env: recreateEnv(sandbox), gh: record.gh }
  })

  expect(result.document.detail).toBe('recreated')
  expect(record.comments).toEqual([{ pullRequest: 7, body: '@dependabot recreate' }])
  expect(result.ghOptions).toEqual(clients(target))
})

it('refuses a bot that is not Dependabot, and posts nothing', async () => {
  // `is_bot` still reports what it is, so the report can say why it stopped;
  // what the action turns on is `is_dependabot`. The captured refusal has a
  // HUMAN author, so nothing there tells `!is_dependabot` and `!is_bot`
  // apart, and under `!is_bot` this command posts `@dependabot recreate` on a
  // renovate pull request, which nothing will ever answer
  // (`test_shepherd_pr.py:334`).
  const record = recording({
    prs: [{ ...depPr(1, { merge: 'DIRTY' }), author: { login: 'renovate[bot]', is_bot: true } }],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })

  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: recreateEnv(sandbox),
    gh: record.gh,
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('not authored by Dependabot')
  const pull = result.document.pr as Record<string, unknown>
  expect(pull.is_bot).toBe(true)
  expect(pull.is_dependabot).toBe(false)
  expect(record.comments).toEqual([])
})

it('reports a moved head as recreated even when the merge landed with it', async () => {
  // The moved head must win over the state change: this is the success path.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: recreateEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'DIRTY' }),
          depPr(1, { merge: 'DIRTY', head: 'recreated', state: 'MERGED' }),
        ],
      },
    }),
  }))

  expect(result.document.detail).toBe('recreated')
  expect(result.document).not.toHaveProperty('result')
})

it.each([
  ['CLOSED', 'closed', 'closed while waiting for recreate'],
  ['MERGED', 'merged', 'merged while waiting for recreate'],
])(
  'returns early when the pull request is %s with the head unmoved',
  async (state, result, detail) => {
    const answer = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'recreate'],
      env: recreateEnv(sandbox),
      gh: createGhServer({
        replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
        sequences: {
          viewPullRequest: [depPr(1, { merge: 'DIRTY' }), depPr(1, { merge: 'DIRTY', state })],
        },
      }),
    }))

    expect(answer.document.ok).toBe(true)
    expect(answer.document.result).toBe(result)
    expect(answer.document.detail).toContain(detail)
  },
)

it('refuses a state it does not recognise after recreate', async () => {
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: recreateEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'DIRTY' }),
          depPr(1, { merge: 'DIRTY', state: 'ZOMBIE' }),
        ],
      },
    }),
  }))

  expect(answer.document.ok).toBe(false)
  expect(answer.document.detail).toBe("unexpected pull request state after recreate: 'ZOMBIE'")
})

it('keeps polling when gh cannot read the pull request for one poll', async () => {
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: recreateEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'DIRTY' }),
          ghFails('HTTP 502: Bad gateway'),
          depPr(1, { merge: 'DIRTY', state: 'CLOSED' }),
        ],
      },
    }),
  }))

  expect(answer.document.result).toBe('closed')
  // A poll that could not read the pull request says nothing about it, so the
  // read that followed is the answer, and it is still `ok` (the recreate
  // comment did go out). `test_shepherd_pr.py:437` and `:439`.
  expect(answer.document.ok).toBe(true)
  expect((answer.document.pr as Record<string, unknown>).state).toBe('CLOSED')
})

it('says the pull request could not be re-read rather than that the head did not move', async () => {
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '1', SHEPHERD_POLL_SECONDS: '1' },
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [depPr(1, { merge: 'DIRTY' }), ghFails('HTTP 502: Bad gateway')],
      },
    }),
  }))

  expect(answer.document.ok).toBe(false)
  expect(answer.document.detail).toBe(
    'recreate requested but the pull request could not be re-read in 2s (2 attempts): ' +
      'HTTP 502: Bad gateway',
  )
  expect(answer.document.read_failures).toBe(2)
  expect(answer.document).not.toHaveProperty('pr')
})

it('reports the last read as null when the polling ended on a read that failed', async () => {
  // The Python reports `pr` from the same variable it assigns the failed read
  // to, so a run whose last poll failed carries a null pull request.
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '1', SHEPHERD_POLL_SECONDS: '1' },
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'DIRTY' }),
          depPr(1, { merge: 'DIRTY' }),
          ghFails('HTTP 502: Bad gateway'),
        ],
      },
    }),
  }))

  expect(answer.document.detail).toBe('recreate requested but the head did not change within 2s')
  expect(answer.document.read_failures).toBe(1)
  expect(answer.document.pr).toBeNull()
})

it('derives a poll interval from the CI cycle when nobody gave one', async () => {
  // A quarter of the cycle, floored at 15 seconds, and the bound is two
  // cycles: 400 gives an interval of 100 and a bound of 800, which is eight
  // polls and no waiting at all.
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '400' },
    gh: createGhServer({
      prs: [depPr(1, { merge: 'DIRTY' })],
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
    }),
  }))

  expect(answer.document.detail).toBe('recreate requested but the head did not change within 800s')
  expect(answer.elapsed).toBe(800_000)
})

it('floors a derived poll interval, so a fast repository is not polled every second', async () => {
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '8' },
    gh: createGhServer({
      prs: [depPr(1, { merge: 'DIRTY' })],
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
    }),
  }))

  // A bound of 16 seconds with a floor of 15 buys two polls, the second of
  // which runs past the bound: the loop is `while waited < bound`, exactly as
  // the Python's is.
  expect(answer.elapsed).toBe(30_000)
})

it('says so when a poll interval is not a number, and falls back to the floor', async () => {
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '400', SHEPHERD_POLL_SECONDS: 'soon' },
    gh: createGhServer({
      prs: [depPr(1, { merge: 'DIRTY' })],
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
    }),
  }))

  expect(answer.stderr).toBe('SHEPHERD_POLL_SECONDS=soon ignored; using 15\n')
})

it('honours a poll interval below the floor, and never a zero one', async () => {
  // Zero would spin without ever reaching the bound. The shell version did.
  const answer = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '4', SHEPHERD_POLL_SECONDS: '0' },
    gh: createGhServer({
      prs: [depPr(1, { merge: 'DIRTY' })],
      replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
    }),
  }))

  expect(answer.elapsed).toBe(8_000)
  expect(answer.document.detail).toContain('within 8s')
})

// --- wait ---------------------------------------------------------------------------

it('does not watch a rollup that has already failed', async () => {
  // `gh pr checks --watch` has been seen not to return on a terminal rollup,
  // so the failure is read from the rollup and no watcher is started at all:
  // an unregistered `watchChecks` throws and names itself if one is.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'failed' })],
      replies: { viewRepository: REPOSITORY, readFailedRunLog: 'the failing step\n' },
    }),
  }))

  expect(result.document.result).toBe('failed')
})

it('refuses when the watcher failed for a reason of its own', async () => {
  // Reported as `pending`, the caller waits out an expired token or a 502 one
  // CI cycle at a time, forever, and the transcript never says why.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '5' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: {
        viewRepository: REPOSITORY,
        watchChecks: {
          status: 4,
          timedOut: false,
          waitedMs: 0,
          problem: 'HTTP 502: Bad gateway\n',
        },
      },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe('watcher failed after 0s: HTTP 502: Bad gateway')
  expect(result.document.watcher_rc).toBe(4)
  expect(result.document).not.toHaveProperty('result')
})

it('names the watcher’s status when the watcher failed without saying anything', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '5' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: {
        viewRepository: REPOSITORY,
        watchChecks: { status: 4, timedOut: false, waitedMs: 0, problem: '' },
      },
    }),
  }))

  expect(result.document.detail).toBe('watcher failed after 0s: gh exited 4')
})

it('refuses a watch that a signal ended, which said nothing about the checks', async () => {
  // A watch with no status of its own is not one of the codes either, and the
  // bound not having fired is what tells it apart from this command's own
  // kill.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '5' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: {
        viewRepository: REPOSITORY,
        watchChecks: {
          status: null,
          timedOut: false,
          waitedMs: 2000,
          problem: 'gh was killed by SIGHUP',
        },
      },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe('watcher failed after 2s: gh was killed by SIGHUP')
  expect(result.document.watcher_rc).toBeNull()
})

it('keeps only the last lines of a watcher’s account of itself', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '5' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: {
        viewRepository: REPOSITORY,
        watchChecks: {
          status: 4,
          timedOut: false,
          waitedMs: 0,
          problem: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n'),
        },
      },
    }),
  }))

  expect(result.document.detail).toBe('watcher failed after 0s: three four five six seven')
})

it('still decides from the rollup when the watcher reports a failed check', async () => {
  // Exit 1 is gh's "a check failed", not gh failing, so the rollup decides.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '5' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: {
        viewRepository: REPOSITORY,
        watchChecks: { status: 1, timedOut: false, waitedMs: 0, problem: 'some check failed\n' },
      },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('pending')
  expect(result.document.watcher_rc).toBe(1)
})

it('clamps the wait bound up to the minimum for a repository with fast CI', async () => {
  // The other end of `clamp(ciSeconds * 2, 120, 540)`. `Math.max` is not a
  // branch, so the coverage gate never sees this one: a floor of 1 would go
  // unnoticed, and a wait that returned after two seconds would report
  // `pending` for a run that had barely started.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '10' },
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: { viewRepository: REPOSITORY, watchChecks: WATCH_PENDING },
    }),
  }))

  expect(result.document.bound).toBe(120)
})

it('reports merged when auto-merge fires during the watch', async () => {
  // The merge must land while the WATCHER is running, not before the first
  // read: otherwise this passes through the answers-without-watching path and
  // proves nothing. `test_shepherd_pr.py:623` says so in its own docstring
  // and backs it by asserting the watch happened, so the watch's own request
  // is asserted here, whole, rather than counted.
  const watches: unknown[] = []
  const server = createGhServer({
    replies: { viewRepository: REPOSITORY, watchChecks: WATCH_BOUND },
    sequences: {
      viewPullRequest: [
        depPr(1, { checks: 'pending' }),
        depPr(1, { checks: 'pending', state: 'MERGED' }),
      ],
    },
  })

  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '2' },
    gh: {
      ...server,
      watchChecks: async (pull) => {
        watches.push(pull)
        return server.watchChecks(pull)
      },
    },
  }))

  expect(result.document.result).toBe('merged')
  expect(watches).toEqual([{ pullRequest: 1, boundMs: 2000, failFast: true }])
})

it('reports a pull request that became unreadable during the watch', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '1' },
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, watchChecks: WATCH_BOUND },
      sequences: {
        viewPullRequest: [depPr(1, { checks: 'pending' }), ghFails('HTTP 502: Bad gateway')],
      },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe(
    'checks finished but the pull request could not be re-read: HTTP 502: Bad gateway',
  )
})

it('reports a log gh would not hand over, which is not a job that printed nothing', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'failed' })],
      replies: { viewRepository: REPOSITORY, readFailedRunLog: ghFails('HTTP 502: Bad gateway') },
    }),
  }))

  expect(result.document.result).toBe('failed')
  expect(result.document.log_tail).toBe('')
  expect(result.document.log_error).toBe(
    "could not read the failed job's log: HTTP 502: Bad gateway",
  )
})

it('strips the colour a log viewer would have rendered', async () => {
  const esc = String.fromCharCode(27)
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'failed' })],
      replies: {
        viewRepository: REPOSITORY,
        readFailedRunLog: `${esc}[31mred${esc}[0m and plain\n`,
      },
    }),
  }))

  expect(result.document.log_tail).toBe('red and plain')
})

// --- settle -------------------------------------------------------------------------

const settleEnv = (sandbox: Sandbox, bound = '3', poll = '1'): NodeJS.ProcessEnv => ({
  ...sandbox.env,
  SHEPHERD_SETTLE_BOUND: bound,
  SHEPHERD_SETTLE_POLL: poll,
})

it('reports merged when auto-merge lands after the first read', async () => {
  // The field-test race itself: OPEN and CLEAN on the first read, MERGED one
  // poll later.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.result).toBe('merged')
  expect(result.document.mergeCommit).toBe('abc')
  expect(result.document.waited).toBe(1)
})

it('does not block on a single read of BLOCKED', async () => {
  // GitHub reports BLOCKED while reconciling a check that just went green, so
  // one sample of it is the same race this action exists to close.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1, { merge: 'BLOCKED' }),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.result).toBe('merged')
  // And the merge it read is the one reported: a BLOCKED sample that was
  // never corroborated must not take the answer with it
  // (`test_shepherd_pr.py:731`).
  expect(result.document.mergeCommit).toBe('abc')
})

it('blocks on a merge state that turned BLOCKED mid-poll', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '8'),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [depPr(1), depPr(1, { merge: 'BLOCKED' }), depPr(1, { merge: 'BLOCKED' })],
      },
    }),
  }))

  expect(result.document.result).toBe('blocked')
  expect(result.document.reason).toBe('auto-merge cannot fire: mergeStateStatus is BLOCKED')
  // The snapshot reported is the blocking one, not the clean read the poll
  // opened with (`test_shepherd_pr.py:800`).
  expect((result.document.pr as Record<string, unknown>).mergeStateStatus).toBe('BLOCKED')
})

it('blocks rather than rechecks when a review is required on a base that moved', async () => {
  // Precedence, and nothing else asserts it: a RECHECK merge state and a
  // blocking review together must answer `blocked`. Reporting `changed` would
  // send the caller off to rebase, which buys a CI run and leaves the pull
  // request exactly as unmergeable as it was (`test_shepherd_pr.py:765`).
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      prs: [depPr(1, { merge: 'BEHIND', checks: 'passed', review: 'REVIEW_REQUIRED' })],
      replies: { viewRepository: REPOSITORY },
    }),
  }))

  expect(result.document.result).toBe('blocked')
  expect(result.document.reason).toBe('auto-merge cannot fire: reviewDecision is REVIEW_REQUIRED')
})

it('reports closed when the pull request is closed while it waits', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), depPr(1, { state: 'CLOSED' })] },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('closed')
  expect(result.document.waited).toBe(1)
})

it('keeps polling when one read fails and reports the answer that followed', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '8'),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: {
        viewPullRequest: [
          depPr(1),
          ghFails('HTTP 502: Bad gateway'),
          { ...depPr(1, { state: 'MERGED' }), mergeCommit: { oid: 'abc' } },
        ],
      },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('merged')
  expect(result.document.read_failures).toBe(1)
  // The read that recovered cleared the account of the one that failed, which
  // is what the Python does too: every read attempt overwrites `read_err`, so
  // the field describes the LAST read and the count describes the run.
  expect(result.document.read_error).toBe('')
})

it('refuses when the bound arrives on a read that failed', async () => {
  // "Nothing was reported against it" would be a statement about a silence.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), ghFails('HTTP 502: Bad gateway')] },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe(
    'settle waited 3s but could not re-read the pull request (3 of 4 reads failed, the last ' +
      'among them): HTTP 502: Bad gateway',
  )
  expect(result.document).not.toHaveProperty('result')
  expect(result.document.read_error).toBe('HTTP 502: Bad gateway')
})

it('polls at least once when the bound is shorter than the interval', async () => {
  // A bound below one interval must still buy a read, not answer from the
  // first one.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox, '1', '2'),
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.waited).toBe(2)
  expect(result.document.reads_ok).toBe(2)
})

it('measures the time it waited rather than adding up its sleeps', async () => {
  // Each read takes time of its own on a slow gh, and the agent copies
  // `waited` into its report as evidence of how long GitHub was given.
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const writers = capture()
  let elapsed = 0
  const server = createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } })
  const gh: GhClient = {
    ...server,
    viewPullRequest: async (pull) => {
      // A read that costs a second of the clock without anyone sleeping.
      elapsed += 1000
      return server.viewPullRequest(pull)
    },
  }
  const status = await runShepherdPr([repo, '1', 'settle'], {
    cwd: repo,
    env: settleEnv(sandbox, '4', '1'),
    output: writers.output,
    createGh: () => gh,
    now: () => elapsed,
    sleep: async (milliseconds) => {
      elapsed += milliseconds
    },
  })
  const document = JSON.parse(writers.stdout())

  expect(status).toBe(0)
  expect(document.result).toBe('open')
  // One sleep of a second per poll, so a settle that added up its own sleeps
  // would report exactly the number of polls it made.
  expect(document.waited).toBeGreaterThan(document.reads_ok - 1)
})

it('refuses a settle whose checks are neither passed nor absent, without watching', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'pending' })],
      replies: { viewRepository: REPOSITORY },
    }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toBe(
    'refused: checks are pending; settle acts on passed or none, and `wait` is what watches a run',
  )
})

it('reads a merge state gh answered as null as no merge state at all', async () => {
  // `mergeStateStatus` is not a field `missingField` requires, so null is a
  // real answer: GitHub has not computed one. Truthiness folds it to "", which
  // is neither blocking nor a recheck, so settle keeps waiting.
  const unknownState = { ...depPr(1), mergeStateStatus: null }
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({ prs: [unknownState], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.result).toBe('open')
  expect(result.document.waited).toBe(3)
})

it('reports open with the count when a read failed and a later one recovered', async () => {
  // The failure is counted, the snapshot is fresh, and the account of the
  // failure is gone because the read that followed it answered.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'settle'],
    env: settleEnv(sandbox),
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY },
      sequences: { viewPullRequest: [depPr(1), ghFails('HTTP 502: Bad gateway'), depPr(1)] },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.result).toBe('open')
  expect(result.document.read_failures).toBe(1)
  expect(result.document.reads_ok).toBe(3)
  expect(result.document.read_error).toBe('')
})

// --- skip -----------------------------------------------------------------------------

it('refuses a reason file that is not there at all', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', sandbox.join('nothing.md')],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('reason file is missing or empty')
})

it('refuses a reason file that is a directory', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', sandbox.path],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.document.ok).toBe(false)
  expect(result.document.detail).toContain('reason file is missing or empty')
})

it('posts the reason file it was given, as the body of the comment', async () => {
  // `--body-file`, never `--body`: the reason is a file the caller wrote, and
  // a literal here would post something nobody reviewed
  // (`gh-shepherd-pr.py:928`). The number is the one the caller named.
  const record = recording({
    prs: [depPr(4)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let reason = ''
  let target = ''

  const result = await drive((sandbox, repo) => {
    reason = PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''
    target = repo
    return { argv: [repo, '4', 'skip', reason], gh: record.gh }
  })

  expect(record.comments).toEqual([{ pullRequest: 4, bodyFile: reason }])
  expect(result.ghOptions).toEqual(clients(target))
})

it('vets the reason file gh will read, not one beside this process', async () => {
  // The Python `os.chdir`'d to the target before both the check and the
  // comment (`gh-shepherd-pr.py:1007`, `:920`, `:928`), so a relative path
  // named one file to both. Nothing here changes directory and gh is spawned
  // with the target as its own, so the path has to be resolved against the
  // target or the file vetted is not the file posted.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let expected = ''

  const result = await drive((_sandbox, repo) => {
    writeFileSync(path.join(repo, 'why.md'), 'not a mechanical fix\n')
    expected = path.join(realpathSync(repo), 'why.md')
    return { argv: [repo, '1', 'skip', 'why.md'], gh: record.gh }
  })

  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe('skip comment posted')
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: expected }])
})

it('posts the file it vetted, even when the target is a symbolic link', async () => {
  // The two derivations of the path have to be one value. `chdir` resolved
  // symbolic links for the Python, `path.resolve` does not, and gh is spawned
  // with the target as its working directory: so a target that is a link and
  // a reason file that climbs out of it with `..` named `<link>/../why.md` to
  // the guard and `<real>/../why.md` to gh. Two different files, one of them
  // never looked at, posted on someone else's pull request.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let posted = ''
  let vetted = ''

  const result = await drive((sandbox, repo) => {
    // The file gh reaches through the link, and the one a lexical resolution
    // would reach instead. Only the first is ever stat'd.
    vetted = path.join(realpathSync(repo), '..', 'why.md')
    writeFileSync(vetted, 'the reason that was vetted\n')
    mkdirSync(sandbox.join('elsewhere'), { recursive: true })
    posted = sandbox.join('elsewhere', 'link')
    symlinkSync(repo, posted)
    // The decoy, so the lexical answer is a file that EXISTS: without it the
    // guard simply refuses, and the case this is about is the one where both
    // are there and the wrong one goes out.
    writeFileSync(sandbox.join('elsewhere', 'why.md'), 'never looked at\n')
    return { argv: [posted, '1', 'skip', path.join('..', 'why.md')], gh: record.gh }
  })

  expect(result.document.ok).toBe(true)
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: path.resolve(vetted) }])
})

it('reports no comment url when gh printed none', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''],
    gh: createGhServer({
      prs: [depPr(1)],
      replies: { viewRepository: REPOSITORY, addComment: 'nothing that looks like a link\n' },
    }),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.comment_url).toBe('')
})

it('reports the last url gh printed as the comment url', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'skip', PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''],
    gh: createGhServer({
      prs: [depPr(1)],
      replies: {
        viewRepository: REPOSITORY,
        addComment:
          'https://github.com/acme/widgets/pull/1 https://github.com/last#issuecomment-2\n',
      },
    }),
  }))

  expect(result.document.comment_url).toBe('https://github.com/last#issuecomment-2')
})

// --- a reader that walked away ----------------------------------------------------------

/** stdout whose reader leaves on the first line, the way `| head` does: the
 *  failure arrives as an event rather than at the call
 *  (`commands/sync-repo.test.ts` uses the same shape). */
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

it('lets a reader that left stop the report, never the rebase', async () => {
  // `test_shepherd_pr.py:1135` asserted the composite: the reader is gone AND
  // the branch was still updated AND the status is 0. The two halves are
  // pinned apart (the writer's EPIPE guard by `lib/streams.test.ts`, the
  // update by `reports an update that worked and a read that did not`); this
  // is the composite itself, in process.
  const record = recording({
    replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
    sequences: {
      viewPullRequest: [depPr(1, { merge: 'BEHIND' }), depPr(1, { head: 'rebased' })],
    },
  })

  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: record.gh,
    reader: closedPipe,
  }))

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(record.updates).toEqual([{ pullRequest: 1, rebase: true }])
})

it('lets a reader that left stop the report, never the skip comment', async () => {
  // `test_shepherd_pr.py:1149`, the same composite for the other write. The
  // comment is posted before the report is written, so a reader that goes
  // away cannot take it with it.
  const record = recording({
    prs: [depPr(1)],
    replies: { viewRepository: REPOSITORY, addComment: COMMENT_URL },
  })
  let reason = ''

  const result = await drive((sandbox, repo) => {
    reason = PATHS['<sandbox>/reason.md']?.(sandbox, repo, 'x') ?? ''
    return { argv: [repo, '1', 'skip', reason], gh: record.gh, reader: closedPipe }
  })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(record.comments).toEqual([{ pullRequest: 1, bodyFile: reason }])
})

// --- the environment overrides that were not used ----------------------------------------

it('says nothing when no override was given', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it('reads an override set to nothing as an override nobody set', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_LOG_LINES: '' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it('refuses a log line count of zero, which would keep no log at all', async () => {
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_LOG_LINES: '0' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('SHEPHERD_LOG_LINES=0 ignored; using 60\n')
})

it('accepts a CI estimate of zero, which is a number even though it is not positive', async () => {
  // `SHEPHERD_CI_SECONDS` is read with the digits pattern, not the positive
  // one, which is what makes the "polls at least once" arm reachable at all.
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    env: { ...sandbox.env, SHEPHERD_CI_SECONDS: '0' },
    gh: createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
  }))

  expect(result.stderr).toBe('')
})

it.each([
  ['answered without one at all', { defaultBranchRef: { name: 'main' } }],
  // `view.get("nameWithOwner") or None` (`gh-shepherd-pr.py:973`): a
  // repository named `""` is gh answering nothing. A null guard takes it, and
  // every later call then carries `--repo ""`.
  ['named the empty string', { nameWithOwner: '', defaultBranchRef: { name: 'main' } }],
])('refuses a repository gh %s', async (_name, view) => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: createGhServer({ replies: { viewRepository: view } }),
  }))

  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    'could not resolve the repository with gh: gh answered without nameWithOwner\n',
  )
  expect(result.stdout).toBe('')
})

it('refuses a path that is a file rather than a directory', async () => {
  const result = await drive((sandbox, _repo) => {
    const file = sandbox.join('a-file')
    writeFileSync(file, 'not a directory\n')
    return { argv: [file, '1', 'state'], gh: createGhServer({ prs: [depPr(1)] }) }
  })

  expect(result.status).toBe(2)
  expect(result.stderr).toMatch(/^not a directory: /)
})

// --- an internal error --------------------------------------------------------------------

it('reports an internal error rather than a stack trace, and exits 3', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({}),
      viewRepository: async () => {
        throw new RangeError('boom')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(`${divergence('internalError').now}RangeError: boom\n`)
  // The status and the silence on stdout are the Python's, unchanged: only
  // the name in front of `internal error` differs.
  expect(result.status).toBe(CAPTURE.an_internal_error?.status)
  expect(result.stdout).toBe(CAPTURE.an_internal_error?.stdout)
  expect(CAPTURE.an_internal_error?.stderr).toContain(divergence('internalError').was)
})

it('reports something that is not an Error at all as an internal error too', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({}),
      viewRepository: async () => {
        throw 'a string nobody should throw'
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toBe(
    `${divergence('internalError').now}string: a string nobody should throw\n`,
  )
})

it('lets a failure that is not gh’s out of a read, rather than reporting it as one', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...createGhServer({ replies: { viewRepository: REPOSITORY } }),
      viewPullRequest: async () => {
        throw new TypeError('not an object')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('internal error: TypeError: not an object')
})

it('lets a failure that is not gh’s out of a mutating call', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: {
      ...createGhServer({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }),
      updateBranch: async () => {
        throw new TypeError('not a string')
      },
    },
  }))

  expect(result.status).toBe(3)
  expect(result.stderr).toContain('internal error: TypeError: not a string')
})
