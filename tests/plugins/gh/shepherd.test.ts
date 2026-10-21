// This file has one named test for each branch of every fold in
// `shepherd.ts`. `tests/gh/test_shepherd_lib.py` uses the same organisation.
// `.claude/rules/type-py.md` line 36 explains why: three mutations of the
// check-state fold once left a 219-example suite green. Coverage stayed
// unmoved.
//
// The `jq` expression it replaced was one line, however many outcomes it
// decided between. This suite checked each test here by mutation. A change
// to that branch in `shepherd.ts` must make its named test fail on its own.
//
// **Issue #127 deleted the Python code this file ports.**
// `plugins/gh/scripts/*.py`, its `lib/`, `plugins/gh/hooks/hook-io.py`, and
// `tests/gh/` are gone from the tree. The file and line references below
// point to commit `cd0d515`, the last commit that held them. Each reference
// states where a rule came from.
import { describe, expect, it } from 'vitest'
import {
  approvalOf,
  autoMergeBases,
  checkLink,
  checkName,
  checkProgress,
  checkState,
  checks,
  ciSeconds,
  failedRequired,
  isBot,
  isDependabot,
  isTruthy,
  layerReasons,
  missingField,
  type NotReady,
  oneLine,
  type PullSummary,
  pendingRuns,
  rank,
  statusDocument,
  summary,
  tailLines,
  threadReads,
  threadsOf,
  unreportedRequired,
} from '#gh/shepherd.ts'

const checkRun = (status: string, conclusion: string | null, name = 'build') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: 'https://github.com/acme/widgets/actions/runs/11/job/21',
})

const statusContext = (state: string, context = 'ci/legacy') => ({
  __typename: 'StatusContext',
  context,
  state,
  targetUrl: 'https://ci.example/1',
})

/** A pull request that has every field the loop decides from. */
const readable = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: 'OPEN',
  headRefOid: 'sha1',
  baseRefName: 'main',
  statusCheckRollup: [],
  reviewDecision: '',
  labels: [],
  ...overrides,
})

// --- isTruthy, the guard every `or` in the Python rests on --------------------

describe('isTruthy', () => {
  it('reads null and a field gh did not send as nothing', () => {
    expect(isTruthy(null)).toBe(false)
    expect(isTruthy(undefined)).toBe(false)
  })

  it('reads an empty string as nothing, which is what `??` gets wrong', () => {
    // This is the whole reason this function exists. `reviewDecision` is
    // "" on a repository that requires no review. `headRefOid` is "" when
    // gh answers with no SHA. `value ?? fallback` would keep both as real
    // answers.
    expect(isTruthy('')).toBe(false)
    expect(isTruthy('REVIEW_REQUIRED')).toBe(true)
  })

  it('reads zero as nothing and a number as something', () => {
    expect(isTruthy(0)).toBe(false)
    expect(isTruthy(1)).toBe(true)
  })

  it('reads false as nothing and true as something', () => {
    expect(isTruthy(false)).toBe(false)
    expect(isTruthy(true)).toBe(true)
  })

  it('reads an empty list as nothing and a list with a row as something', () => {
    expect(isTruthy([])).toBe(false)
    expect(isTruthy([null])).toBe(true)
  })

  it('reads an empty object as nothing and an object with a key as something', () => {
    expect(isTruthy({})).toBe(false)
    expect(isTruthy({ login: 'someone' })).toBe(true)
  })
})

// --- checkState, one test per arm ---------------------------------------------

