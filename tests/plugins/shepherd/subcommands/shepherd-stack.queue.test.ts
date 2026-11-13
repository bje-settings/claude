// `shepherd.ts shepherd-stack` queue actions (#503): `queue` and
// `queue-wait` over the layers of a stack that `gh stack merge` put in the
// merge queue, and the layer that dropped first.
//
// **No test waits.** `fakeTime` moves the clock by each sleep.
import { describe, expect, it } from 'vitest'
import {
  type GhClient,
  type GhResults,
  ghFails,
  type MergeQueueEntry,
  type PullRequestStack,
} from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { captureOutput } from '#harness/output.ts'
import { createGhServer, depPr, type PullRequestRow } from '#harness/pulls.ts'
import { createSandbox } from '#harness/sandbox.ts'
import type { ShepherdContext } from '#shepherd/shepherd.ts'
import {
  HELP,
  type LayerQueue,
  runShepherdStack,
  stackQueueResult,
} from '#shepherd/subcommands/shepherd-stack.ts'
import { fakeTime } from './shepherd-pr.test-support.ts'

const REPOSITORY = { nameWithOwner: 'bje-settings/claude', defaultBranchRef: { name: 'main' } }
const ENQUEUED = '2026-10-20T22:00:00Z'
const ENTRY: MergeQueueEntry = { enqueuedAt: ENQUEUED, state: 'AWAITING_CHECKS', position: 1 }
const NO_ENTRY: GhResults['mergeQueueEntry'] = { entry: null, unavailable: null }
const NO_REMOVALS: GhResults['mergeQueueRemovals'] = { rows: [], unavailable: null }
const queued = (entry = ENTRY): GhResults['mergeQueueEntry'] => ({ entry, unavailable: null })

/** A layer of stack 472 that has no auto-merge: GitHub does not support
 *  it on a stacked pull request. */
const open = (number: number): PullRequestRow => depPr(number, { auto: false })
const merged = (number: number, updatedAt = '2026-10-20T22:20:00Z'): PullRequestRow => ({
  ...depPr(number, { state: 'MERGED', auto: false }),
  updatedAt,
})

const STACK: PullRequestStack = {
  number: 472,
  base: 'main',
  layers: [
    { number: 470, state: 'OPEN' },
    { number: 471, state: 'OPEN' },
  ],
}

interface World {
  readonly stacks?: GhResults['listOpenStacks']
  /** The answers of each layer, in the order of the reads. The last one
   *  repeats. */
  readonly views: Record<number, readonly (PullRequestRow | Error)[]>
  readonly entries?: Record<number, readonly GhResults['mergeQueueEntry'][]>
  readonly removals?: Record<number, readonly GhResults['mergeQueueRemovals'][]>
}

/** `gh` over `world`. No write is registered, so a write throws. */
const serve = (world: World): GhClient => {
  const server = createGhServer({ replies: { viewRepository: REPOSITORY } })
  const taken = new Map<string, number>()
  const next = <T>(key: string, list: readonly T[] | undefined, fallback: T): T => {
    if (list === undefined) return fallback
    const at = taken.get(key) ?? 0
    taken.set(key, at + 1)
    return list[Math.min(at, list.length - 1)] as T
  }
  return {
    ...server,
    listOpenStacks: async () => world.stacks ?? { rows: [STACK], unavailable: null },
    viewPullRequest: async ({ pullRequest }) => {
      const reply = next(`view${pullRequest}`, world.views[pullRequest], new Error('no row'))
      if (reply instanceof Error) throw reply
      return reply
    },
    mergeQueueEntry: async ({ pullRequest }) =>
      next(`entry${pullRequest}`, world.entries?.[pullRequest], NO_ENTRY),
    mergeQueueRemovals: async ({ pullRequest }) =>
      next(`removal${pullRequest}`, world.removals?.[pullRequest], NO_REMOVALS),
  }
}

