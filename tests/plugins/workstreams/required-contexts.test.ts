// The one derivation of the required contexts, which `pr-state` and `watch`
// share (round 10 ruling P6). Pure functions, so every example is a literal
// list in and a literal answer out.
import { describe, expect, it } from 'vitest'

import type { CheckContext } from '#harness/gh.ts'
import {
  answeringChecks,
  namesOrDefault,
  namesOrHead,
  needsHeadRuns,
  reportContexts,
  splitDraftSkipped,
} from '#workstreams/required-contexts.ts'

const check = (
  name: string,
  conclusion: string | null,
  startedAt: string | null = null,
): CheckContext => ({
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  startedAt,
})

/** A check that run `id` of workflow `workflowId` made. The run's
 *  conclusion is its check suite's, which can differ from the check's own:
 *  a fan-in job of a cancelled run fails. */
const fromRun = (
  base: CheckContext,
  id: number,
  createdAt: string,
  runConclusion: string | null,
  workflowId = 1,
  workflow = 'CI',
): CheckContext => ({
  ...base,
  run: { id, workflowId, workflow, createdAt, conclusion: runConclusion },
})

/** An unexpanded matrix job's name, as GitHub reports it. */
const PLACEHOLDER = `ab-style (\${{ matrix.style }})`

const OLD = '2026-10-01T00:00:00Z'
const NEW = '2026-10-01T00:01:00Z'

