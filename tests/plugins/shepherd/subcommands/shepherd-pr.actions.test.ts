// shepherd-pr, part of its tests: usage, the preflight, state, rebase and wait.
// The file is one of several so that vitest can run them at the same time (#205).
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { expect, it } from 'vitest'
import { type GhClient, type GhReplies, type GhResults, ghFails } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { createGhServer, depPr, type GhSequences } from '#harness/pulls.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { HELP, runShepherdPr } from '#shepherd/subcommands/shepherd-pr.ts'
import {
  AHEAD,
  CAPTURE,
  capture,
  clients,
  compared,
  comparing,
  drive,
  HEAD_DATE,
  NO_JOBS,
  NO_RULE,
  REPOSITORY,
  recording,
  UNAVAILABLE,
  UPDATED,
  WALL,
} from './shepherd-pr.test-support.ts'

// --- usage and the preflight ----------------------------------------------------

it('prints its own usage for --help, naming every action it accepts', async () => {
  const result = await drive(() => ({ argv: ['--help'] }))

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${HELP}\n`)
  for (const action of ['state', 'rebase', 'wait', 'settle', 'merged']) {
    expect(result.stdout).toContain(`shepherd.ts shepherd-pr <path> <number> ${action}`)
  }
  expect(result.stderr).toBe('')
})

it('opens its usage with the sentence the Python opened with', async () => {
  // The divergence recorded for `help` is the command name and the skill
  // name, and nothing else. The test reads the sentence in front of it from
  // the capture. It does not restate that sentence. So a rewrite of the
  // first line becomes a divergence, which needs an argument.
  const opening = (CAPTURE.help?.stdout ?? '').split('\n')[0]?.split(' \u2014 ')[1] ?? ''

  expect(opening).not.toBe('')
  // The Python's docstring opened with `gh-shepherd-pr.py \u2014 the ...`.
  // This port uses the same sentence, but with a capital letter where the
  // script name used to be. The skill is `/shepherd:merge` since #477.
  expect(HELP.split('\n')[0]?.toLowerCase()).toBe(
    opening.replace('/gh:shepherd', '/shepherd:merge').toLowerCase(),
  )
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
  // Every read of the poll failed the same way: 12 polls at the defaults.
  expect(result.document).toMatchObject({ ok: true, reads_ok: 0, read_failures: 13 })
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

it.each([
  // gh 2.102 prints this line (cli/cli `pkg/cmd/pr/update-branch/update_branch.go`).
  '✓ PR branch already up-to-date\n',
  '✓ Pull request #1 already up-to-date with base branch\n',
  'Already up to date\n',
])('does not poll when gh says the branch is already up to date: %j', async (line) => {
  const result = await rebaseOn([queued], {}, line)

  expect(result.document).toMatchObject({ ok: true, result: 'up_to_date', waited: 0, reads_ok: 1 })
  expect(result.elapsed).toBe(0)
})

it('reports moved when gh says up to date but the head moved all the same', async () => {
  // The head decides, not gh's line.
  const result = await rebaseOn([queued, moved], {}, '✓ PR branch already up-to-date\n')

  expect(result.document).toMatchObject({ result: 'moved', after: 'rebased-sha1', reads_ok: 1 })
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

/** A `rebase` of pull request 1 on a clock this test controls. Each read
 *  costs `readMs` of the clock. A sleep moves the clock only when
 *  `sleepMoves` is true. A sleep that is not positive, or the 100th sleep,
 *  throws: a loop that does not end then fails, and does not hang. */
const rebaseOnClock = async (
  pulls: NonNullable<GhSequences['viewPullRequest']>,
  env: Record<string, string>,
  readMs: number,
  sleepMoves: boolean,
) => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const writers = capture()
  let elapsed = 0
  let sleeps = 0
  const server = createGhServer({
    replies: { viewRepository: REPOSITORY, updateBranch: UPDATED },
    sequences: { viewPullRequest: pulls },
  })
  const gh: GhClient = {
    ...server,
    viewPullRequest: async (pull) => {
      elapsed += readMs
      return server.viewPullRequest(pull)
    },
  }
  const status = await runShepherdPr([repo, '1', 'rebase'], {
    cwd: repo,
    env: { ...sandbox.env, ...env },
    output: writers.output,
    createGh: () => gh,
    now: () => elapsed,
    clock: () => WALL + elapsed,
    sleep: async (milliseconds) => {
      sleeps += 1
      if (milliseconds <= 0 || sleeps >= 100) throw new Error(`runaway sleep ${milliseconds}`)
      if (sleepMoves) elapsed += milliseconds
    },
  })
  return { status, document: JSON.parse(writers.stdout()) }
}

it('ends at the bound on the clock, when slow reads use up the bound first', async () => {
  // Each read costs 3 seconds. The poll count alone would allow 4 reads.
  // The clock reaches the 10 second bound after 2, so the call stays inside
  // the Bash tool's timeout. `waited` is measured: the sleeps add up to 4.
  const result = await rebaseOnClock(
    [queued],
    { SHEPHERD_REBASE_BOUND: '10', SHEPHERD_REBASE_POLL: '4' },
    3000,
    true,
  )

  expect(result.status).toBe(0)
  expect(result.document).toMatchObject({ result: 'unmoved', waited: 10, reads_ok: 2 })
})

it('ends on the count of polls, when a sleep does not move the clock', async () => {
  const result = await rebaseOnClock(
    [queued],
    { SHEPHERD_REBASE_BOUND: '10', SHEPHERD_REBASE_POLL: '5' },
    0,
    false,
  )

  expect(result.status).toBe(0)
  expect(result.document).toMatchObject({ result: 'unmoved', waited: 0, reads_ok: 3 })
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
  const server = createGhServer({
    prs: [pull],
    replies: { viewRepository: REPOSITORY, requiredReviews: NO_RULE },
  })
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
    gh: comparing(
      { prs: [depPr(1)], replies: { viewRepository: REPOSITORY, requiredReviews: NO_RULE } },
      [compared(status)],
    ),
  }))

  expect(result.document.pr).toMatchObject({ behind })
  expect(result.stderr).toBe('')
})

it('reads a compare it could not get as behind: null, and says why on stderr', async () => {
  const result = await drive((_sandbox, repo) => ({
    argv: [repo, '1', 'state'],
    gh: comparing(
      { prs: [depPr(1)], replies: { viewRepository: REPOSITORY, requiredReviews: NO_RULE } },
      [UNAVAILABLE],
    ),
  }))

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({ behind: null })
  expect(result.stderr).toBe(
    'behind is null: the compare of main...sha1 is unavailable: gh api compare failed: HTTP 502\n',
  )
})

// --- state and the review rules (#465) ----------------------------------------------

/** `state` against pull request `number` (1 unless named), with the review
 *  endpoints given. */
const stateWith = (pull: Record<string, unknown>, extra: Partial<GhClient>, number = 1) =>
  drive((_sandbox, repo) => ({
    argv: [repo, String(number), 'state'],
    gh: {
      ...createGhServer({
        prs: [pull as ReturnType<typeof depPr>],
        replies: { viewRepository: REPOSITORY, compareCommits: AHEAD },
      }),
      ...extra,
    },
  }))

/** Review rules with these flags, as `requiredReviews` answers them. */
const reviewRules = (
  approvals: number,
  flags: { threadResolution?: boolean; lastPush?: boolean } = {},
): GhResults['requiredReviews'] => ({
  reviews: { approvals, codeOwner: false, threadResolution: false, lastPush: false, ...flags },
  unavailable: null,
})

const approvedOn = (oid: string) => ({
  ...depPr(1),
  reviews: [{ author: { login: 'octocat' }, state: 'APPROVED', commit: { oid } }],
})

it('reports approval and threads from the rules of its own base', async () => {
  // Rule 15 (j) on #465. The rules answer only for `release`.
  const result = await stateWith(
    { ...depPr(1), baseRefName: 'release' },
    {
      requiredReviews: async ({ branch }) => {
        if (branch !== 'release') throw new Error('wrong base')
        return reviewRules(1)
      },
    },
  )

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({ approval: 'missing', threads: 'not_required' })
})

it('meets a last-push rule with an approval of the head, and not of an older commit', async () => {
  const rules = { requiredReviews: async () => reviewRules(1, { lastPush: true }) }

  const head = await stateWith(approvedOn('sha1'), rules)
  expect(head.document.pr).toMatchObject({ approval: 'met' })

  const older = await stateWith(approvedOn('sha0'), rules)
  expect(older.document.pr).toMatchObject({ approval: 'missing' })
})

it('reads the threads when the rules ask, and reports them', async () => {
  const threads = (unresolved: number): GhResults['viewPullRequestDetail'] => ({
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
  const asks = { requiredReviews: async () => reviewRules(0, { threadResolution: true }) }

  const open = await stateWith(depPr(1), { ...asks, viewPullRequestDetail: async () => threads(2) })
  expect(open.document.pr).toMatchObject({ approval: 'not_required', threads: 'unresolved' })

  const done = await stateWith(depPr(1), { ...asks, viewPullRequestDetail: async () => threads(0) })
  expect(done.document.pr).toMatchObject({ threads: 'resolved' })

  // The threads of pull request 7, not of another number.
  const seven = await stateWith(
    depPr(7),
    {
      ...asks,
      viewPullRequestDetail: async ({ pullRequest }) => threads(pullRequest === 7 ? 1 : 0),
    },
    7,
  )
  expect(seven.document.pr).toMatchObject({ number: 7, threads: 'unresolved' })

  // A failed thread read is null, not resolved, and stderr says why.
  const failed = await stateWith(depPr(1), {
    ...asks,
    viewPullRequestDetail: async () => ({
      pullRequest: null,
      unavailable: 'gh: HTTP 502',
      missing: false,
    }),
  })
  expect(failed.document.ok).toBe(true)
  expect(failed.document.pr).toMatchObject({ threads: null })
  expect(failed.stderr).toBe(
    'the review threads of #1 cannot be proven resolved: gh: HTTP 502; threads is null\n',
  )
})

it('reports null verdicts when the rules cannot be read, and says why', async () => {
  // Ruling 5: a failed read is not a failed `state`.
  const result = await stateWith(depPr(1), {
    requiredReviews: async () => ({ reviews: null, unavailable: 'gh: HTTP 502' }),
  })

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({ approval: null, threads: null })
  expect(result.stderr).toBe(
    'the review rules of main are unavailable: gh: HTTP 502; approval rests on reviewDecision\n',
  )
})

// --- state and the branch ref (#467) -----------------------------------------------

/** The pull request a field test saw: not from a fork, and GitHub still
 *  names the commit from before the newest push to its branch. */
const STALE_HEAD = '17a37c0ffee0000000000000000000000000000a'
const PUSHED = '18b50c0ffee0000000000000000000000000000b'

/** `state` with no review rule, and the ref endpoint given. */
const syncWith = (pull: Record<string, unknown>, extra: Partial<GhClient>) =>
  stateWith(pull, { requiredReviews: async () => NO_RULE, ...extra })

it('reports a head out of sync with its branch, and names both commits', async () => {
  // Rule 15 (a). The ref answers only for this pull request's own branch.
  const result = await syncWith(depPr(1, { head: STALE_HEAD }), {
    branchRef: async ({ branch }) => {
      if (branch !== 'dependabot/npm/dep-1') throw new Error('wrong branch')
      return { sha: PUSHED, unavailable: null }
    },
  })

  expect(result.status).toBe(0)
  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe(
    `the pull request's head is out of sync with its branch: headRefOid ${STALE_HEAD}, ` +
      `dependabot/npm/dep-1 at ${PUSHED}`,
  )
  expect(result.document.pr).toMatchObject({
    headRefOid: STALE_HEAD,
    behind: false,
    branchRefOid: PUSHED,
    inSync: false,
  })
  expect(result.stderr).toBe('')
})

