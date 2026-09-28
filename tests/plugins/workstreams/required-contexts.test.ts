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