describe('checkState', () => {
  it.each(['SUCCESS', 'NEUTRAL', 'SKIPPED'])(
    'passes %s: finished and not in the way',
    (conclusion) => {
      // Mutation two in the rule's list removes NEUTRAL from the pass set.
      expect(checkState(checkRun('COMPLETED', conclusion))).toBe('passed')
    },
  )

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])(
    'fails %s, which is completed and not a pass',
    (conclusion) => {
      // Mutation one narrows this arm. A cancelled build would then poll
      // forever.
      expect(checkState(checkRun('COMPLETED', conclusion))).toBe('failed')
    },
  )

  it('fails a completed run with no conclusion at all', () => {
    // This fold must never treat a null conclusion as success.
    expect(checkState(checkRun('COMPLETED', null))).toBe('failed')
  })

  it.each(['QUEUED', 'IN_PROGRESS', 'WAITING'])('calls an unfinished %s check run pending', (s) => {
    // Mutation three inverts the COMPLETED arm.
    expect(checkState(checkRun(s, null))).toBe('pending')
  })

  it('reads a green status context by its state', () => {
    expect(checkState(statusContext('SUCCESS'))).toBe('passed')
  })

  it.each(['PENDING', 'EXPECTED'])('calls an unfinished status context (%s) pending', (state) => {
    expect(checkState(statusContext(state))).toBe('pending')
  })

  it.each(['FAILURE', 'ERROR'])('fails a red status context (%s)', (state) => {
    expect(checkState(statusContext(state))).toBe('failed')
  })

  it('does not let a status context fall through to conclusion', () => {
    // A check that dispatches on a `conclusion ?? state` chain, instead of
    // on `__typename`, would call every pending StatusContext failed. It
    // has no conclusion to give.
    const row = statusContext('PENDING')

    expect('conclusion' in row).toBe(false)
    expect(checkState(row)).toBe('pending')
  })

  it('calls a row that is not an object pending', () => {
    // GraphQL can answer with a null element in the rollup. If this fold
    // read that null as failed, it would report a green pull request as
    // broken.
    expect(checkState(null)).toBe('pending')
    expect(checkState('build')).toBe('pending')
  })

  it('reads a row with no __typename as a check run', () => {
    // gh omits `__typename` unless a caller asks for it. CheckRun is the
    // default arm.
    expect(checkState({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('passed')
  })
})

// --- checkName and checkLink --------------------------------------------------

describe('checkName and checkLink', () => {
  it('names a check run by its name and links it by its detailsUrl', () => {
    expect(checkName(checkRun('COMPLETED', 'FAILURE'))).toBe('build')
    expect(checkLink(checkRun('COMPLETED', 'FAILURE'))).toContain('/actions/runs/11/job/21')
  })

  it('names a status context by its context and links it by its targetUrl', () => {
    expect(checkName(statusContext('FAILURE'))).toBe('ci/legacy')
    expect(checkLink(statusContext('FAILURE'))).toBe('https://ci.example/1')
  })

  it('keeps a name that is the empty string rather than reading the other shape', () => {
    // `is None`, not truthiness: a check named "" has a name.
    expect(checkName({ name: '', context: 'ci/legacy' })).toBe('')
    expect(checkLink({ detailsUrl: '', targetUrl: 'https://ci.example/1' })).toBe('')
  })

  it('answers null for a row that names or links nothing', () => {
    expect(checkName({})).toBeNull()
    expect(checkLink({})).toBeNull()
  })
})

// --- checks, the rollup fold --------------------------------------------------

describe('checks', () => {
  it('calls a rollup holding a null row pending', () => {
    expect(checks({ statusCheckRollup: [null] }).state).toBe('pending')
  })

  it('calls an empty rollup none', () => {
    expect(checks({ statusCheckRollup: [] }).state).toBe('none')
  })

  it('calls a missing rollup none', () => {
    expect(checks({}).state).toBe('none')
  })

  it('calls a rollup that is not a list at all none', () => {
    expect(checks({ statusCheckRollup: 'nonsense' }).state).toBe('none')
  })

  it('calls an all green rollup passed', () => {
    const rollup = [checkRun('COMPLETED', 'SUCCESS', 'test'), checkRun('COMPLETED', 'SKIPPED')]

    expect(checks({ statusCheckRollup: rollup }).state).toBe('passed')
  })

  it('calls a rollup with something running pending', () => {
    const rollup = [checkRun('COMPLETED', 'SUCCESS', 'test'), checkRun('IN_PROGRESS', null)]

    expect(checks({ statusCheckRollup: rollup }).state).toBe('pending')
  })

  it('lets a failure win over a pending row', () => {
    // The loop should classify a known failure now rather than wait out the run.
    const rollup = [checkRun('IN_PROGRESS', null, 'test'), checkRun('COMPLETED', 'FAILURE')]

    expect(checks({ statusCheckRollup: rollup }).state).toBe('failed')
  })

  it('names and links only the failing rows', () => {
    const rollup = [checkRun('COMPLETED', 'SUCCESS', 'test'), checkRun('COMPLETED', 'FAILURE')]

    expect(checks({ statusCheckRollup: rollup }).failing).toEqual([
      { name: 'build', link: 'https://github.com/acme/widgets/actions/runs/11/job/21' },
    ])
  })

  it('names a failing status context by its context and target url', () => {
    expect(checks({ statusCheckRollup: [statusContext('FAILURE')] }).failing).toEqual([
      { name: 'ci/legacy', link: 'https://ci.example/1' },
    ])
  })

  it('reports a null link for a failing row that has none', () => {
    const row = { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAIL' }

    expect(checks({ statusCheckRollup: [row] }).failing).toEqual([{ name: 'build', link: null }])
  })
})

// --- missingField, one test per required field --------------------------------

describe('checkProgress', () => {
  /** A CheckRun with the two stamps gh gives it. */
  const stamped = (status: string, startedAt: string, completedAt = ZERO, name = 'build') => ({
    ...checkRun(status, status === 'COMPLETED' ? 'SUCCESS' : null, name),
    startedAt,
    completedAt,
  })
  /** gh's word for a stamp GitHub has not set: Go's zero time. */
  const ZERO = '0001-01-01T00:00:00Z'
  const at = (stamp: string): number => Date.parse(stamp)

  it('reads the rollup of a run in progress, as gh answered for #471 on 2026-10-20', () => {
    // The running checks carry the zero time as `completedAt`.
    const rollup = [
      stamped('IN_PROGRESS', '2026-10-20T22:15:19Z', ZERO, 'vitest'),
      stamped('COMPLETED', '2026-10-20T22:15:18Z', '2026-10-20T22:15:18Z', 'Analyze'),
      stamped('COMPLETED', '2026-10-20T22:15:19Z', '2026-10-20T22:15:29Z', 'Label pull request'),
      stamped('IN_PROGRESS', '2026-10-20T22:15:20Z', ZERO, 'eslint'),
    ]

    expect(checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T22:20:29Z'), 600)).toEqual({
      finished: 2,
      checks: 4,
      started: '2026-10-20T22:15:18Z',
      newest: '2026-10-20T22:15:29Z',
      idle: 300,
      stall_bound: 600,
      source: 'checks',
    })
  })

  it('takes the newest of every stamp, whatever their order within a row', () => {
    // A skipped CodeQL check on #470 finished at 21:58:29 and started at 21:58:36.
    const rollup = [stamped('COMPLETED', '2026-10-20T21:58:36Z', '2026-10-20T21:58:29Z')]

    expect(
      checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T21:58:46Z'), 600),
    ).toMatchObject({ started: '2026-10-20T21:58:29Z', newest: '2026-10-20T21:58:36Z', idle: 10 })
  })

  it('makes the bound the run’s own time from its first stamp to its newest, past the floor', () => {
    const rollup = [
      stamped('COMPLETED', '2026-10-20T20:14:00Z', '2026-10-20T20:39:00Z', 'test'),
      stamped('IN_PROGRESS', '2026-10-20T20:14:00Z'),
    ]

    expect(
      checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T20:51:00Z'), 600),
    ).toMatchObject({ idle: 720, stall_bound: 1500 })
  })

  it('reads a StatusContext by the startedAt gh gives it, the time of its newest status', () => {
    // gh answered both StatusContext rows on #470 with a `startedAt`.
    const rollup = [
      { ...statusContext('PENDING', 'workstreams/review-1'), startedAt: '2026-10-20T21:59:15Z' },
      { ...statusContext('SUCCESS', 'workstreams/rot-check'), startedAt: '2026-10-20T22:00:47Z' },
    ]

    expect(checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T22:10:47Z'), 600)).toEqual({
      finished: 1,
      checks: 2,
      started: '2026-10-20T21:59:15Z',
      newest: '2026-10-20T22:00:47Z',
      idle: 600,
      stall_bound: 600,
      source: 'checks',
    })
  })

  it('gives a null idle for a rollup with no stamp it can read, which is never a stall', () => {
    const rollup = [
      statusContext('PENDING'),
      checkRun('QUEUED', null),
      stamped('QUEUED', ZERO),
      { ...checkRun('IN_PROGRESS', null), startedAt: 'soon' },
      { ...checkRun('IN_PROGRESS', null), startedAt: '2026-13-40T00:00:00Z' },
      { ...checkRun('IN_PROGRESS', null), startedAt: 1760994919 },
      null,
    ]

    expect(checkProgress({ statusCheckRollup: rollup }, at('2027-01-01T00:00:00Z'), 600)).toEqual({
      finished: 0,
      checks: 7,
      started: null,
      newest: null,
      idle: null,
      stall_bound: 600,
      source: null,
    })
  })

  it('reads a rollup that is absent or not a list as no rows', () => {
    for (const pull of [{}, { statusCheckRollup: 'nonsense' }]) {
      expect(checkProgress(pull, 0, 600)).toEqual({
        finished: 0,
        checks: 0,
        started: null,
        newest: null,
        idle: null,
        stall_bound: 600,
        source: null,
      })
    }
  })

  it('counts a failed, skipped or cancelled row as finished', () => {
    const rollup = [
      checkRun('COMPLETED', 'FAILURE', 'lint'),
      checkRun('COMPLETED', 'SKIPPED', 'deploy'),
      checkRun('COMPLETED', 'CANCELLED', 'docs'),
      checkRun('IN_PROGRESS', null),
    ]

    expect(checkProgress({ statusCheckRollup: rollup }, 0, 600)).toMatchObject({
      finished: 3,
      checks: 4,
    })
  })

  it('counts only whole seconds idle, so a stall is never early', () => {
    // 599.5 seconds after the newest stamp is 599 whole seconds.
    const rollup = [stamped('IN_PROGRESS', '2026-10-20T22:15:19Z')]

    expect(
      checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T22:15:19Z') + 599_500, 600).idle,
    ).toBe(599)
  })

  it('reads a step that started or finished as progress, inside a job whose stamps sit still', () => {
    // Ruling 12: the #466 field case. One job has run 15 minutes, and its
    // steps finish every few minutes.
    const rollup = [stamped('IN_PROGRESS', '2026-10-19T20:14:00Z')]
    const steps = ['2026-10-19T20:14:05Z', '2026-10-19T20:20:00Z', '2026-10-19T20:26:00Z', null]

    expect(
      checkProgress({ statusCheckRollup: rollup }, at('2026-10-19T20:29:00Z'), 600, {
        stamps: steps,
      }),
    ).toMatchObject({ newest: '2026-10-19T20:26:00Z', idle: 180, source: 'checks' })
  })

  it('measures a rollup with no stamp from the head commit, and only then', () => {
    // Ruling 13: a check that never started still ends.
    const queued = { statusCheckRollup: [checkRun('QUEUED', null)] }
    const since = '2026-10-19T20:14:00Z'

    expect(checkProgress(queued, at('2026-10-19T20:24:00Z'), 600, { since: [since] })).toEqual({
      finished: 0,
      checks: 1,
      started: since,
      newest: since,
      idle: 600,
      stall_bound: 600,
      source: 'head commit',
    })
    const later = { statusCheckRollup: [stamped('IN_PROGRESS', '2026-10-19T20:20:00Z')] }
    expect(checkProgress(later, at('2026-10-19T20:24:00Z'), 600, { since: [since] })).toMatchObject(
      {
        newest: '2026-10-19T20:20:00Z',
        source: 'checks',
      },
    )
    expect(checkProgress(queued, 0, 600, { since: [ZERO] })).toMatchObject({
      idle: null,
      source: null,
    })
  })

  it('reads a wall clock behind GitHub’s as no time idle, not as a negative', () => {
    const rollup = [stamped('IN_PROGRESS', '2026-10-20T22:15:19Z')]

    expect(checkProgress({ statusCheckRollup: rollup }, at('2026-10-20T22:15:17Z'), 600).idle).toBe(
      0,
    )
  })
})