describe('reportContexts', () => {
  it('reports each name once, with what reported under it', () => {
    const checks = [check('vitest', 'SUCCESS'), check('types', 'FAILURE'), check('biome', null)]

    expect(reportContexts(checks, ['vitest', 'types', 'biome', 'types', 'lint'])).toEqual([
      { name: 'vitest', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
      { name: 'types', reported: true, conclusion: 'FAILURE', verdict: 'failed' },
      { name: 'biome', reported: true, conclusion: null, verdict: 'pending' },
      { name: 'lint', reported: false, conclusion: null, verdict: 'pending' },
    ])
  })

  it('reads SKIPPED and NEUTRAL as satisfied, the way the merge gate does', () => {
    const checks = [check('a', 'SKIPPED'), check('b', 'NEUTRAL'), check('c', 'CANCELLED')]

    expect(reportContexts(checks, ['a', 'b', 'c']).map((context) => context.verdict)).toEqual([
      'success',
      'success',
      'failed',
    ])
  })

  it('reads a cancelled run then a later success as success, a re-run case', () => {
    const checks = [
      check('vitest', 'CANCELLED', '2026-09-01T00:00:00Z'),
      check('vitest', 'SUCCESS', '2026-09-01T00:05:00Z'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
  })

  it('reads an old success then a later failure as failure', () => {
    const checks = [
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
      check('vitest', 'FAILURE', '2026-09-01T00:05:00Z'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('FAILURE')
  })

  it('reads an older concluded run and a newer pending run as pending', () => {
    const checks = [
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
      check('vitest', null, '2026-09-01T00:05:00Z'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.verdict).toBe('pending')
  })

  it('reads the same result whichever order the runs arrive in', () => {
    const newerFirst = [
      check('vitest', 'SUCCESS', '2026-09-01T00:05:00Z'),
      check('vitest', 'CANCELLED', '2026-09-01T00:00:00Z'),
    ]
    const newerLast = [
      check('vitest', 'CANCELLED', '2026-09-01T00:00:00Z'),
      check('vitest', 'SUCCESS', '2026-09-01T00:05:00Z'),
    ]

    expect(reportContexts(newerFirst, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
    expect(reportContexts(newerLast, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
  })

  it('reads a null startedAt as the oldest, so a timed run outranks it', () => {
    const checks = [
      check('vitest', 'FAILURE', null),
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
  })

  it('never lets a later null startedAt displace an earlier timed run', () => {
    const checks = [
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
      check('vitest', 'FAILURE', null),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
  })

  it('reads a pending run as winning a tie in start time, either order', () => {
    const pendingFirst = [
      check('vitest', null, '2026-09-01T00:00:00Z'),
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
    ]
    const pendingLast = [
      check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'),
      check('vitest', null, '2026-09-01T00:00:00Z'),
    ]

    expect(reportContexts(pendingFirst, ['vitest'])[0]?.verdict).toBe('pending')
    expect(reportContexts(pendingLast, ['vitest'])[0]?.verdict).toBe('pending')
  })
})

describe('reportContexts over superseded cancelled runs (#364)', () => {
  it('ignores a cancelled run once a newer run of the workflow has its check', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('lint', 'SUCCESS', NEW), 2, NEW, null),
      fromRun(check('vitest', 'SUCCESS', '2026-09-01T00:00:00Z'), 2, NEW, null),
    ]

    // The newer run's check started earlier than the cancelled one's, so
    // only the run filter, not `startedAt`, can make it the answer.
    expect(reportContexts(checks, ['vitest'])).toEqual([
      { name: 'vitest', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
    ])
  })

  it('reads a name the newer run has not made yet as pending, not failed', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('lint', null, NEW), 2, NEW, null),
    ]

    expect(reportContexts(checks, ['vitest'])).toEqual([
      { name: 'vitest', reported: false, conclusion: null, verdict: 'pending' },
    ])
  })

  it('keeps a cancelled run with no newer run as its own answer, red', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('types', 'CANCELLED', OLD), 1, OLD, 'CANCELLED'),
    ]

    expect(reportContexts(checks, ['vitest', 'types']).map((c) => c.verdict)).toEqual([
      'failed',
      'failed',
    ])
  })

  it('ignores a cancelled run when the newer run of its workflow was cancelled too', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('types', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('vitest', 'FAILURE', '2026-09-01T00:00:00Z'), 2, NEW, 'CANCELLED'),
    ]

    // Run 2 is the newest, so it is the answer and it is red. Run 1's
    // `types` does not count, so that name has no answer yet.
    expect(reportContexts(checks, ['vitest', 'types']).map((c) => c.verdict)).toEqual([
      'failed',
      'pending',
    ])
  })

  it('keeps a cancelled run when only a newer run of another workflow exists', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('Analyze', 'SUCCESS', NEW), 2, NEW, 'SUCCESS', 2, 'CodeQL'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.verdict).toBe('failed')
  })

  it('keeps a cancelled run when a newer run is of another workflow with the same name', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED', 1, 'CI'),
      fromRun(check('lint', 'SUCCESS', NEW), 2, NEW, 'SUCCESS', 2, 'CI'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.verdict).toBe('failed')
  })

  it('keeps a cancelled run when the other run of its workflow is older', () => {
    const checks = [
      fromRun(check('vitest', 'SUCCESS', OLD), 1, OLD, 'SUCCESS'),
      fromRun(check('vitest', 'FAILURE', NEW), 2, NEW, 'CANCELLED'),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('FAILURE')
  })

  it('keeps an older run that was not cancelled; the start time decides', () => {
    const checks = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'FAILURE'),
      fromRun(check('lint', null, NEW), 2, NEW, null),
    ]

    expect(reportContexts(checks, ['vitest'])[0]?.verdict).toBe('failed')
  })

  it('on a tie in creation time, lets the larger run id be the newer run', () => {
    const newerConcluded = [
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('lint', 'SUCCESS', OLD), 2, OLD, 'SUCCESS'),
    ]
    const olderId = [
      fromRun(check('vitest', 'FAILURE', OLD), 2, OLD, 'CANCELLED'),
      fromRun(check('lint', null, OLD), 1, OLD, null),
    ]

    expect(reportContexts(newerConcluded, ['vitest'])[0]?.verdict).toBe('pending')
    expect(reportContexts(olderId, ['vitest'])[0]?.verdict).toBe('failed')
  })

  it('leaves a commit status, which has no run, as it reported', () => {
    const checks = [
      check('vercel/preview', 'FAILURE', OLD),
      fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('vitest', 'SUCCESS', NEW), 2, NEW, 'SUCCESS'),
    ]

    expect(reportContexts(checks, ['vercel/preview', 'vitest'])).toEqual([
      { name: 'vercel/preview', reported: true, conclusion: 'FAILURE', verdict: 'failed' },
      { name: 'vitest', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
    ])
  })
})

