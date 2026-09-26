// shepherd-pr, part of its tests: usage, the preflight, state, rebase, recreate and wait.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import { HELP } from '#gh/subcommands/shepherd-pr.ts'
import { ghFails } from '#harness/gh.ts'
import { createGhServer, depPr } from '#harness/pulls.ts'
import {
  CAPTURE,
  COMMENT_URL,
  clients,
  drive,
  REPOSITORY,
  recording,
  recreateEnv,
  UPDATED,
  WATCH_BOUND,
  WATCH_PENDING,
} from './shepherd-pr.test-support.ts'

// --- usage and the preflight ----------------------------------------------------

it('prints its own usage for --help, naming every action it accepts', async () => {
  const result = await drive(() => ({ argv: ['--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'merged']) {
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

it('accepts every action it advertises', async () => {
  // An action the command runs but does not advertise is one nobody calls.
  // One it advertises and rejects is worse.
  for (const action of ['state', 'rebase', 'recreate', 'wait', 'settle', 'merged']) {
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
  // The snapshot reported is the one that gave the moved head, not the one
  // the poll started with (`test_shepherd_pr.py:370`).
  expect((result.document.pr as Record<string, unknown>).headRefOid).toBe('recreated')
})

it('posts the words Dependabot answers, on the pull request it was given', async () => {
  // Only one bot answers `@dependabot recreate`. Any other text becomes a
  // comment that sits on a stranger's pull request forever
  // (`gh-shepherd-pr.py:533` to `:541`).
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
  // `is_bot` still reports what it is, so the report can say why it stopped.
  // The action itself turns on `is_dependabot`. The captured refusal has a
  // HUMAN author. So nothing there tells `!is_dependabot` and `!is_bot`
  // apart. Under `!is_bot`, this command would post `@dependabot recreate` on
  // a renovate pull request. Nothing will ever answer that comment
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
  // A poll that could not read the pull request says nothing about it. So
  // the read that followed becomes the answer. The status is still `ok`,
  // since the recreate comment already went out (`test_shepherd_pr.py:437`
  // and `:439`).
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
  // The Python reports `pr` from the same variable it assigns the failed
  // read to. So a run whose last poll failed carries a null pull request.
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
  // The interval is a quarter of the cycle, floored at 15 seconds. The bound
  // is two cycles. With 400, the interval is 100 and the bound is 800. That
  // gives eight polls, with no delay at all.
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

  // A bound of 16 seconds with a floor of 15 buys two polls. The second poll
  // runs past the bound. The loop is `while waited < bound`, exactly as the
  // Python's is.
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
  // A zero value would spin and never reach the bound. The shell version did
  // exactly that.
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