it('reads a head that matches its branch as in sync, with the detail it had before', async () => {
  // Rule 15 (b). The server answers the ref with the head of the row.
  const result = await syncWith(depPr(1), {})

  expect(result.document.detail).toBe('read')
  const pr = result.document.pr as Record<string, unknown>
  expect(Object.keys(pr).slice(-3)).toEqual(['behind', 'branchRefOid', 'inSync'])
  expect(pr).toMatchObject({ headRefOid: 'sha1', branchRefOid: 'sha1', inSync: true })
  expect(result.stderr).toBe('')
})

it('reads no ref for a pull request from another repository', async () => {
  // Rule 15 (c). A fork's branch is not a branch here: `main` of a fork is
  // not this repository's `main`. A call to the ref fails the test.
  const result = await syncWith(
    { ...depPr(1), headRefName: 'main', isCrossRepository: true },
    {
      branchRef: async () => {
        throw new Error('a ref read for a fork')
      },
    },
  )

  expect(result.document.detail).toBe('read')
  expect(result.document.pr).toMatchObject({ branchRefOid: null, inSync: null })
  expect(result.stderr).toBe('')
})

it('decides as before when the ref cannot be read, and says why on stderr', async () => {
  // Rule 15 (d).
  const result = await syncWith(depPr(1), {
    branchRef: async () => ({ sha: null, unavailable: 'gh: API rate limit exceeded' }),
  })

  expect(result.document.ok).toBe(true)
  expect(result.document.detail).toBe('read')
  expect(result.document.pr).toMatchObject({ behind: false, branchRefOid: null, inSync: null })
  expect(result.stderr).toBe(
    'inSync is null: the ref of dependabot/npm/dep-1 is unavailable: gh: API rate limit exceeded\n',
  )
})