/** One run of the command in a real checkout. */
const stack = async (
  gh: GhClient,
  argv: readonly string[],
  env: Record<string, string> = { SHEPHERD_QUEUE_BOUND: '90', SHEPHERD_QUEUE_POLL: '30' },
) => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const output = captureOutput()
  const time = fakeTime()
  const context: ShepherdContext = {
    cwd: repo,
    env: { ...sandbox.env, ...env },
    output,
    createGh: () => gh,
    now: time.now,
    clock: time.clock,
    sleep: time.sleep,
  }
  const code = await runShepherdStack([repo, '472', ...argv], context)
  const stdout = output.stdout()
  return {
    code,
    stderr: output.stderr(),
    document: stdout.startsWith('{') ? JSON.parse(stdout) : null,
    elapsed: time.at(),
  }
}

const layer = (
  number: number,
  result: LayerQueue['result'],
  at: string | null = null,
  kind: 'other' | 'stack_invalidated' | 'merge_conflict' = 'other',
) => ({
  number,
  result,
  drop: at === null ? null : { reason: kind, class: kind, createdAt: at },
})

describe('stackQueueResult', () => {
  it('is merged only when every layer merged', () => {
    expect(stackQueueResult([layer(1, 'merged'), layer(2, 'merged')])).toEqual({
      result: 'merged',
      first: null,
    })
    expect(stackQueueResult([layer(1, 'merged'), layer(2, 'queued')]).result).toBe('queued')
  })

  it('names the layer with the oldest drop, whatever the order', () => {
    const bottom = layer(1, 'removed', '2026-10-20T22:10:00Z')
    const top = layer(2, 'removed', '2026-10-20T22:09:00Z')
    expect(stackQueueResult([bottom, top]).first).toBe(top)
    expect(stackQueueResult([top, bottom]).first).toBe(top)
  })

  it('passes over a stack_invalidated layer while a layer of another class dropped', () => {
    // The upper layer reads stack_invalidated one second before the cause.
    const cause = layer(1, 'removed', '2026-10-20T22:10:01Z', 'merge_conflict')
    const swept = layer(2, 'removed', '2026-10-20T22:10:00Z', 'stack_invalidated')
    expect(stackQueueResult([cause, swept]).first).toBe(cause)
    expect(stackQueueResult([swept, cause]).first).toBe(cause)
  })

  it('names the oldest stack_invalidated layer when every drop is one', () => {
    const lower = layer(1, 'removed', '2026-10-20T22:10:01Z', 'stack_invalidated')
    const upper = layer(2, 'removed', '2026-10-20T22:10:00Z', 'stack_invalidated')
    expect(stackQueueResult([lower, upper]).first).toBe(upper)
  })

  it('names the bottom layer of a tie', () => {
    const bottom = layer(1, 'removed', '2026-10-20T22:10:00Z')
    const top = layer(2, 'removed', '2026-10-20T22:10:00Z')
    expect(stackQueueResult([bottom, top]).first).toBe(bottom)
  })

  it('reads a waiting layer as open, and no entry and no drop as not_queued', () => {
    expect(stackQueueResult([layer(1, 'waiting'), layer(2, 'not_queued')]).result).toBe('queued')
    expect(stackQueueResult([layer(1, 'merged'), layer(2, 'not_queued')]).result).toBe('not_queued')
  })
})

