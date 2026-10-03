// The one derivation of the required contexts, which `pr-state` and `watch`
// share (round 10 ruling P6). Pure functions, so every example is a literal
// list in and a literal answer out.
import { describe, expect, it } from 'vitest'

import type { CheckContext } from '#harness/gh.ts'
import { namesOrDefault, namesOrHead, reportContexts } from '#workstreams/required-contexts.ts'

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

describe('namesOrHead', () => {
  it('uses the ruleset list when the base branch has one', () => {
    expect(namesOrHead(['vitest', 'types'], [check('CodeQL', 'SUCCESS')])).toEqual({
      names: ['vitest', 'types'],
      from: 'ruleset',
    })
  })

  it('falls back to the names that reported on the head when no ruleset covers the base', () => {
    expect(namesOrHead([], [check('CodeQL', 'SUCCESS'), check('vitest', null)])).toEqual({
      names: ['CodeQL', 'vitest'],
      from: 'head',
    })
  })

  it('drops a matrix placeholder name from the head list (ruling 5)', () => {
    const checks = [check(PLACEHOLDER, 'CANCELLED'), check('vitest', null)]

    expect(namesOrHead([], checks)).toEqual({ names: ['vitest'], from: 'head' })
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