it.each([
  ['without isCrossRepository', { isCrossRepository: undefined }, 'isCrossRepository'],
  ['with a fork flag that is not a boolean', { isCrossRepository: 'false' }, 'isCrossRepository'],
  ['without headRefName', { headRefName: undefined }, 'headRefName'],
  ['with an empty headRefName', { headRefName: '' }, 'headRefName'],
])('reads no ref for an answer %s, and says why on stderr', async (_what, fields, missing) => {
  // An answer that does not say the head is in this repository is not
  // read as one: a fork's `main` read as `main` here would differ.
  const result = await syncWith(
    { ...depPr(1), ...fields },
    {
      branchRef: async () => {
        throw new Error('a ref read without the fields it needs')
      },
    },
  )

  expect(result.document.ok).toBe(true)
  expect(result.document.pr).toMatchObject({ branchRefOid: null, inSync: null })
  expect(result.stderr).toBe(`inSync is null: gh answered without ${missing}\n`)
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
  // `unreported` is `shepherd-stack`'s field. The report of a pull request
  // has no such key.
  expect(result.document).not.toHaveProperty('unreported')
  expect(result.elapsed).toBe(50_000)
})

// --- wait and the progress of the checks (#466) ------------------------------------

/** A stamp in gh's form, `ms` after the epoch. */
const stampAt = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')