describe('a cancelled run that a started run supersedes (#370)', () => {
  /** A row of `actions/runs`: all the compare reads of it. */
  const started = (id: number, createdAt: string, workflowId = 1) => ({ id, workflowId, createdAt })
  const cancelled = [fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, 'CANCELLED')]

  it('reads a name pending when a newer run has made no check yet', () => {
    expect(reportContexts(cancelled, ['vitest'], [started(2, NEW)])).toEqual([
      { name: 'vitest', reported: false, conclusion: null, verdict: 'pending' },
    ])
  })

  it('still reads the cancelled run red with no runs passed', () => {
    expect(reportContexts(cancelled, ['vitest'])[0]?.verdict).toBe('failed')
    expect(reportContexts(cancelled, ['vitest'], [])[0]?.verdict).toBe('failed')
  })

  for (const [why, runs] of [
    ['the same run', [started(1, OLD)]],
    ['an older run', [started(0, '2026-09-30T00:00:00Z')]],
    ['a newer run of another workflow', [started(2, NEW, 2)]],
  ] as const) {
    it(`keeps the cancelled run red when the head's runs hold ${why}`, () => {
      expect(reportContexts(cancelled, ['vitest'], runs)[0]?.verdict).toBe('failed')
    })
  }

  for (const status of ['queued', 'in_progress', 'waiting']) {
    it(`lets a newer ${status} run with no check supersede the cancelled run`, () => {
      expect(
        reportContexts(cancelled, ['vitest'], [{ ...started(2, NEW), status }])[0]?.verdict,
      ).toBe('pending')
    })
  }

  it('keeps the cancelled run red when the newer run completed with no check', () => {
    const ended = { ...started(2, NEW), status: 'completed' }

    expect(reportContexts(cancelled, ['vitest'], [ended])[0]?.verdict).toBe('failed')
    expect(namesOrHead([], cancelled, [ended])).toEqual({ names: ['vitest'], from: 'head' })
  })

  it('lets the larger run id be the newer run on a tie in creation time', () => {
    expect(reportContexts(cancelled, ['vitest'], [started(2, OLD)])[0]?.verdict).toBe('pending')
    expect(reportContexts(cancelled, ['vitest'], [started(0, OLD)])[0]?.verdict).toBe('failed')
  })

  it('does not supersede a run that was not cancelled', () => {
    const running = [fromRun(check('vitest', 'FAILURE', OLD), 1, OLD, null)]

    expect(reportContexts(running, ['vitest'], [started(2, NEW)])[0]?.verdict).toBe('failed')
  })

  it('drops a name only the superseded run reported from the head list', () => {
    expect(namesOrHead([], cancelled, [started(2, NEW)])).toEqual({ names: [], from: 'head' })
    expect(namesOrHead([], cancelled)).toEqual({ names: ['vitest'], from: 'head' })
  })

  describe('needsHeadRuns', () => {
    it('is true for a cancelled run that no check of a newer run follows', () => {
      expect(needsHeadRuns(cancelled)).toBe(true)
      expect(needsHeadRuns([...cancelled, fromRun(check('lint', null, OLD), 0, OLD, null)])).toBe(
        true,
      )
    })

    it('is false once a newer run has a check', () => {
      expect(needsHeadRuns([...cancelled, fromRun(check('lint', null, NEW), 2, NEW, null)])).toBe(
        false,
      )
    })

    it('is false with no cancelled run, no run at all, or no check', () => {
      expect(needsHeadRuns([fromRun(check('vitest', 'SUCCESS', OLD), 1, OLD, 'SUCCESS')])).toBe(
        false,
      )
      expect(needsHeadRuns([check('vitest', 'FAILURE')])).toBe(false)
      expect(needsHeadRuns([])).toBe(false)
    })
  })
})

