// The one derivation of the required contexts, which `pr-state` and `watch`
// share (round 10 ruling P6). Pure functions, so every example is a literal
// list in and a literal answer out.
import { describe, expect, it } from 'vitest'

import type { CheckContext } from '#harness/gh.ts'
import { namesOrDefault, namesOrHead, reportContexts } from '#workstreams/required-contexts.ts'

const check = (name: string, conclusion: string | null): CheckContext => ({
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
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

  it('takes the first check under a name, which is the newest', () => {
    const checks = [check('vitest', 'SUCCESS'), check('vitest', 'FAILURE')]

    expect(reportContexts(checks, ['vitest'])[0]?.conclusion).toBe('SUCCESS')
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
})