/** gh's word for a stamp GitHub has not set: Go's zero time. */
const ZERO_TIME = '0001-01-01T00:00:00Z'

/** Pull request 1 with a run in progress: every check started at `started`,
 *  one check finished at each of `done`, and `test` still runs. The stamps
 *  have the shape gh answered for #471 on 2026-10-20. */
const running = (started: number, done: readonly number[] = []) => ({
  ...depPr(1),
  statusCheckRollup: [
    ...done.map((finished, index) => ({
      __typename: 'CheckRun',
      name: `job-${index}`,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: stampAt(started),
      completedAt: stampAt(finished),
      detailsUrl: `https://github.com/acme/widgets/actions/runs/11/job/3${index}`,
    })),
    {
      __typename: 'CheckRun',
      name: 'test',
      status: 'IN_PROGRESS',
      conclusion: null,
      startedAt: stampAt(started),
      completedAt: ZERO_TIME,
      detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/21',
    },
  ],
})

/** A `wait` on pull request 1 with the wall clock at `wall`. */
const waitAt = (
  wall: number,
  pulls: NonNullable<GhSequences['viewPullRequest']>,
  env: Record<string, string> = {},
  replies: GhReplies = {},
) =>
  drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, ...env },
    wall,
    gh: comparing(
      {
        replies: { viewRepository: REPOSITORY, ...replies },
        sequences: { viewPullRequest: pulls },
      },
      [AHEAD],
    ),
  }))

const MINUTE = 60_000
/** When the field test's rebase landed: 2026-10-19 at 20:14 UTC. */
const REBASED = Date.parse('2026-10-19T20:14:00Z')

it('never skips a run whose checks still finish, past three pending results', async () => {
  // Rule 15 (e), the field test of #466. `ci_seconds` 130 gives each call a
  // 260 second bound, and the CI takes 17 minutes. A check finishes about
  // every four minutes, so each call reads a newer stamp than the last.
  const finishes = [3, 7, 11, 15].map((minutes) => REBASED + minutes * MINUTE)
  const finished: number[] = []
  for (let call = 0; call < 5; call += 1) {
    const wall = REBASED + call * 270_000
    const result = await waitAt(
      wall,
      [
        running(
          REBASED,
          finishes.filter((at) => at <= wall),
        ),
      ],
      { SHEPHERD_CI_SECONDS: '130' },
    )

    expect(result.document).toMatchObject({ ok: true, result: 'pending', bound: 260 })
    const progress = result.document.progress as Record<string, number>
    expect(progress.idle).toBeLessThan(progress.stall_bound as number)
    finished.push(progress.finished as number)
  }
  expect(finished).toEqual([0, 1, 2, 3, 4])
})

