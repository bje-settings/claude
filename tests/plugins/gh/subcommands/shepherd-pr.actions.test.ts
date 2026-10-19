// shepherd-pr, part of its tests: usage, the preflight, state, rebase and wait.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import { HELP } from '#gh/subcommands/shepherd-pr.ts'
import { type GhReplies, ghFails } from '#harness/gh.ts'
import { createGhServer, depPr, type GhSequences } from '#harness/pulls.ts'
import {
  AHEAD,
  CAPTURE,
  clients,
  compared,
  comparing,
  drive,
  REPOSITORY,
  recording,
  UNAVAILABLE,
  UPDATED,
} from './shepherd-pr.test-support.ts'

// --- usage and the preflight ----------------------------------------------------

it('prints its own usage for --help, naming every action it accepts', async () => {
  const result = await drive(() => ({ argv: ['--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  for (const action of ['state', 'rebase', 'wait', 'settle', 'merged']) {
    expect(result.stdout).toContain(`gh.ts shepherd-pr <path> <number> ${action}`)
  }
  expect(result.stderr).toBe('')
})

it('opens its usage with the sentence the Python opened with', async () => {
  // The divergence recorded for `help` is the command name, and nothing else.
  // The test reads the sentence in front of it from the capture. It does not
  // restate that sentence. So a rewrite of the first line becomes a
  // divergence, which needs an argument.
  const opening = (CAPTURE.help?.stdout ?? '').split('\n')[0]?.split(' \u2014 ')[1] ?? ''

  expect(opening).not.toBe('')
  // The Python's docstring opened with `gh-shepherd-pr.py \u2014 the ...`.
  // This port uses the same sentence, but with a capital letter where the
  // script name used to be.
  expect(HELP.split('\n')[0]?.toLowerCase()).toBe(opening.toLowerCase())
})

it('answers -h the same way it answers --help', async () => {
  const result = await drive(() => ({ argv: ['-h'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
})

it('reads --help in any position, before the argument-count refusal', async () => {
  // #218 finding 5, shepherd-pr half. #231 kept help at argv[0] only. A
  // caller who names a path, a number, and then --help must still get
  // help, with no gh call at all.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', '--help'],
    gh: createGhServer({}),
  }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  expect(result.stderr).toBe('')
})

it('reads --help before the argument-count refusal, on an argv too short for it', async () => {
  // #218 finding 5, round 2 review. Every other case for this fix names
  // three or more arguments, so the count check never fires either way.
  // This one is short: one path, then --help, with no number and no
  // action. Only reading help first, before `argv.length < 3`, answers
  // help here instead of the usage refusal at exit 2.
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '--help'],
    gh: createGhServer({}),
  }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  expect(result.stderr).toBe('')
})

it('accepts every action it advertises', async () => {
  // An action the command runs but does not advertise is one nobody calls.
  // One it advertises and rejects is worse.
  for (const action of ['state', 'rebase', 'wait', 'settle', 'merged']) {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', action],
      gh: createGhServer({ prs: [], replies: { viewRepository: REPOSITORY } }),
    }))

    expect(result.stderr, action).not.toContain(`unknown action: ${action}`)
  }
})

it('refuses an unknown action before any gh call', async () => {
  // The stand-in gh throws if it is called at all: no endpoint is
  // registered. A gh call here would fail the test for the wrong reason
  // (#218 finding 2).
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'dance'],
    gh: createGhServer({}),
  }))

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`unknown action: dance\n${HELP}\n`)
})

it('refuses recreate, which is no longer an action, before any gh call', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'recreate'],
    gh: createGhServer({}),
  }))

  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`unknown action: recreate\n${HELP}\n`)
  expect(HELP).not.toContain('recreate')
})