describe('pendingRuns', () => {
  it('names the run of each pending Actions check once, and no other', () => {
    const job = (status: string, run: number, jobId: number) => ({
      ...checkRun(status, status === 'COMPLETED' ? 'SUCCESS' : null),
      detailsUrl: `https://github.com/acme/widgets/actions/runs/${run}/job/${jobId}`,
    })
    const rollup = [
      job('IN_PROGRESS', 11, 21),
      job('QUEUED', 11, 22),
      job('COMPLETED', 12, 23),
      job('IN_PROGRESS', 13, 24),
      statusContext('PENDING'),
      { ...checkRun('IN_PROGRESS', null), detailsUrl: 'https://ci.example/1' },
    ]

    expect(pendingRuns({ statusCheckRollup: rollup })).toEqual(['11', '13'])
    expect(pendingRuns({})).toEqual([])
    expect(pendingRuns({ statusCheckRollup: 'nonsense' })).toEqual([])
  })
})

describe('missingField', () => {
  it('accepts an answer carrying all of them', () => {
    expect(missingField(readable())).toBe('')
  })

  it('refuses an answer that is not an object', () => {
    expect(missingField([])).toBe('a pull request object')
    expect(missingField(null)).toBe('a pull request object')
  })

  it.each(['state', 'headRefOid', 'baseRefName'])(
    'names %s when gh did not answer with it',
    (name) => {
      const pull = readable()
      delete pull[name]

      expect(missingField(pull)).toBe(name)
      expect(missingField(readable({ [name]: null }))).toBe(name)
      // Truthiness, not a null check: an empty SHA means gh answered nothing.
      expect(missingField(readable({ [name]: '' }))).toBe(name)
    },
  )

  it('names the rollup key when it is absent, but not when it is null', () => {
    // Absent, not empty: an empty rollup is a real answer about a new head.
    const pull = readable()
    delete pull.statusCheckRollup

    expect(missingField(pull)).toBe('statusCheckRollup')
    expect(missingField(readable({ statusCheckRollup: null }))).toBe('')
  })

  it('names the review decision when it is absent', () => {
    // `settle` decides `blocked` from this field. `summary` turns an
    // absent field into "". `settle` cannot tell that apart from "no
    // review required".
    const pull = readable()
    delete pull.reviewDecision

    expect(missingField(pull)).toBe('reviewDecision')
  })

  it('accepts an empty review decision, which is a repository requiring none', () => {
    expect(missingField(readable({ reviewDecision: '' }))).toBe('')
    expect(missingField(readable({ reviewDecision: null }))).toBe('')
  })

  it('names labels when they are not a list', () => {
    expect(missingField(readable({ labels: null }))).toBe('labels')
    // `isinstance(pull.get("labels"), list)` (`lib/shepherd.py:177`) is a
    // shape check, not a null check. If gh answers with `labels` as a
    // number or an object, the loop cannot use that answer either.
    expect(missingField(readable({ labels: 42 }))).toBe('labels')
    expect(missingField(readable({ labels: { name: 'dependencies' } }))).toBe('labels')
  })

  it('refuses the empty object summary would have shaped', () => {
    // The regression: `summary({})` is a pull request whose checks read passed.
    expect(missingField({})).toBe('state')
    expect(summary({}).checks.state).toBe('none')
  })
})