it('reports stalled once no check started or finished for the bound, with the progress', async () => {
  // Rule 15 (f). The newest stamp is 1500 seconds old when the call starts.
  // Reads every 30 seconds see it at 1530, 1560, 1590 and 1620 seconds.
  const newest = REBASED + 2 * MINUTE
  const result = await waitAt(newest + 1_500_000, [running(REBASED, [newest])])

  expect(result.document).toMatchObject({
    ok: true,
    result: 'stalled',
    waited: 120,
    reads_ok: 5,
    read_failures: 0,
    read_error: '',
    pr: { checks: { state: 'pending' }, behind: false },
    progress: {
      finished: 1,
      checks: 2,
      started: '2026-10-19T20:14:00Z',
      newest: '2026-10-19T20:16:00Z',
      idle: 1620,
      stall_bound: 1620,
    },
  })
  expect(result.document.detail).toBe(
    'no check started or finished for 1620s; the stall bound is 1620s',
  )
  expect(Object.keys(result.document).at(-1)).toBe('progress')
  expect(result.elapsed).toBe(120_000)
})

it('reports stalled from the first read, with no sleep, for a run already still', async () => {
  // Each call decides from the rollup alone, so a hung check ends in a skip
  // whatever the calls before it saw.
  const result = await waitAt(REBASED + 30 * MINUTE, [running(REBASED)])

  expect(result.document).toMatchObject({
    result: 'stalled',
    waited: 0,
    reads_ok: 1,
    progress: { newest: '2026-10-19T20:14:00Z', idle: 1800, stall_bound: 1620 },
  })
  expect(result.elapsed).toBe(0)
})

it('gives a long run a bound as long as the run, so a long quiet job is not a stall', async () => {
  // 40 minutes of progress, then 30 minutes with none: past the floor of
  // 27 minutes, but not past the run's own time.
  const newest = REBASED + 40 * MINUTE
  const result = await waitAt(newest + 30 * MINUTE, [running(REBASED, [newest])], {
    SHEPHERD_WAIT_BOUND: '60',
  })

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { idle: 1860, stall_bound: 2400 },
  })
})

it('gives one long job a bound of twice the median run time, so it is not a stall', async () => {
  // A short job finishes at two minutes, and `test` runs on. Its stamps do
  // not move until it finishes. Twice a 20 minute median is 40 minutes,
  // past the floor of 27.
  const newest = REBASED + 2 * MINUTE
  const env = { SHEPHERD_CI_SECONDS: '1200', SHEPHERD_WAIT_BOUND: '30' }

  // The last read comes 30 seconds after the first.
  const quiet = await waitAt(newest + 30 * MINUTE, [running(REBASED, [newest])], env)
  expect(quiet.document).toMatchObject({
    result: 'pending',
    progress: { idle: 1830, stall_bound: 2400 },
  })

  const hung = await waitAt(newest + 40 * MINUTE, [running(REBASED, [newest])], env)
  expect(hung.document).toMatchObject({
    result: 'stalled',
    progress: { idle: 2400, stall_bound: 2400 },
  })
})

it('reads the progress of a rollup of StatusContext rows from their startedAt', async () => {
  // Rule 15 (g). gh gives a StatusContext a `startedAt`: the time of its
  // newest status (#470, 2026-10-20). A new status is progress.
  const posted = REBASED + 5 * MINUTE
  const pull = {
    ...depPr(1),
    statusCheckRollup: [
      {
        __typename: 'StatusContext',
        context: 'workstreams/review-1',
        state: 'PENDING',
        startedAt: stampAt(REBASED),
        targetUrl: '',
      },
      {
        __typename: 'StatusContext',
        context: 'workstreams/rot-check',
        state: 'SUCCESS',
        startedAt: stampAt(posted),
        targetUrl: '',
      },
    ],
  }

  const still = await waitAt(posted + 27 * MINUTE, [pull])
  expect(still.document).toMatchObject({
    result: 'stalled',
    progress: { finished: 1, checks: 2, idle: 1620, stall_bound: 1620 },
  })

  const moving = await waitAt(posted + MINUTE, [pull], { SHEPHERD_WAIT_BOUND: '30' })
  expect(moving.document).toMatchObject({ result: 'pending', progress: { idle: 90 } })
})