it('refuses an action name inherited from Object.prototype, before any gh call', async () => {
  // `HANDLERS` is a plain object literal. `constructor`, `toString`, `valueOf`,
  // and `hasOwnProperty` are not `undefined` on it, even though none of them
  // is a declared action. The stand-in gh throws if it is called at all.
  for (const action of ['constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', action],
      gh: createGhServer({}),
    }))

    expect(result.status, action).toBe(2)
    expect(result.stdout, action).toBe('')
    expect(result.stderr, action).toBe(`unknown action: ${action}\n${HELP}\n`)
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
  // `summary` shapes whatever it receives. A projection that lacks everything
  // else comes back as a pull request with no checks. `wait` reads that as
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
  // time. That costs another CI run for a read that failed.
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
  // Truthiness: an empty string `""` means gh answered nothing. The Python
  // folded it to "" before it compared. A `??` here would compare `""`
  // against the old SHA, and wrongly report a rebase that moved the head.
  const rebased = { ...depPr(1, { merge: 'BEHIND' }), headRefOid: '' }
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
      // A head of "" fails `missingField`, so the read fails. This pins one
      // fact: the empty answer never reaches the comparison as a SHA.
      sequences: { viewPullRequest: [depPr(1, { merge: 'BEHIND' }), rebased] },
    }),
  }))

  expect(result.document.detail).toContain('gh answered without headRefOid')
  expect(result.document.after).toBe('')
})

/** A `rebase` of pull request 1, whose reads answer `pulls` in order. The
 *  first entry is the read before the update. */
const rebaseOn = (
  pulls: NonNullable<GhSequences['viewPullRequest']>,
  env: Record<string, string> = {},
  updated = UPDATED,
) =>
  drive((sandbox, repo) => ({
    argv: [repo, '1', 'rebase'],
    env: { ...sandbox.env, ...env },
    gh: createGhServer({
      replies: { viewRepository: REPOSITORY, updateBranch: updated },
      sequences: { viewPullRequest: pulls },
    }),
  }))

const queued = depPr(1, { merge: 'BEHIND' })
const moved = depPr(1, { merge: 'BLOCKED', head: 'rebased-sha1' })

it('polls until the head moves, and reports moved on the second read', async () => {
  // Ruling 16 on #460: GitHub applies a queued update some seconds after gh
  // returns.
  const result = await rebaseOn([queued, queued, moved])

  expect(result.document).toMatchObject({
    ok: true,
    detail: 'rebased',
    before: 'sha1',
    after: 'rebased-sha1',
    result: 'moved',
    waited: 5,
    reads_ok: 2,
    read_failures: 0,
  })
  expect(result.elapsed).toBe(5_000)
})

it('reports unmoved when the bound passes, and stops the last sleep at the bound', async () => {
  const result = await rebaseOn([queued], { SHEPHERD_REBASE_BOUND: '12' })

  expect(result.document).toMatchObject({
    ok: true,
    detail:
      'update-branch reported success and the head has not moved after 12s: the update is ' +
      'still queued',
    after: 'sha1',
    result: 'unmoved',
    waited: 12,
    reads_ok: 4,
  })
  expect(result.elapsed).toBe(12_000)
})

it('does not poll when gh says the branch is already up to date', async () => {
  const result = await rebaseOn(
    [queued],
    {},
    '✓ Pull request #1 already up-to-date with base branch\n',
  )

  expect(result.document).toMatchObject({ ok: true, result: 'up_to_date', waited: 0, reads_ok: 1 })
  expect(result.elapsed).toBe(0)
})

it('counts a read failure that a later read recovered from, and nothing more', async () => {
  const result = await rebaseOn([queued, ghFails('HTTP 502'), moved])

  expect(result.document).toMatchObject({
    ok: true,
    result: 'moved',
    waited: 5,
    reads_ok: 1,
    read_failures: 1,
    read_error: '',
  })
})

it('reports ok with no head when the bound ends on a failed read', async () => {
  // The update ran, so `ok: false` would send the caller to rebase again.
  const result = await rebaseOn([queued, queued, ghFails('HTTP 502')], {
    SHEPHERD_REBASE_BOUND: '10',
  })

  expect(result.document).toMatchObject({
    ok: true,
    detail: 'update-branch succeeded but the pull request could not be re-read: HTTP 502',
    after: '',
    pr: null,
    waited: 10,
    reads_ok: 1,
    read_failures: 2,
    read_error: 'HTTP 502',
  })
  expect(result.document).not.toHaveProperty('result')
})