// --- isBot and isDependabot ---------------------------------------------------

describe('isBot and isDependabot', () => {
  it('reads the flag gh reports', () => {
    expect(isBot({ author: { login: 'app/dependabot', is_bot: true } })).toBe(true)
  })

  it('reads a flag that is not the boolean true as no flag at all', () => {
    // `is True` in the Python. A truthy value that is not the boolean true
    // means gh answered with something this code does not understand. The
    // login then decides.
    expect(isBot({ author: { login: 'someone', is_bot: 'yes' } })).toBe(false)
  })

  it('reads the login when the flag is absent', () => {
    expect(isBot({ author: { login: 'dependabot' } })).toBe(true)
    expect(isBot({ author: { login: 'app/dependabot' } })).toBe(true)
  })

  it('says a human author is not a bot', () => {
    expect(isBot({ author: { login: 'someone', is_bot: false } })).toBe(false)
  })

  it('says a pull request with no author at all is not a bot', () => {
    expect(isBot({})).toBe(false)
  })

  it.each(['dependabot', 'app/dependabot', 'dependabot[bot]', 'app/dependabot[bot]'])(
    'recognises %s as Dependabot',
    (login) => {
      expect(isDependabot({ author: { login } })).toBe(true)
    },
  )

  it('calls another bot a bot and not Dependabot', () => {
    // The report keeps the two flags apart. Renovate also opens dependency
    // pull requests, and it is not Dependabot.
    const renovate = { author: { login: 'renovate[bot]', is_bot: true } }

    expect(isBot(renovate)).toBe(true)
    expect(isDependabot(renovate)).toBe(false)
    expect(summary(renovate).is_bot).toBe(true)
    expect(summary(renovate).is_dependabot).toBe(false)
  })

  it('calls an app login with no flag a bot', () => {
    expect(isBot({ author: { login: 'app/github-actions' } })).toBe(true)
  })

  it('reads a login that is not text as no login', () => {
    expect(isBot({ author: { login: 7 } })).toBe(false)
    // The fold is `x or ""`, which keeps the value only when it is a
    // string. A `String()` call here would instead read `["dependabot"]` as
    // the login of Dependabot.
    expect(isDependabot({ author: { login: ['dependabot'] } })).toBe(false)
    expect(isBot({ author: { login: ['x[bot]'] } })).toBe(false)
  })
})

// --- rank ---------------------------------------------------------------------

describe('rank', () => {
  it.each([
    ['merge-risk:low', 0],
    [null, 1],
    ['merge-risk:medium', 2],
    ['merge-risk:high', 3],
  ])('orders %s as %i, unlabelled between low and medium', (label, expected) => {
    const labels = [{ name: 'dependencies' }, ...(label === null ? [] : [{ name: label }])]

    expect(rank({ labels })).toBe(expected)
  })

  it('sorts a band nobody recognises after all four', () => {
    expect(rank({ labels: [{ name: 'merge-risk:unknowable' }] })).toBe(4)
  })

  it('reads a label with no name, and labels that are not a list, as unlabelled', () => {
    expect(rank({ labels: [{}] })).toBe(1)
    expect(rank({ labels: null })).toBe(1)
    // This value is not a list, and it is not null either. The `??`
    // operator keeps it, and the loop then walks through whatever it is.
    // The test name calls this case "refused".
    expect(rank({ labels: 42 })).toBe(1)
    expect(rank({ labels: { name: 'merge-risk:high' } })).toBe(1)
  })
})

// --- ciSeconds -----------------------------------------------------------------

const at = (seconds: number): string => {
  const stamp = new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()
  return `${stamp.slice(0, 19)}Z`
}

const runFor = (seconds: number) => ({ createdAt: '2026-01-01T00:00:00Z', updatedAt: at(seconds) })