describe('namesOrHead', () => {
  it('uses the ruleset list when the base branch has one', () => {
    expect(namesOrHead(['vitest', 'types'], [check('CodeQL', 'SUCCESS')])).toEqual({
      names: ['vitest', 'types'],
      from: 'ruleset',
    })
  })

  it('falls back to the names that reported on the head when no ruleset covers the base', () => {
    const running = fromRun(check('vitest', null), 1, OLD, null)

    expect(namesOrHead([], [check('CodeQL', 'SUCCESS'), running])).toEqual({
      names: ['CodeQL', 'vitest'],
      from: 'head',
    })
  })

  it('drops a matrix placeholder name from the head list (ruling 5)', () => {
    const checks = [check(PLACEHOLDER, 'CANCELLED'), fromRun(check('vitest', null), 1, OLD, null)]

    expect(namesOrHead([], checks)).toEqual({ names: ['vitest'], from: 'head' })
  })

  it('keeps a head name with a `$` or `{{` that is not `${{`', () => {
    const names = ['cost ($)', 'docs {{ draft }}', 'env $HOME {x}']
    const checks = names.map((name) => check(name, 'SUCCESS'))

    expect(namesOrHead([], checks)).toEqual({ names, from: 'head' })
  })

  it('drops a name only a superseded cancelled run reported', () => {
    const checks = [
      fromRun(check('ab', 'FAILURE', OLD), 1, OLD, 'CANCELLED'),
      fromRun(check('lint', null, NEW), 2, NEW, null),
    ]

    expect(namesOrHead([], checks)).toEqual({ names: ['lint'], from: 'head' })
  })

  it('keeps a placeholder-shaped name that a ruleset requires', () => {
    expect(namesOrHead([PLACEHOLDER], [])).toEqual({ names: [PLACEHOLDER], from: 'ruleset' })
  })

  describe('a pending check with no workflow run (#383)', () => {
    const pendingStatus: CheckContext = {
      name: 'gitStream.cm',
      status: null,
      conclusion: null,
      startedAt: null,
    }

    it('drops it from the head list', () => {
      expect(namesOrHead([], [check('vitest', 'SUCCESS'), pendingStatus])).toEqual({
        names: ['vitest'],
        from: 'head',
      })
    })

    it('keeps it once it has concluded', () => {
      const ended = { ...pendingStatus, conclusion: 'FAILURE' }

      expect(namesOrHead([], [ended])).toEqual({ names: ['gitStream.cm'], from: 'head' })
    })

    it('keeps a check with no run whose conclusion is an empty string', () => {
      const blank = { ...pendingStatus, conclusion: '' }

      expect(namesOrHead([], [blank])).toEqual({ names: ['gitStream.cm'], from: 'head' })
    })

    it('keeps a pending check that has a run', () => {
      const running = fromRun(check('lint', null, OLD), 1, OLD, null)

      expect(namesOrHead([], [running])).toEqual({ names: ['lint'], from: 'head' })
    })

    it('keeps it when a ruleset requires it', () => {
      expect(namesOrHead(['gitStream.cm'], [pendingStatus])).toEqual({
        names: ['gitStream.cm'],
        from: 'ruleset',
      })
    })
  })
})

describe('answeringChecks (#383)', () => {
  const pending = (startedAt: string | null = null): CheckContext => ({
    name: 'vitest',
    status: null,
    conclusion: null,
    startedAt,
  })

  it('drops a pending check with no run whose name a check with a run reports', () => {
    const ran = fromRun(check('vitest', 'SUCCESS', OLD), 1, OLD, 'SUCCESS')

    expect(answeringChecks([ran, pending(NEW)])).toEqual([ran])
  })

  it('keeps a pending check with no run whose name no check with a run reports', () => {
    const ran = fromRun(check('types', 'SUCCESS', OLD), 1, OLD, 'SUCCESS')

    expect(answeringChecks([ran, pending()])).toEqual([ran, pending()])
  })

  it('keeps a newer pending check with no run beside a concluded one with no run', () => {
    const ended = { ...pending(OLD), conclusion: 'SUCCESS' }

    expect(answeringChecks([ended, pending(NEW)])).toEqual([ended, pending(NEW)])
  })

  it('keeps a concluded check with no run beside a check with a run', () => {
    const ran = fromRun(check('vitest', 'SUCCESS', OLD), 1, OLD, 'SUCCESS')
    const ended = { ...pending(NEW), conclusion: 'FAILURE' }

    expect(answeringChecks([ran, ended])).toEqual([ran, ended])
  })

  it('keeps a pending check with a run beside another check with a run', () => {
    const first = fromRun(check('vitest', 'SUCCESS', OLD), 1, OLD, 'SUCCESS')
    const second = fromRun(check('vitest', null, NEW), 2, NEW, null)

    expect(answeringChecks([first, second])).toEqual([first, second])
  })
})

