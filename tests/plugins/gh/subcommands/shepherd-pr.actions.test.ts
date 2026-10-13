// shepherd-pr, part of its tests: usage, the preflight, state, rebase and wait.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import { HELP } from '#gh/subcommands/shepherd-pr.ts'
import { ghFails } from '#harness/gh.ts'
import { createGhServer, depPr } from '#harness/pulls.ts'
import {
  CAPTURE,
  clients,
  drive,
  REPOSITORY,
  recording,
  UPDATED,
  WATCH_BOUND,
  WATCH_PENDING,
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

// --- wait ---------------------------------------------------------------------------

it('does not watch a rollup that has already failed', async () => {
  // In practice, `gh pr checks --watch` sometimes does not return on a
  // terminal rollup. So this command reads the failure from the rollup, and
  // starts no watcher at all. If the code calls `watchChecks` anyway, the
  // unregistered stub throws and names itself.
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
  // If the code reports this as `pending`, the caller waits forever. It
  // waits out an expired token or a 502, one CI cycle at a time. The
  // transcript never says why.
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
  // A watch with no status of its own is not one of the known codes. Whether
  // the bound has fired tells it apart from this command's own kill.
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
  // Exit 1 is gh's own "a check failed" signal, not a failure of gh itself.
  // So the rollup decides.
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
  // This is the other end of `clamp(ciSeconds * 2, 120, 540)`. `Math.max` is
  // not a branch, so the coverage gate never sees this case. A floor of 1
  // would go unnoticed. A wait that returned after two seconds would report
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
  // The merge must land while the WATCHER runs, not before the first read.
  // Otherwise, the test takes the path that skips the watch, and proves
  // nothing. `test_shepherd_pr.py:623` says so in its own docstring.
  // It backs that up: it asserts that the watch happened. So this test
  // asserts the watch's own request here, in full. It does not just count
  // the calls.
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