describe('ciSeconds', () => {
  it('takes the median, not the mean', () => {
    // Sorted 30 45 50 60 900: the middle one, not the mean the outlier drags up.
    expect(ciSeconds([30, 900, 60, 45, 50].map(runFor))).toBe(50)
  })

  it('takes the upper middle of an even count', () => {
    // jq's `sort | .[length / 2 | floor]` picked the upper of the two middles.
    expect(ciSeconds([10, 20, 30, 40].map(runFor))).toBe(30)
  })

  it('drops a run missing a stamp', () => {
    expect(ciSeconds([runFor(50), { createdAt: '2026-01-01T00:00:00Z', updatedAt: null }])).toBe(50)
    expect(ciSeconds([runFor(50), { updatedAt: '2026-01-01T00:00:00Z' }])).toBe(50)
  })

  it('drops a non-positive duration', () => {
    expect(ciSeconds([runFor(0), runFor(50)])).toBe(50)
  })

  it('falls back when nothing is usable', () => {
    expect(ciSeconds([runFor(0)])).toBe(300)
  })

  it('falls back on an empty listing', () => {
    expect(ciSeconds([])).toBe(300)
  })

  it('falls back on a listing that is not a list at all', () => {
    expect(ciSeconds(null)).toBe(300)
    // This value is not a list, and it is not null either, so the `??`
    // fold keeps it. `for ... of 42` then throws, and the command exits 3.
    // It does not fall back to the default.
    expect(ciSeconds(42)).toBe(300)
  })

  it('falls back on an unparseable stamp', () => {
    // jq raised an error for the whole program from one bad stamp. The
    // caller then fell back to the default.
    expect(ciSeconds([{ createdAt: 'yesterday', updatedAt: 'today' }])).toBe(300)
    expect(ciSeconds([{ createdAt: '2026-01-01T00:00:00Z', updatedAt: 'today' }])).toBe(300)
  })

  it('falls back on a stamp naming a day that does not exist', () => {
    expect(
      ciSeconds([{ createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-13-45T00:00:00Z' }]),
    ).toBe(300)
  })

  it('falls back when the listing is not rows at all', () => {
    expect(ciSeconds(['nonsense'])).toBe(300)
  })
})

// --- summary and statusDocument ------------------------------------------------

describe('summary', () => {
  it('carries the fields the loop needs, in the order the contract names', () => {
    const pull = {
      number: 1,
      title: 'build(deps): bump dep-1',
      author: { login: 'app/dependabot', is_bot: true },
      state: 'OPEN',
      mergeStateStatus: 'BEHIND',
      mergeable: 'MERGEABLE',
      headRefOid: 'sha1',
      autoMergeRequest: { mergeMethod: 'MERGE' },
      mergeCommit: null,
      labels: [{ name: 'dependencies' }],
      createdAt: '2026-01-01T00:00:00Z',
      statusCheckRollup: [],
      reviewDecision: 'REVIEW_REQUIRED',
      baseRefName: 'main',
    }

    expect(summary(pull)).toEqual({
      number: 1,
      title: 'build(deps): bump dep-1',
      author: 'app/dependabot',
      is_bot: true,
      state: 'OPEN',
      mergeStateStatus: 'BEHIND',
      mergeable: 'MERGEABLE',
      headRefOid: 'sha1',
      autoMerge: true,
      mergeCommit: null,
      labels: ['dependencies'],
      createdAt: '2026-01-01T00:00:00Z',
      checks: { state: 'none', failing: [] },
      is_dependabot: true,
      reviewDecision: 'REVIEW_REQUIRED',
      baseRefName: 'main',
      approval: 'missing',
      threads: null,
    })
    // A human reads the key order in a transcript, so it is the contract,
    // not an implementation detail.
    expect(Object.keys(summary(pull))).toEqual([
      'number',
      'title',
      'author',
      'is_bot',
      'state',
      'mergeStateStatus',
      'mergeable',
      'headRefOid',
      'autoMerge',
      'mergeCommit',
      'labels',
      'createdAt',
      'checks',
      'is_dependabot',
      'reviewDecision',
      'baseRefName',
      'approval',
      'threads',
    ])
  })

  it('flattens a merge commit to its oid', () => {
    expect(summary({ mergeCommit: { oid: 'abc' } }).mergeCommit).toBe('abc')
  })

  it('reports no review requirement as the empty string', () => {
    // A repository that requires no review answers null. `settle` must read
    // that as "keep waiting", not as a missing field.
    expect(summary({}).reviewDecision).toBe('')
    expect(summary({ reviewDecision: null }).reviewDecision).toBe('')
    // `or ""` is truthiness: every falsy answer is no review requirement. A
    // null guard would carry `false` into the document instead.
    expect(summary({ reviewDecision: false }).reviewDecision).toBe('')
    expect(summary({ reviewDecision: 0 }).reviewDecision).toBe('')
  })

  it('reports no auto-merge request as no auto-merge', () => {
    expect(summary({ autoMergeRequest: null }).autoMerge).toBe(false)
  })

  it('reads labels that are not a list as no labels, and a label with no name as null', () => {
    expect(summary({ labels: null }).labels).toEqual([])
    expect(summary({ labels: [{}] }).labels).toEqual([null])
    // Not a list and not null, which a null guard would hand straight to
    // `map`.
    expect(summary({ labels: 42 }).labels).toEqual([])
    expect(summary({ labels: 'dependencies' }).labels).toEqual([])
  })
})

/** No rules read, and no `--all`: what `statusDocument` was given before
 *  #465. */
const OPEN_DOOR = { rules: new Map(), threads: new Map(), all: false }

/** The review rules of one base, as `requiredReviews` answers them. */
const rule = (
  approvals: number,
  flags: { codeOwner?: boolean; threadResolution?: boolean; lastPush?: boolean } = {},
) => ({ approvals, codeOwner: false, threadResolution: false, lastPush: false, ...flags })

/** A review as gh lists it in `reviews`, on the head `readable` names. */
const review = (state: string, login = 'octocat', oid = 'sha1') => ({
  author: { login },
  state,
  commit: { oid },
})

describe('approvalOf', () => {
  // One row per case of rulings 1, 2, 5 and 10 on #465.
  const cases: [string, Record<string, unknown>, ReturnType<typeof rule> | null, string | null][] =
    [
      ['no rule and no decision: not required', {}, rule(0), 'not_required'],
      ['rules unread and no decision: null', {}, null, null],
      ['a count of 1 and no review: missing', { reviews: [] }, rule(1), 'missing'],
      [
        'a count of 1 and one APPROVED review: met',
        { reviews: [review('APPROVED')] },
        rule(1),
        'met',
      ],
      [
        'a count of 2 and one APPROVED review: missing',
        { reviews: [review('APPROVED'), review('COMMENTED', 'hubot')] },
        rule(2),
        'missing',
      ],
      [
        'a COMMENTED review after an approval keeps the approval',
        { reviews: [review('APPROVED'), review('COMMENTED')] },
        rule(1),
        'met',
      ],
      [
        'a DISMISSED review after an approval takes it back',
        { reviews: [review('APPROVED'), review('DISMISSED')] },
        rule(1),
        'missing',
      ],
      [
        'two approvals from one author count once',
        { reviews: [review('APPROVED'), review('APPROVED')] },
        rule(2),
        'missing',
      ],
      [
        'two approvals from two authors meet a count of 2',
        { reviews: [review('APPROVED'), review('APPROVED', 'hubot')] },
        rule(2),
        'met',
      ],
      [
        'a code owner rule with a count of 0 and one APPROVED review: met',
        { reviews: [review('APPROVED')] },
        rule(0, { codeOwner: true }),
        'met',
      ],
      ['a code owner rule and no review: missing', {}, rule(0, { codeOwner: true }), 'missing'],
      [
        'a last-push rule and an approval of the head: met',
        { reviews: [review('APPROVED', 'octocat', 'sha1')] },
        rule(1, { lastPush: true }),
        'met',
      ],
      [
        'a last-push rule and an approval of an older commit: missing',
        { reviews: [review('APPROVED', 'octocat', 'sha0')] },
        rule(1, { lastPush: true }),
        'missing',
      ],
      [
        'an approval of an older commit, with no last-push rule: met',
        { reviews: [review('APPROVED', 'octocat', 'sha0')] },
        rule(1),
        'met',
      ],
      [
        'reviewDecision APPROVED with a count the reviews do not reach: met',
        { reviewDecision: 'APPROVED', reviews: [review('APPROVED')] },
        rule(2),
        'met',
      ],
      [
        // Ruling 2: reviewDecision APPROVED is met. The commit of each
        // review is read only when the count decides.
        'reviewDecision APPROVED with a last-push rule and an older approval: met',
        { reviewDecision: 'APPROVED', reviews: [review('APPROVED', 'octocat', 'sha0')] },
        rule(1, { lastPush: true }),
        'met',
      ],
      [
        'reviewDecision APPROVED with the rules unread: met',
        { reviewDecision: 'APPROVED' },
        null,
        'met',
      ],
      [
        'reviewDecision CHANGES_REQUESTED with no rule: missing',
        { reviewDecision: 'CHANGES_REQUESTED' },
        rule(0),
        'missing',
      ],
      [
        'a standing CHANGES_REQUESTED review beside enough approvals: missing',
        { reviews: [review('APPROVED'), review('CHANGES_REQUESTED', 'hubot')] },
        rule(1),
        'missing',
      ],
      [
        'a CHANGES_REQUESTED review with nothing required: not required',
        { reviews: [review('CHANGES_REQUESTED')] },
        rule(0),
        'not_required',
      ],
      [
        'reviewDecision REVIEW_REQUIRED with the rules unread: missing',
        { reviewDecision: 'REVIEW_REQUIRED' },
        null,
        'missing',
      ],
      [
        'reviewDecision REVIEW_REQUIRED beside an approval that meets the count: missing',
        { reviewDecision: 'REVIEW_REQUIRED', reviews: [review('APPROVED')] },
        rule(1),
        'missing',
      ],
      ['reviews that are not a list: no reviews', { reviews: 'APPROVED' }, rule(1), 'missing'],
      [
        'reviews that are an object, not a list: no reviews',
        { reviews: review('APPROVED') },
        rule(1),
        'missing',
      ],
      [
        'a review with no state, or no object at all: no approval',
        { reviews: [{ author: { login: 'octocat' } }, null] },
        rule(1),
        'missing',
      ],
    ]

  it.each(cases)('%s', (_name, pull, rules, approval) => {
    expect(approvalOf(readable(pull), rules)).toBe(approval)
  })
})

describe('threadsOf', () => {
  it('needs the rules to answer at all', () => {
    expect(threadsOf(null, 3)).toBeNull()
  })

  it('reads a rule that does not ask for resolved threads as not required', () => {
    expect(threadsOf(rule(1), null)).toBe('not_required')
  })

  it('reads a thread rule by the count of unresolved threads', () => {
    const asks = rule(0, { threadResolution: true })
    expect(threadsOf(asks, 2)).toBe('unresolved')
    expect(threadsOf(asks, 0)).toBe('resolved')
    expect(threadsOf(asks, null)).toBeNull()
  })
})

describe('autoMergeBases and threadReads', () => {
  const pulls = [
    { number: 1, autoMergeRequest: {}, baseRefName: 'main' },
    { number: 2, autoMergeRequest: {}, baseRefName: 'release' },
    { number: 3, autoMergeRequest: {}, baseRefName: 'main' },
    { number: 4, autoMergeRequest: null, baseRefName: 'main' },
    { number: 5, autoMergeRequest: {}, isDraft: true, baseRefName: 'draft-base' },
    { number: 6, autoMergeRequest: {} },
  ]

  it('names each base of the auto-merge pull requests once, and skips the rest', () => {
    expect(autoMergeBases(pulls)).toEqual(['main', 'release'])
  })

  it('names the auto-merge pull requests whose base asks for resolved threads', () => {
    const rules = new Map([
      ['main', rule(0, { threadResolution: true })],
      ['release', null],
    ])
    expect(threadReads(pulls, rules)).toEqual([1, 3])
  })
})

/** The pull request targets of a document. These examples list no stack. */
const pullTargets = (document: ReturnType<typeof statusDocument>): PullSummary[] =>
  document.targets as PullSummary[]

/** The pull requests a document leaves out. */
const pullNotReady = (document: ReturnType<typeof statusDocument>): NotReady[] =>
  document.not_ready as NotReady[]

describe('statusDocument', () => {
  it('keeps only pull requests a human marked for auto-merge', () => {
    const pulls = [
      { number: 1, autoMergeRequest: { mergeMethod: 'MERGE' }, createdAt: '2026-01-01' },
      { number: 2, autoMergeRequest: null, createdAt: '2026-01-02', title: 't' },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 42, OPEN_DOOR)

    expect(pullTargets(document).map((target) => target.number)).toEqual([1])
    expect(document.repo).toBe('acme/widgets')
    expect(document.default_branch).toBe('main')
    expect(document.ci_seconds).toBe(42)
  })

  it('drops drafts', () => {
    const pulls = [{ number: 1, isDraft: true, autoMergeRequest: {}, createdAt: '2026-01-01' }]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 42, OPEN_DOOR)

    expect(document.targets).toEqual([])
  })

  it('reads autoMergeRequest by presence, not by truthiness', () => {
    // `false` is not a shape gh answers with (the field is an object or
    // null), but the check is `is not None`, not `Boolean(...)`, on
    // purpose: a truthiness check would drop this row, and the field's own
    // presence is what marks it as wanted.
    const pulls = [{ number: 1, autoMergeRequest: false, createdAt: '2026-01-01' }]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 42, OPEN_DOOR)

    expect(pullTargets(document).map((target) => target.number)).toEqual([1])
  })

  it('orders targets by band, then oldest first inside a band', () => {
    const pulls = [
      { number: 5, autoMergeRequest: {}, createdAt: '2026-01-01', labels: [{ name: 'x' }] },
      {
        number: 6,
        autoMergeRequest: {},
        createdAt: '2026-01-03',
        labels: [{ name: 'merge-risk:low' }],
      },
      {
        number: 7,
        autoMergeRequest: {},
        createdAt: '2026-01-02',
        labels: [{ name: 'merge-risk:low' }],
      },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, OPEN_DOOR)

    expect(pullTargets(document).map((target) => target.number)).toEqual([7, 6, 5])
  })

  it('leaves two targets opened at the same moment in the order gh listed them', () => {
    // Both languages use a stable sort. When the comparator answers
    // "equal", the report does not break the tie itself.
    const pulls = [
      { number: 9, autoMergeRequest: {}, createdAt: '2026-01-01' },
      { number: 4, autoMergeRequest: {}, createdAt: '2026-01-01' },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, OPEN_DOOR)

    expect(pullTargets(document).map((target) => target.number)).toEqual([9, 4])
  })

  it('leaves out a pull request whose base requires an approval it does not have', () => {
    // Rule 15 (a) on #465: a count of 1 and no review.
    const pulls = [
      readable({ number: 1, title: 'one', author: { login: 'octocat' }, autoMergeRequest: {} }),
      readable({
        number: 2,
        autoMergeRequest: {},
        reviews: [review('APPROVED')],
        createdAt: '2026-01-02',
      }),
    ]
    const options = { ...OPEN_DOOR, rules: new Map([['main', rule(1)]]) }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullTargets(document).map((target) => target.number)).toEqual([2])
    expect(pullTargets(document)[0]?.approval).toBe('met')
    expect(document.not_ready).toEqual([
      { number: 1, title: 'one', author: 'octocat', reasons: ['needs an approval'] },
    ])
  })

  it('makes every auto-merge pull request a target with --all', () => {
    // Rule 15 (b) on #465: the same pull request, asked for all.
    const pulls = [readable({ number: 1, autoMergeRequest: {} })]
    const options = {
      rules: new Map([['main', rule(1, { threadResolution: true })]]),
      threads: new Map([[1, 4]]),
      all: true,
    }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullTargets(document).map((target) => [target.approval, target.threads])).toEqual([
      ['missing', 'unresolved'],
    ])
    expect(document.not_ready).toEqual([])
  })

  it('leaves out a pull request with unresolved threads, and names both reasons', () => {
    const pulls = [
      readable({ number: 1, autoMergeRequest: {} }),
      readable({ number: 2, autoMergeRequest: {}, reviews: [review('APPROVED')] }),
      readable({ number: 3, autoMergeRequest: {}, reviews: [review('APPROVED')] }),
    ]
    const options = {
      rules: new Map([['main', rule(1, { threadResolution: true })]]),
      threads: new Map([
        [1, 2],
        [2, 1],
        [3, 0],
      ]),
      all: false,
    }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullNotReady(document).map((entry) => [entry.number, entry.reasons])).toEqual([
      [1, ['needs an approval', 'has unresolved review threads']],
      [2, ['has unresolved review threads']],
    ])
    expect(pullTargets(document).map((target) => [target.number, target.threads])).toEqual([
      [3, 'resolved'],
    ])
  })

  it('keeps a pull request whose threads could not be read', () => {
    // Ruling 5: a failed read never leaves a pull request out.
    const pulls = [readable({ number: 1, autoMergeRequest: {}, reviews: [review('APPROVED')] })]
    const options = {
      rules: new Map([['main', rule(1, { threadResolution: true })]]),
      threads: new Map([[1, null]]),
      all: false,
    }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullTargets(document).map((target) => target.threads)).toEqual([null])
  })

  it('reads a pull request with no entry in the threads map as unread', () => {
    const pulls = [readable({ number: 1, autoMergeRequest: {}, reviews: [review('APPROVED')] })]
    const options = {
      rules: new Map([['main', rule(1, { threadResolution: true })]]),
      threads: new Map<number, number | null>(),
      all: false,
    }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullTargets(document).map((target) => target.threads)).toEqual([null])
  })

  it('falls back to reviewDecision for a base whose rules were not read', () => {
    // Ruling 5: a failed read never leaves a pull request out on its own.
    const pulls = [
      readable({ number: 1, autoMergeRequest: {} }),
      readable({ number: 2, autoMergeRequest: {}, reviewDecision: 'REVIEW_REQUIRED' }),
      readable({ number: 3, autoMergeRequest: {}, baseRefName: 'release' }),
    ]
    const options = { ...OPEN_DOOR, rules: new Map([['main', null]]) }

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300, options)

    expect(pullTargets(document).map((target) => [target.number, target.approval])).toEqual([
      [1, null],
      [3, null],
    ])
    expect(pullNotReady(document).map((entry) => entry.number)).toEqual([2])
  })

  it('puts not_ready after targets, so the keys already there keep their order', () => {
    expect(Object.keys(statusDocument([], 'acme/widgets', 'main', 300, OPEN_DOOR))).toEqual([
      'repo',
      'default_branch',
      'ci_seconds',
      'targets',
      'not_ready',
    ])
  })

  it('reads a listing that is not a list at all as no pull requests', () => {
    expect(statusDocument(null, 'acme/widgets', 'main', 300, OPEN_DOOR).targets).toEqual([])
    // This value is not a list, and it is not null either, so a `??` fold
    // keeps it. `.filter` then throws, and the command exits 3. It does not
    // report that there are no targets.
    expect(statusDocument(42, 'acme/widgets', 'main', 300, OPEN_DOOR).targets).toEqual([])
  })
})