describe('queue', () => {
  it('names both queue actions in its usage', () => {
    expect(HELP).toContain('shepherd.ts shepherd-stack <path> <stack> queue [<since>]')
    expect(HELP).toContain('shepherd.ts shepherd-stack <path> <stack> queue-wait [<since>]')
  })

  it('reads each layer that is not closed, a merged one included', async () => {
    const ran = await stack(
      serve({
        stacks: {
          rows: [
            {
              ...STACK,
              layers: [
                { number: 469, state: 'MERGED' },
                ...STACK.layers,
                { number: 473, state: 'CLOSED' },
              ],
            },
          ],
          unavailable: null,
        },
        views: { 469: [merged(469)], 470: [open(470)], 471: [open(471)] },
        entries: { 470: [queued()], 471: [queued({ ...ENTRY, position: 2 })] },
      }),
      ['queue'],
    )

    expect(ran.code).toBe(0)
    expect(ran.document).toMatchObject({
      action: 'queue',
      stack: 472,
      ok: true,
      detail: 'the stack is in the queue',
      base: 'main',
      result: 'queued',
      layer: null,
      drop: null,
      queue_seconds: 1800,
    })
    expect(ran.document.layers.map((each: LayerQueue) => [each.number, each.result])).toEqual([
      [469, 'merged'],
      [470, 'queued'],
      [471, 'queued'],
    ])
    expect(ran.document.layers[0]).not.toHaveProperty('pr')
  })

  it('names the layer that dropped first, when stack_invalidated takes the layer above it', async () => {
    const conflict = { reason: 'merge_conflict', createdAt: '2026-10-20T22:10:00Z' }
    const invalidated = { reason: 'stack_invalidated', createdAt: '2026-10-20T22:10:02Z' }
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471)] },
        removals: {
          470: [{ rows: [conflict], unavailable: null }],
          471: [{ rows: [invalidated], unavailable: null }],
        },
      }),
      ['queue', ENQUEUED],
    )

    expect(ran.document).toMatchObject({
      ok: true,
      detail: '#470 dropped first: merge_conflict',
      result: 'removed',
      layer: 470,
      drop: { ...conflict, class: 'merge_conflict' },
      queue_seconds: 602,
    })
  })

  it('names the bottom layer when every layer reads stack_invalidated at once', async () => {
    const invalidated = { reason: 'stack_invalidated', createdAt: '2026-10-20T22:10:00Z' }
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471)] },
        removals: {
          470: [{ rows: [invalidated], unavailable: null }],
          471: [{ rows: [invalidated], unavailable: null }],
        },
      }),
      ['queue'],
    )

    expect(ran.document).toMatchObject({
      result: 'removed',
      layer: 470,
      detail: '#470 dropped first: stack_invalidated',
      queue_seconds: null,
    })
  })

  it('reads every layer merged as merged', async () => {
    const ran = await stack(
      serve({ views: { 470: [merged(470)], 471: [merged(471, '2026-10-20T22:21:00Z')] } }),
      ['queue', ENQUEUED],
    )

    expect(ran.document).toMatchObject({
      detail: 'every layer merged',
      result: 'merged',
      queue_seconds: 1260,
    })
  })

  it('reads no entry and no drop as not_queued', async () => {
    const ran = await stack(serve({ views: { 470: [open(470)], 471: [open(471)] } }), ['queue'])

    expect(ran.document).toMatchObject({
      detail: 'no layer is in the queue, and none dropped',
      result: 'not_queued',
    })
  })

  it('answers gone, not a failure, for a stack with no open pull request', async () => {
    const ran = await stack(serve({ stacks: { rows: [], unavailable: null }, views: {} }), [
      'queue',
    ])

    expect(ran.document).toMatchObject({
      ok: true,
      result: 'gone',
      detail:
        'no open pull request is in stack #472; read each layer of the merge report with ' +
        'shepherd-pr merged',
    })
  })

  it('refuses a stack read that came back short and does not hold the stack', async () => {
    const ran = await stack(
      serve({ stacks: { rows: [], unavailable: 'gh: HTTP 502' }, views: {} }),
      ['queue'],
    )

    expect(ran.document).toMatchObject({
      ok: false,
      detail: 'could not read stack #472: gh: HTTP 502',
      read_error: 'gh: HTTP 502',
    })
  })

  it('refuses with the layer whose read failed', async () => {
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471)] },
        entries: { 471: [{ entry: null, unavailable: 'gh: HTTP 502' }] },
      }),
      ['queue'],
    )

    expect(ran.document).toMatchObject({
      ok: false,
      detail: 'could not read the queue of #471: the queue entry could not be read: gh: HTTP 502',
      layer: 471,
    })
  })

  it('refuses a since that is not a time, and a fifth argument, before any gh call', async () => {
    const gh = serve({ views: {} })
    const bad = await stack(
      { ...gh, viewRepository: async () => Promise.reject(new Error('no')) },
      ['queue', 'soon'],
    )
    const extra = await stack(gh, ['queue', ENQUEUED, 'more'])
    const state = await stack(gh, ['state', ENQUEUED])

    expect([bad.code, bad.stderr]).toEqual([2, 'not a time: soon\n'])
    expect(extra.code).toBe(2)
    expect(extra.stderr).toBe(`${HELP}\n`)
    expect(state.code).toBe(2)
  })
})

