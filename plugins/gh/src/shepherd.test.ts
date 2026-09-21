// One named test per arm of every fold in `shepherd.ts`, which is how
// `tests/gh/test_shepherd_lib.py` is organised and why
// (`.claude/rules/type-py.md` line 36): three mutations of the check-state
// fold once left a 219 example suite green with coverage unmoved, because the
// jq it replaced was one line however many outcomes it decided between. Each
// test here was checked by mutation: change that arm in `shepherd.ts` and the
// test named for it goes red on its own.
import { describe, expect, it } from 'vitest'
import {
  checkLink,
  checkName,
  checkState,
  checks,
  ciSeconds,
  isBot,
  isDependabot,
  isTruthy,
  missingField,
  oneLine,
  rank,
  statusDocument,
  summary,
  tailLines,
} from './shepherd.ts'

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

/** A pull request carrying every field the loop decides from. */
const readable = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: 'OPEN',
  headRefOid: 'sha1',
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
    // The whole reason this function exists. `reviewDecision` is "" on a
    // repository that requires no review, and `headRefOid` is "" when gh
    // answered no SHA; `value ?? fallback` keeps both as answers.
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
      // Dropping NEUTRAL from the pass set is mutation two in the rule's list.
      expect(checkState(checkRun('COMPLETED', conclusion))).toBe('passed')
    },
  )

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])(
    'fails %s, which is completed and not a pass',
    (conclusion) => {
      // Narrowing this arm is mutation one: a cancelled build polled forever.
      expect(checkState(checkRun('COMPLETED', conclusion))).toBe('failed')
    },
  )

  it('fails a completed run with no conclusion at all', () => {
    // Reading null as success is the one mistake this fold must not make.
    expect(checkState(checkRun('COMPLETED', null))).toBe('failed')
  })

  it.each(['QUEUED', 'IN_PROGRESS', 'WAITING'])('calls an unfinished %s check run pending', (s) => {
    // Inverting the COMPLETED arm is mutation three.
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
    // Dispatching on a `conclusion ?? state` chain rather than on `__typename`
    // calls every pending StatusContext failed, because it has no conclusion.
    const row = statusContext('PENDING')

    expect('conclusion' in row).toBe(false)
    expect(checkState(row)).toBe('pending')
  })

  it('calls a row that is not an object pending', () => {
    // A null element in the rollup, which GraphQL can answer with. Read as
    // failed it would report a green pull request as broken.
    expect(checkState(null)).toBe('pending')
    expect(checkState('build')).toBe('pending')
  })

  it('reads a row with no __typename as a check run', () => {
    // gh omits __typename unless it is asked for; CheckRun is the default arm.
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

describe('missingField', () => {
  it('accepts an answer carrying all of them', () => {
    expect(missingField(readable())).toBe('')
  })

  it('refuses an answer that is not an object', () => {
    expect(missingField([])).toBe('a pull request object')
    expect(missingField(null)).toBe('a pull request object')
  })

  it.each(['state', 'headRefOid'])('names %s when gh did not answer with it', (name) => {
    const pull = readable()
    delete pull[name]

    expect(missingField(pull)).toBe(name)
    expect(missingField(readable({ [name]: null }))).toBe(name)
    // Truthiness, not a null check: an empty SHA is gh answering nothing.
    expect(missingField(readable({ [name]: '' }))).toBe(name)
  })

  it('names the rollup key when it is absent, but not when it is null', () => {
    // Absent, not empty: an empty rollup is a real answer about a new head.
    const pull = readable()
    delete pull.statusCheckRollup

    expect(missingField(pull)).toBe('statusCheckRollup')
    expect(missingField(readable({ statusCheckRollup: null }))).toBe('')
  })

  it('names the review decision when it is absent', () => {
    // `settle` decides `blocked` from it, and `summary` turns an absent field
    // into "", which settle cannot tell from "no review required".
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
    // `is True` in the Python: a truthy value that is not the boolean is gh
    // answering something this does not understand, and the login decides.
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
    // The distinction recreate turns on: `@dependabot recreate` is answered by
    // one bot, and renovate opens dependency pull requests too.
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
  })

  it('falls back on an unparseable stamp', () => {
    // jq errored on the whole program for one bad stamp and the caller fell back.
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
    })
    // The key order is read by a human in a transcript, so it is the contract
    // and not an implementation detail.
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
    ])
  })

  it('flattens a merge commit to its oid', () => {
    expect(summary({ mergeCommit: { oid: 'abc' } }).mergeCommit).toBe('abc')
  })

  it('reports no review requirement as the empty string', () => {
    // A repository that requires no review answers null, and settle must read
    // that as "keep waiting" rather than as a missing field.
    expect(summary({}).reviewDecision).toBe('')
    expect(summary({ reviewDecision: null }).reviewDecision).toBe('')
  })

  it('reports no auto-merge request as no auto-merge', () => {
    expect(summary({ autoMergeRequest: null }).autoMerge).toBe(false)
  })

  it('reads labels that are not a list as no labels, and a label with no name as null', () => {
    expect(summary({ labels: null }).labels).toEqual([])
    expect(summary({ labels: [{}] }).labels).toEqual([null])
  })
})

describe('statusDocument', () => {
  it('splits targets from pull requests without auto-merge', () => {
    const pulls = [
      { number: 1, autoMergeRequest: { mergeMethod: 'MERGE' }, createdAt: '2026-01-01' },
      { number: 2, autoMergeRequest: null, createdAt: '2026-01-02', title: 't' },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 42)

    expect(document.targets.map((target) => target.number)).toEqual([1])
    expect(document.skipped_no_automerge).toEqual([{ number: 2, title: 't', author: null }])
    expect(document.repo).toBe('acme/widgets')
    expect(document.default_branch).toBe('main')
    expect(document.ci_seconds).toBe(42)
  })

  it('drops drafts from both lists', () => {
    const pulls = [{ number: 1, isDraft: true, autoMergeRequest: null, createdAt: '2026-01-01' }]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 42)

    expect(document.targets).toEqual([])
    expect(document.skipped_no_automerge).toEqual([])
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

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300)

    expect(document.targets.map((target) => target.number)).toEqual([7, 6, 5])
  })

  it('orders the skipped list oldest first, reading a missing stamp as oldest', () => {
    const pulls = [
      { number: 1, autoMergeRequest: null, createdAt: '2026-01-02' },
      { number: 2, autoMergeRequest: null },
      { number: 3, autoMergeRequest: null, createdAt: '2026-01-01' },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300)

    expect(document.skipped_no_automerge.map((row) => row.number)).toEqual([2, 3, 1])
  })

  it('leaves two pull requests opened at the same moment in the order gh listed them', () => {
    // A stable sort in both languages, so the comparator answering "equal" is
    // not a tie the report breaks by itself.
    const pulls = [
      { number: 9, autoMergeRequest: null, createdAt: '2026-01-01' },
      { number: 4, autoMergeRequest: null, createdAt: '2026-01-01' },
    ]

    const document = statusDocument(pulls, 'acme/widgets', 'main', 300)

    expect(document.skipped_no_automerge.map((row) => row.number)).toEqual([9, 4])
  })

  it('reads a listing that is not a list at all as no pull requests', () => {
    expect(statusDocument(null, 'acme/widgets', 'main', 300).targets).toEqual([])
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
})