// --- the two text helpers both commands share ----------------------------------

describe('oneLine', () => {
  it('collapses every run of whitespace, so no trailing newline becomes a space', () => {
    expect(oneLine('HTTP 502\n  Bad gateway\n')).toBe('HTTP 502 Bad gateway')
  })

  it('answers nothing for nothing', () => {
    expect(oneLine('')).toBe('')
    expect(oneLine('\n  \n')).toBe('')
  })
})

describe('tailLines', () => {
  it('keeps the last lines and drops the trailing newline', () => {
    expect(tailLines('line 1\nline 2\nline 3\n', 2)).toBe('line 2\nline 3')
  })

  it('keeps every line when there are fewer than asked for', () => {
    expect(tailLines('line 1\n', 60)).toBe('line 1')
  })

  it('answers the empty string for an empty log, never a bare newline', () => {
    expect(tailLines('', 60)).toBe('')
  })

  it('counts a carriage return as a line break, as `splitlines` does', () => {
    // A CI job's `--log-failed` output carries a bare `\r` wherever a tool
    // redrew a progress bar. If the code splits only on `\n`, the whole run
    // becomes one line. `SHEPHERD_LOG_LINES` would then keep far more lines
    // than it was asked for.
    expect(tailLines('a\rb\rc\r', 2)).toBe('b\nc')
    expect(tailLines('a\r\nb\r\nc\r\n', 2)).toBe('b\nc')
  })

  it('counts the other terminators `splitlines` counts', () => {
    // This set matches the whole of Python's set. The bound this keeps
    // matches the bound the script it ports kept. The set includes: form
    // feed, vertical tab, the three file and record separators, and the
    // three Unicode line breaks.
    const breaks = [11, 12, 28, 29, 30, 0x85, 0x2028, 0x2029].map((code) =>
      String.fromCharCode(code),
    )
    for (const [index, mark] of breaks.entries()) {
      expect(tailLines(`a${mark}b${mark}c`, 2), String(index)).toBe('b\nc')
    }
  })
})