it('falls back to the default bound and poll for overrides that do not parse', async () => {
  const result = await rebaseOn([queued], {
    SHEPHERD_REBASE_BOUND: 'soon',
    SHEPHERD_REBASE_POLL: '0',
  })

  expect(result.stderr).toBe(
    'SHEPHERD_REBASE_BOUND=soon ignored; using 60\nSHEPHERD_REBASE_POLL=0 ignored; using 5\n',
  )
  expect(result.document).toMatchObject({ result: 'unmoved', waited: 60, reads_ok: 13 })
})

it('reads every SHEPHERD_REBASE_POLL seconds when it is set', async () => {
  const result = await rebaseOn([queued], {
    SHEPHERD_REBASE_BOUND: '10',
    SHEPHERD_REBASE_POLL: '2',
  })

  expect(result.document).toMatchObject({ result: 'unmoved', waited: 10, reads_ok: 6 })
})

it('asks for a rebase of the pull request it was given, and never a merge', async () => {
  // If the code omits `rebase`, it writes a merge commit onto someone else's
  // branch. The number is the one the caller named. Together, both are the
  // whole request, which is what `gh-shepherd-pr.py:483` sends.
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

// --- state and the compare ----------------------------------------------------------

it('reports a BLOCKED head with pending checks as behind, from the compare of its own base', async () => {
  // GitHub reports BLOCKED in place of BEHIND while a required check is
  // pending (#460). The compare answers only for this base and this head,
  // so a call with any other pair fails the test.
  const pull = { ...depPr(1, { merge: 'BLOCKED', checks: 'pending' }), baseRefName: 'release' }
  const server = createGhServer({ prs: [pull], replies: { viewRepository: REPOSITORY } })
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: {
      ...server,
      compareCommits: async (query) => {
        if (query.base !== 'release' || query.head !== 'sha1') throw new Error('wrong compare')
        return compared('behind')
      },
    },
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({
    mergeStateStatus: 'BLOCKED',
    checks: { state: 'pending' },
    baseRefName: 'release',
    behind: true,
  })
})

it.each([
  ['behind', true],
  ['diverged', true],
  ['ahead', false],
  ['identical', false],
] as const)('reads a compare that is %s as behind: %s', async (status, behind) => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: comparing({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }, [compared(status)]),
  }))

  expect(result.document.pr).toMatchObject({ behind })
  expect(result.stderr).toBe('')
})

it('reads a compare it could not get as behind: null, and says why on stderr', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: comparing({ prs: [depPr(1)], replies: { viewRepository: REPOSITORY } }, [UNAVAILABLE]),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({ behind: null })
  expect(result.stderr).toBe(
    'behind is null: the compare of main...sha1 is unavailable: gh api compare failed: HTTP 502\n',
  )
})

// --- wait ---------------------------------------------------------------------------

/** A `wait` against pull request 1, which reads `pulls` in order and the
 *  compare from `compares` in order. */
const waitOn = (
  pulls: NonNullable<GhSequences['viewPullRequest']>,
  compares: Parameters<typeof comparing>[1],
  env: Record<string, string> = {},
  replies: GhReplies = {},
) =>
  drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, ...env },
    gh: comparing(
      {
        replies: { viewRepository: REPOSITORY, ...replies },
        sequences: { viewPullRequest: pulls },
      },
      compares,
    ),
  }))

it('returns behind within one poll when the base moves under pending checks', async () => {
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD, compared('behind')])

  expect(result.document).toMatchObject({
    ok: true,
    result: 'behind',
    waited: 30,
    pr: { behind: true },
  })
  expect(result.document.detail).toBe(
    'the head does not contain the tip of main; rebase it before waiting on CI',
  )
  expect(result.elapsed).toBe(30_000)
})