it('measures a rollup with no stamp from the head commit, so it ends in stalled', async () => {
  // Ruling 13, and rule 15 (g): StatusContext rows without a `startedAt`.
  // A hung check that never started cannot hold the run forever.
  const since = { date: stampAt(REBASED), unavailable: null }
  const pull = depPr(1, { checks: 'status-pending' })

  const early = await waitAt(
    REBASED + 5 * MINUTE,
    [pull],
    { SHEPHERD_WAIT_BOUND: '30' },
    {
      commitDate: since,
    },
  )
  expect(early.document).toMatchObject({
    result: 'pending',
    progress: { newest: '2026-10-19T20:14:00Z', idle: 330, source: 'head commit' },
  })

  const late = await waitAt(REBASED + 27 * MINUTE, [pull], {}, { commitDate: since })
  expect(late.document).toMatchObject({
    result: 'stalled',
    waited: 0,
    progress: {
      finished: 0,
      checks: 1,
      started: '2026-10-19T20:14:00Z',
      newest: '2026-10-19T20:14:00Z',
      idle: 1620,
      stall_bound: 1620,
      source: 'head commit',
    },
  })
})

it('measures a rollup with no stamp from the last update of the pull request, when that is newer', async () => {
  // A commit made a day before its push has an old committer date. A push
  // moves `updatedAt`, so the first read of a new run is not a stall.
  const pull = { ...depPr(1, { checks: 'status-pending' }), updatedAt: stampAt(REBASED) }
  const result = await waitAt(
    REBASED + 5 * MINUTE,
    [pull],
    { SHEPHERD_WAIT_BOUND: '30' },
    { commitDate: { date: stampAt(REBASED - 24 * 60 * MINUTE), unavailable: null } },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { newest: '2026-10-19T20:14:00Z', idle: 330, source: 'head commit' },
  })
})

it('stays pending when no stamp exists and the head date cannot be read, and says why', async () => {
  const result = await waitAt(
    REBASED + 600 * MINUTE,
    [depPr(1, { checks: 'status-pending' })],
    { SHEPHERD_WAIT_BOUND: '60' },
    { commitDate: { date: null, unavailable: 'gh: HTTP 502' } },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { newest: null, idle: null, source: null },
  })
  // Three reads meet the same failure. stderr says it once. The row has no
  // `updatedAt`, so the head has no date at all.
  expect(result.stderr).toBe(
    'the date of sha1 is unavailable: gh: HTTP 502\n' +
      'idle is null: no check has a stamp, and the head has no date to read\n',
  )
})

// --- the steps of the jobs (ruling 12) ---------------------------------------------

/** The jobs of run 11: one job, `test`, that started at `started`, with a
 *  step that finished at each of `done`, and one step still running. The
 *  shape is what `listRunJobs` read for #471 on 2026-10-20. */
const jobsOf = (started: number, done: readonly number[]): GhResults['listRunJobs'] => ({
  rows: [
    {
      id: 21,
      startedAt: stampAt(started),
      completedAt: null,
      steps: [
        ...done.map((finished, index) => ({
          startedAt: stampAt(index === 0 ? started : (done[index - 1] as number)),
          completedAt: stampAt(finished),
        })),
        { startedAt: stampAt(done.at(-1) ?? started), completedAt: null },
        { startedAt: null, completedAt: null },
      ],
    },
  ],
  unavailable: null,
})

it('never stalls one long job whose steps finish every few minutes, the #466 field case', async () => {
  // Rule 15 (e) with ruling 12. `ci_seconds` 130, one job that runs 15
  // minutes, and its steps finish every three minutes. The rollup stamps sit
  // still at 20:14 the whole time.
  const steps = [3, 6, 9, 12, 15].map((minutes) => REBASED + minutes * MINUTE)
  for (let call = 0; call < 6; call += 1) {
    const wall = REBASED + call * 4 * MINUTE
    const result = await waitAt(
      wall,
      [running(REBASED)],
      { SHEPHERD_CI_SECONDS: '130' },
      {
        listRunJobs: jobsOf(
          REBASED,
          steps.filter((at) => at <= wall),
        ),
      },
    )

    expect(result.document).toMatchObject({ result: 'pending', bound: 260 })
    const progress = result.document.progress as Record<string, number>
    expect(progress.idle).toBeLessThan(progress.stall_bound as number)
  }
})