describe('stacks (#469)', () => {
  const red = {
    isDraft: true,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'vitest', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', context: 'lint', state: 'PENDING' },
    ],
  }

  it('names only a required check that failed, and none when the checks were not read', () => {
    expect(failedRequired(red, ['lint', 'vitest', 'types'])).toEqual(['vitest'])
    expect(failedRequired(red, null)).toEqual([])
  })

  it('names a required check with no row at all as unreported', () => {
    expect(unreportedRequired(red, ['lint', 'vitest', 'types'])).toEqual(['types'])
    expect(unreportedRequired({}, ['types'])).toEqual(['types'])
    expect(unreportedRequired(red, null)).toEqual([])
  })

  it('keeps a draft and a failed check with --all, and drops the review rules', () => {
    expect(layerReasons(red, 'missing', 'unresolved', ['vitest'], false)).toEqual([
      'is a draft',
      'needs an approval',
      'has unresolved review threads',
      'required check vitest failed',
    ])
    expect(layerReasons(red, 'missing', 'unresolved', ['vitest'], true)).toEqual([
      'is a draft',
      'required check vitest failed',
    ])
  })

  it('leaves a stack in when the rules of its base were not read', () => {
    const stack = { number: 9, base: 'main', layers: [{ number: 8, state: 'OPEN' as const }] }
    const rows = new Map([[8, { number: 8, reviewDecision: '' }]])

    const document = statusDocument([], 'acme/widgets', 'main', 300, {
      ...OPEN_DOOR,
      stacks: [{ stack, rows, contexts: null }],
    })

    expect(document.targets).toEqual([{ stack: 9, base: 'main', layers: [8] }])
  })
})