it.each(['pending', 'none', 'passed', 'failed'])(
  'returns behind at once, with no sleep, for a behind head whose checks are %s',
  async (checks) => {
    const result = await waitOn([depPr(1, { checks })], [compared('diverged')])

    expect(result.document).toMatchObject({ ok: true, result: 'behind', waited: 0, reads_ok: 1 })
    expect(result.elapsed).toBe(0)
  },
)

it('answers a rollup that has already failed from the first read, with no sleep', async () => {
  const result = await waitOn(
    [depPr(1, { checks: 'failed' })],
    [AHEAD],
    {},
    {
      readFailedRunLog: 'the failing step\n',
    },
  )

  expect(result.document).toMatchObject({ result: 'failed', log_tail: 'the failing step' })
  expect(result.elapsed).toBe(0)
})

it('polls on when the compare is unavailable, and reports behind: null', async () => {
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'passed' })],
    [UNAVAILABLE],
  )

  expect(result.document).toMatchObject({
    ok: true,
    result: 'passed',
    waited: 30,
    reads_ok: 2,
    read_failures: 0,
    pr: { behind: null },
  })
  expect(result.stderr).toContain('behind is null: the compare of main...sha1 is unavailable')
})

it('returns failed on the first failed rollup, with the log, while other checks still run', async () => {
  // `mixed` is one check still running and one that failed.
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'mixed' })],
    [AHEAD],
    {},
    { readFailedRunLog: 'line 1\nline 2\n' },
  )

  expect(result.document).toMatchObject({
    ok: true,
    result: 'failed',
    waited: 30,
    log_tail: 'line 1\nline 2',
    pr: { checks: { state: 'failed' } },
  })
})

it('reports merged when auto-merge fires during the poll', async () => {
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'passed', state: 'MERGED' })],
    [AHEAD],
  )

  expect(result.document).toMatchObject({ ok: true, result: 'merged', waited: 30 })
})

it('refuses, as ok: false, a bound that ends on a read that failed', async () => {
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'pending' }), ghFails('HTTP 502')],
    [AHEAD],
    { SHEPHERD_WAIT_BOUND: '60' },
  )

  expect(result.document).toMatchObject({
    ok: false,
    bound: 60,
    waited: 60,
    reads_ok: 2,
    read_failures: 1,
    read_error: 'HTTP 502',
  })
  expect(result.document.detail).toBe(
    'wait waited 60s but could not re-read the pull request (1 of 3 reads failed, the last ' +
      'among them): HTTP 502',
  )
  expect(result.document).not.toHaveProperty('result')
})

it('counts a read failure that a later read recovered from, and nothing more', async () => {
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), ghFails('HTTP 502'), depPr(1, { checks: 'passed' })],
    [AHEAD],
  )

  expect(result.document).toMatchObject({
    ok: true,
    result: 'passed',
    waited: 60,
    reads_ok: 2,
    read_failures: 1,
    read_error: '',
  })
})

it('reports pending at the bound, and stops the last sleep at the bound', async () => {
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD], {
    SHEPHERD_WAIT_BOUND: '50',
  })

  expect(result.document).toMatchObject({
    ok: true,
    result: 'pending',
    bound: 50,
    waited: 50,
    reads_ok: 3,
    read_failures: 0,
    pr: { behind: false },
  })
  expect(result.document.detail).toBe('checks still running after 50s')
  expect(result.elapsed).toBe(50_000)
})

it('falls back to a 30 second poll for a SHEPHERD_WAIT_POLL that does not parse', async () => {
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD], {
    SHEPHERD_WAIT_BOUND: '60',
    SHEPHERD_WAIT_POLL: 'often',
  })

  expect(result.stderr).toBe('SHEPHERD_WAIT_POLL=often ignored; using 30\n')
  // Two polls of 30 seconds fill a 60 second bound.
  expect(result.document).toMatchObject({ result: 'pending', waited: 60, reads_ok: 3 })
})