it('reads the steps again on each poll, so a step that finishes during a call counts', async () => {
  // The rollup is 26 minutes still when the call starts, and would pass the
  // 27 minute bound before the call ends. A step finishes before the second
  // read, so the call ends pending, not stalled.
  const answers = [jobsOf(REBASED, []), jobsOf(REBASED, [REBASED + 26 * MINUTE + 10_000])]
  let read = 0
  const server = comparing(
    { replies: { viewRepository: REPOSITORY }, sequences: { viewPullRequest: [running(REBASED)] } },
    [AHEAD],
  )
  const result = await drive((sandbox, repo) => ({
    argv: [repo, '1', 'wait'],
    env: { ...sandbox.env, SHEPHERD_WAIT_BOUND: '120' },
    wall: REBASED + 26 * MINUTE,
    gh: {
      ...server,
      // The first read sees no step done, and every later read sees one.
      listRunJobs: async () => {
        const answer = answers[Math.min(read, 1)] as GhResults['listRunJobs']
        read += 1
        return answer
      },
    },
  }))

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { newest: '2026-10-19T20:40:10Z', idle: 110, source: 'checks' },
  })
})

it('reports stalled for a job whose steps stop for the bound', async () => {
  const last = REBASED + 5 * MINUTE
  const result = await waitAt(
    last + 27 * MINUTE,
    [running(REBASED)],
    {},
    {
      listRunJobs: jobsOf(REBASED, [REBASED + 2 * MINUTE, last]),
    },
  )

  expect(result.document).toMatchObject({
    result: 'stalled',
    waited: 0,
    progress: {
      started: '2026-10-19T20:14:00Z',
      newest: '2026-10-19T20:19:00Z',
      idle: 1620,
      stall_bound: 1620,
      source: 'checks',
    },
  })
})

it('decides from the rollup alone when the jobs cannot be read, and says why once', async () => {
  const result = await waitAt(
    REBASED + 5 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '60' },
    { listRunJobs: { rows: [], unavailable: 'gh: API rate limit exceeded' } },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { newest: '2026-10-19T20:14:00Z', idle: 360, source: 'checks' },
  })
  expect(result.stderr).toBe('progress may miss steps of run 11: gh: API rate limit exceeded\n')
})

it('reports no stall under twice the bound on a read whose jobs read failed', async () => {
  // The rollup alone is 30 minutes still, past the 27 minute bound. Only
  // the steps could prove progress, and they could not be read. So the
  // bound is twice 1620 seconds, and the call ends pending (ruling 3 on
  // #476).
  const result = await waitAt(
    REBASED + 30 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '60' },
    { listRunJobs: { rows: [], unavailable: 'gh: HTTP 502' } },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { idle: 1860, stall_bound: 3240, source: 'checks' },
  })
  expect(result.stderr).toBe('progress may miss steps of run 11: gh: HTTP 502\n')
})

it('reports stalled at twice the bound when the jobs read fails on every poll, the #476 field case', async () => {
  // The call starts 50 minutes after the last stamp, and each poll is 30
  // seconds. The jobs read fails on each one. The poll at 54 minutes is the
  // first to reach twice 1620 seconds, so the earlier polls end in no
  // verdict.
  const result = await waitAt(
    REBASED + 50 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '540' },
    { listRunJobs: { rows: [], unavailable: 'gh: HTTP 502' } },
  )

  expect(result.document).toMatchObject({
    result: 'stalled',
    waited: 240,
    detail: 'no check started or finished for 3240s; the stall bound is 3240s',
    progress: { idle: 3240, stall_bound: 3240, source: 'checks' },
  })
  // Stderr says why once, though each poll missed.
  expect(result.stderr).toBe('progress may miss steps of run 11: gh: HTTP 502\n')
})

it('never stalls a null idle, on a read whose jobs read failed', async () => {
  // A queued job: its row has a link to its run, and no stamp yet.
  const queued = {
    ...depPr(1),
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'test',
        status: 'QUEUED',
        conclusion: null,
        startedAt: ZERO_TIME,
        completedAt: ZERO_TIME,
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/21',
      },
    ],
  }
  const result = await waitAt(
    REBASED + 600 * MINUTE,
    [queued],
    { SHEPHERD_WAIT_BOUND: '60' },
    {
      listRunJobs: { rows: [], unavailable: 'gh: HTTP 502' },
      commitDate: { date: null, unavailable: 'gh: HTTP 502' },
    },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { idle: null, stall_bound: 3240, source: null },
  })
})