describe('queue-wait', () => {
  it('follows the layers of the first read until every one merged', async () => {
    // The second read of the stack would find nothing: a merged stack is
    // gone from the open stacks. The wait reads only the layers.
    const ran = await stack(
      serve({
        views: { 470: [open(470), merged(470)], 471: [open(471), merged(471)] },
        entries: { 470: [queued(), NO_ENTRY], 471: [queued(), NO_ENTRY] },
      }),
      ['queue-wait'],
    )

    expect(ran.document).toMatchObject({
      action: 'queue-wait',
      ok: true,
      detail: 'every layer merged',
      result: 'merged',
      queue_seconds: 1200,
      bound: 90,
      waited: 30,
      reads_ok: 2,
      read_failures: 0,
      read_error: '',
    })
    expect(ran.document.layers[0]).toMatchObject({ enqueued_at: ENQUEUED })
  })

  it('reads until a layer drops, and names it', async () => {
    const drop = { reason: 'merge_conflict', createdAt: '2026-10-20T22:10:00Z' }
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471)] },
        entries: { 470: [queued(), NO_ENTRY], 471: [queued()] },
        removals: { 470: [NO_REMOVALS, { rows: [drop], unavailable: null }] },
      }),
      ['queue-wait'],
    )

    expect(ran.document).toMatchObject({ result: 'removed', layer: 470, reads_ok: 2 })
  })

  it('answers pending at the bound while the stack is in the queue', async () => {
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471)] },
        entries: { 470: [queued()], 471: [queued()] },
      }),
      ['queue-wait'],
    )

    expect(ran.document).toMatchObject({
      ok: true,
      detail: 'the stack is in the queue; still open after 90s',
      result: 'pending',
      waited: 90,
      reads_ok: 4,
    })
  })

  it('answers at once on a first read that settles it', async () => {
    const ran = await stack(serve({ views: { 470: [open(470)], 471: [open(471)] } }), [
      'queue-wait',
    ])

    expect(ran.elapsed).toBe(0)
    expect(ran.document).toMatchObject({ result: 'not_queued', reads_ok: 1 })
  })

  it('is ok:false, with the layer, when the bound arrives on a failed read', async () => {
    const ran = await stack(
      serve({
        views: { 470: [open(470)], 471: [open(471), ghFails('gone')] },
        entries: { 470: [queued()], 471: [queued()] },
      }),
      ['queue-wait'],
      { SHEPHERD_QUEUE_BOUND: '60', SHEPHERD_QUEUE_POLL: '30' },
    )

    expect(ran.document).toMatchObject({
      ok: false,
      layer: 471,
      bound: 60,
      waited: 60,
      reads_ok: 1,
      read_failures: 2,
      read_error: 'gone',
    })
    expect(ran.document.detail).toBe(
      'queue-wait waited 60s but could not re-read the queue of #471 (2 of 3 reads failed, the ' +
        'last among them): gone',
    )
  })

  it('refuses when the first read fails', async () => {
    const ran = await stack(serve({ views: { 470: [ghFails('gone')], 471: [open(471)] } }), [
      'queue-wait',
    ])

    expect(ran.document).toMatchObject({
      ok: false,
      detail: 'could not read the queue of #470: gone',
      layer: 470,
    })
  })

  it('answers gone for a stack with no open pull request', async () => {
    const ran = await stack(serve({ stacks: { rows: [], unavailable: null }, views: {} }), [
      'queue-wait',
    ])

    expect(ran.document).toMatchObject({ ok: true, result: 'gone' })
  })
})