describe('namesOrDefault', () => {
  it('uses the base branch list when the base branch has one', () => {
    expect(namesOrDefault(['release-check'], ['vitest', 'types'])).toEqual({
      names: ['release-check'],
      from: 'ruleset',
    })
  })

  it('falls back to the default branch list, never to what reported on the head (P9)', () => {
    expect(namesOrDefault([], ['vitest', 'types'])).toEqual({
      names: ['vitest', 'types'],
      from: 'default',
    })
  })

  it('answers an empty list when neither branch requires anything', () => {
    expect(namesOrDefault([], [])).toEqual({ names: [], from: 'default' })
  })

  it('answers unread, not empty, when the default branch could not be read (ruling 6, #298)', () => {
    expect(namesOrDefault([], null)).toEqual({ names: [], from: 'unread' })
  })

  it('uses the base branch list even when the default branch could not be read', () => {
    expect(namesOrDefault(['release-check'], null)).toEqual({
      names: ['release-check'],
      from: 'ruleset',
    })
  })
})

describe('splitDraftSkipped (#365, round 15 ruling 5)', () => {
  /** A matrix job that a draft condition skipped before the matrix
   *  expanded, as GitHub reports it. Its suite's conclusion is `suite`. */
  const MATRIX = `Analyze (\${{ matrix.language }})`
  const skippedCheck = (name: string, suite: string | null = 'SKIPPED'): CheckContext =>
    fromRun(check(name, 'SKIPPED'), 7, OLD, suite, 3, 'CodeQL')
  const ACTIONS = 'Analyze (actions)'
  const SCRIPTS = 'Analyze (javascript-typescript)'

  /** The split of `names` over `checks`, on a draft unless `draft` says no. */
  const split = (names: readonly string[], checks: readonly CheckContext[], draft = true) =>
    splitDraftSkipped(reportContexts(checks, names), checks, draft)

  it('leaves out each name a skipped matrix check stands for, sorted, on a draft', () => {
    const checks = [check('vitest', 'SUCCESS'), skippedCheck(MATRIX)]

    const answer = split([SCRIPTS, 'vitest', ACTIONS], checks)

    expect(answer.draftSkipped).toEqual([ACTIONS, SCRIPTS])
    expect(answer.counted).toEqual([
      { name: 'vitest', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
    ])
  })

  it('leaves out nothing when the pull request is not a draft', () => {
    const checks = [check('vitest', 'SUCCESS'), skippedCheck(MATRIX)]

    const answer = split([ACTIONS, 'vitest'], checks, false)

    expect(answer.draftSkipped).toEqual([])
    expect(answer.counted.map((context) => context.name)).toEqual([ACTIONS, 'vitest'])
  })

  it('keeps a name that no skipped check matches as a gate', () => {
    const answer = split([ACTIONS, 'lint'], [skippedCheck(MATRIX)])

    expect(answer.draftSkipped).toEqual([ACTIONS])
    expect(answer.counted).toEqual([
      { name: 'lint', reported: false, conclusion: null, verdict: 'pending' },
    ])
  })

  for (const [what, suite] of [
    ['concluded SUCCESS', 'SUCCESS'],
    ['concluded FAILURE', 'FAILURE'],
    ['has not concluded', null],
  ] as const) {
    it(`does not count a matching check whose suite ${what}`, () => {
      const answer = split([ACTIONS], [skippedCheck(MATRIX, suite)])

      expect(answer.draftSkipped).toEqual([])
      expect(answer.counted.map((context) => context.name)).toEqual([ACTIONS])
    })
  }

  it('does not count a matching check that no workflow run made', () => {
    const answer = split([ACTIONS], [check(MATRIX, 'SKIPPED')])

    expect(answer.draftSkipped).toEqual([])
  })

  it('keeps the verdict of a name that reported, also a failure a wildcard matches', () => {
    const checks = [check(ACTIONS, 'FAILURE'), skippedCheck(MATRIX)]

    const answer = split([ACTIONS], checks)

    expect(answer.draftSkipped).toEqual([])
    expect(answer.counted).toEqual([
      { name: ACTIONS, reported: true, conclusion: 'FAILURE', verdict: 'failed' },
    ])
  })

  for (const [what, conclusion, verdict] of [
    ['passed', 'SUCCESS', 'success'],
    ['still runs', null, 'pending'],
  ] as const) {
    it(`keeps the verdict of a name that ${what}, also one a wildcard matches`, () => {
      const checks = [check(ACTIONS, conclusion), skippedCheck(MATRIX)]

      const answer = split([ACTIONS], checks)

      expect(answer.draftSkipped).toEqual([])
      expect(answer.counted).toEqual([{ name: ACTIONS, reported: true, conclusion, verdict }])
    })
  }

  it('waits for a name that only a superseded cancelled run reported', () => {
    // The newer run of the same workflow has made another check, but not
    // this one yet. The name reads as not reported, and is still a gate.
    const checks = [
      fromRun(check(ACTIONS, 'FAILURE'), 1, OLD, 'CANCELLED'),
      fromRun(check('vitest', null), 2, NEW, null),
      skippedCheck(MATRIX),
    ]

    const answer = split([ACTIONS], checks)

    expect(answer.draftSkipped).toEqual([])
    expect(answer.counted).toEqual([
      { name: ACTIONS, reported: false, conclusion: null, verdict: 'pending' },
    ])
  })

  it('does not read a plain-named skipped check as a wildcard', () => {
    const answer = split(['CodeQL'], [skippedCheck('CodeQL (all)')])

    expect(answer.draftSkipped).toEqual([])
  })

  for (const name of [
    `pre ${ACTIONS}`,
    `${ACTIONS} post`,
    'Analyze ()',
    'Analyze (actions) (more)',
    'Analyze (a(b)c)',
    'Analyze (a(b)',
    'Analyze (a)b)',
  ]) {
    it(`matches the whole name only, and no span holds a parenthesis: ${name}`, () => {
      expect(split([name], [skippedCheck(MATRIX)]).draftSkipped).toEqual([])
    })
  }

  it('matches each regular expression character in a name literally', () => {
    const checks = [skippedCheck(`a.b+c [\${{ matrix.x }}] $^|*?{}\\`)]
    const literal = 'a.b+c [one] $^|*?{}\\'

    expect(split([literal], checks).draftSkipped).toEqual([literal])
    expect(split(['aXb+c [one] $^|*?{}\\'], checks).draftSkipped).toEqual([])
    expect(split(['a.bbc [one] $^|*?{}\\'], checks).draftSkipped).toEqual([])
  })

  it('reads every skipped check, not only the first or the last', () => {
    const checks = [
      skippedCheck(`docs (\${{ matrix.page }}) build`),
      skippedCheck(MATRIX),
      skippedCheck(`lint (\${{ matrix.part }}) all`),
    ]

    expect(split([ACTIONS], checks).draftSkipped).toEqual([ACTIONS])
  })

  it('matches a brace quantifier in a name literally', () => {
    const checks = [skippedCheck(`x{2} (\${{ matrix.x }})`)]

    expect(split(['x{2} (one)'], checks).draftSkipped).toEqual(['x{2} (one)'])
    expect(split(['xx (one)'], checks).draftSkipped).toEqual([])
  })

  it('reads a span up to the first }}, also with a single } in it', () => {
    const checks = [skippedCheck(`Analyze (\${{ format('{0}-x', matrix.language) }})`)]

    expect(split([ACTIONS], checks).draftSkipped).toEqual([ACTIONS])
  })

  it('reads each span of a name with more than one as its own wildcard', () => {
    const checks = [skippedCheck(`build (\${{ matrix.os }}, \${{ matrix.node }})`)]

    expect(split(['build (ubuntu, 22)', 'build (ubuntu)'], checks).draftSkipped).toEqual([
      'build (ubuntu, 22)',
    ])
  })
})