it('doubles a stall bound that the run span sets, on a read whose jobs were read in part', async () => {
  // The steps read run from 20:14 to 20:54, so the span is 2400 seconds,
  // past the 1620 second floor. A part read doubles that span. The last
  // read is at the 30 second bound.
  const last = REBASED + 40 * MINUTE
  const result = await waitAt(
    last + 60 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '30' },
    {
      listRunJobs: {
        ...jobsOf(REBASED, [last]),
        unavailable: 'run 11 has 2500 jobs; 2000 were read',
      },
    },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { idle: 3630, stall_bound: 4800 },
  })
})

it('keeps the steps it read from a run whose jobs were read in part', async () => {
  const part = {
    ...jobsOf(REBASED, [REBASED + 4 * MINUTE]),
    unavailable: 'run 11 has 120 jobs; 100 were read',
  }
  const result = await waitAt(
    REBASED + 5 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '30' },
    {
      listRunJobs: part,
    },
  )

  expect(result.document).toMatchObject({ progress: { newest: '2026-10-19T20:18:00Z' } })
  expect(result.stderr).toBe(
    'progress may miss steps of run 11: run 11 has 120 jobs; 100 were read\n',
  )
})

it.each([
  // Each wall time is under the 27 minute bound for the stamp the case
  // names, and reaches it for every older stamp.
  ['a job that finished after its last step', '2026-10-19T20:22:00Z', '2026-10-19T20:16:00Z', 30],
  ['a step that finished, with no step after it', null, '2026-10-19T20:21:00Z', 30],
  ['a step that started, and still runs', null, null, 27],
])('reads %s as progress', async (_case, jobDone, stepDone, minutes) => {
  const jobs = {
    rows: [
      {
        id: 21,
        startedAt: stampAt(REBASED),
        completedAt: jobDone,
        steps: [{ startedAt: stampAt(REBASED + MINUTE), completedAt: stepDone }],
      },
    ],
    unavailable: null,
  }
  const result = await waitAt(
    REBASED + minutes * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '30' },
    { listRunJobs: jobs },
  )

  expect(result.document).toMatchObject({
    result: 'pending',
    progress: { newest: jobDone ?? stepDone ?? '2026-10-19T20:15:00Z', source: 'checks' },
  })
})

it('reads no head date for a pending rollup with a stamp', async () => {
  // The head date stands in only when no check has a stamp, so a call to
  // it fails the test.
  const result = await waitAt(
    REBASED + 5 * MINUTE,
    [running(REBASED)],
    { SHEPHERD_WAIT_BOUND: '30' },
    { commitDate: ghFails('a head date read for stamped checks') as never },
  )

  expect(result.document).toMatchObject({ result: 'pending', progress: { source: 'checks' } })
  expect(result.stderr).toBe('')
})

it('reads no jobs and no head date for a rollup that is not pending', async () => {
  // Each read throws, so a call to either fails the test.
  const result = await waitAt(
    REBASED,
    [depPr(1, { checks: 'failed' })],
    {},
    {
      listRunJobs: ghFails('a jobs read for finished checks') as never,
      commitDate: ghFails('a head date read for finished checks') as never,
      readFailedRunLog: 'line 1\n',
    },
  )

  expect(result.document).toMatchObject({ result: 'failed' })
  expect(result.document).not.toHaveProperty('progress')
})

it('takes the floor of the stall bound from SHEPHERD_STALL_FLOOR', async () => {
  // Twice a 30 second median is under the floor, so the floor decides.
  const result = await waitAt(REBASED + 3 * MINUTE, [running(REBASED)], {
    SHEPHERD_STALL_FLOOR: '120',
    SHEPHERD_CI_SECONDS: '30',
  })

  expect(result.document).toMatchObject({
    result: 'stalled',
    waited: 0,
    progress: { idle: 180, stall_bound: 120 },
  })
})

it('falls back to a 1620 second floor for a SHEPHERD_STALL_FLOOR that does not parse', async () => {
  for (const floor of ['abc', '0']) {
    const result = await waitAt(REBASED + 3 * MINUTE, [running(REBASED)], {
      SHEPHERD_STALL_FLOOR: floor,
      SHEPHERD_WAIT_BOUND: '30',
    })

    expect(result.document).toMatchObject({ result: 'pending', progress: { stall_bound: 1620 } })
    expect(result.stderr).toBe(`SHEPHERD_STALL_FLOOR=${floor} ignored; using 1620\n`)
  }
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
    replies: { viewRepository: REPOSITORY, listRunJobs: NO_JOBS, commitDate: HEAD_DATE },
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