it('reads every SHEPHERD_WAIT_POLL seconds when it is set', async () => {
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD], {
    SHEPHERD_WAIT_BOUND: '60',
    SHEPHERD_WAIT_POLL: '20',
  })

  expect(result.document).toMatchObject({ result: 'pending', waited: 60, reads_ok: 4 })
})

it('refuses a SHEPHERD_WAIT_POLL of 0, which would never reach the bound', async () => {
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD], {
    SHEPHERD_WAIT_BOUND: '60',
    SHEPHERD_WAIT_POLL: '0',
  })

  expect(result.stderr).toBe('SHEPHERD_WAIT_POLL=0 ignored; using 30\n')
  expect(result.document).toMatchObject({ result: 'pending', waited: 60, reads_ok: 3 })
})

it('reports merged, not behind, when auto-merge fires during the poll', async () => {
  // After a merge, the base holds the head, so the compare can read behind.
  // The merge decides first.
  const result = await waitOn(
    [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'passed', state: 'MERGED' })],
    [AHEAD, compared('behind')],
  )

  expect(result.document).toMatchObject({ ok: true, result: 'merged', waited: 30 })
})

it.each([
  ['passed', 'passed', AHEAD],
  ['pending', 'behind', compared('behind')],
] as const)(
  'gives a verdict on the read at the bound: checks %s give %s',
  async (checks, verdict, compare) => {
    const result = await waitOn(
      [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'pending' }), depPr(1, { checks })],
      [AHEAD, AHEAD, compare],
      { SHEPHERD_WAIT_BOUND: '50' },
    )

    expect(result.document).toMatchObject({ ok: true, result: verdict, waited: 50, reads_ok: 3 })
  },
)

it('answers no checks from the first read when the compare is unavailable', async () => {
  const result = await waitOn([depPr(1, { checks: 'none' })], [UNAVAILABLE])

  expect(result.document).toMatchObject({ ok: true, result: 'passed', pr: { behind: null } })
  expect(result.document.detail).toBe('no checks reported on this head')
  expect(result.elapsed).toBe(0)
})

it('compares the head of each poll, not the head of the first read', async () => {
  // Only the new head is behind. A compare of the first head reads ahead,
  // and this would then report passed.
  const server = createGhServer({
    replies: { viewRepository: REPOSITORY },
    sequences: {
      viewPullRequest: [
        depPr(1, { checks: 'pending' }),
        depPr(1, { checks: 'passed', head: 'sha2' }),
      ],
    },
  })
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: sandbox.env,
    gh: {
      ...server,
      compareCommits: async (query) => (query.head === 'sha2' ? compared('behind') : AHEAD),
    },
  }))

  expect(result.document).toMatchObject({
    result: 'behind',
    waited: 30,
    pr: { headRefOid: 'sha2', behind: true },
  })
})

it('clamps the wait bound up to the minimum for a repository with fast CI', async () => {
  // This is the other end of `clamp(ciSeconds * 2, 120, 540)`. `Math.max` is
  // not a branch, so the coverage gate never sees this case. A floor of 1
  // would go unnoticed. A wait that returned after two seconds would report
  // `pending` for a run that had barely started.
  const result = await waitOn([depPr(1, { checks: 'pending' })], [AHEAD], {
    SHEPHERD_CI_SECONDS: '10',
  })

  expect(result.document.bound).toBe(120)
})

it('reports a log gh would not hand over, which is not a job that printed nothing', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    gh: createGhServer({
      prs: [depPr(1, { checks: 'failed' })],
      replies: {
        viewRepository: REPOSITORY,
        compareCommits: AHEAD,
        readFailedRunLog: ghFails('HTTP 502: Bad gateway'),
      },
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
        compareCommits: AHEAD,
        readFailedRunLog: `${esc}[31mred${esc}[0m and plain\n`,
      },
    }),
  }))

  expect(result.document.log_tail).toBe('red and plain')
})
