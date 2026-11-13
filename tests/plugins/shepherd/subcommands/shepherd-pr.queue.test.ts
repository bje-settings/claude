// shepherd-pr, part of its tests: the merge queue actions of #503 (`queue`,
// `queue-wait`, `enqueue`) and the drop classes.
// `shepherd-pr.test-support.ts` holds the helpers and the header that says what the tests prove.
import { describe, expect, it } from 'vitest'
import type { GhClient, GhResults, MergeQueueEntry, MergeQueueRemoval } from '#harness/gh.ts'
import { createGhServer, depPr, type GhServerOptions, type PullRequestRow } from '#harness/pulls.ts'
import {
  argumentRefusal,
  dropClass,
  dropWords,
  HELP,
  secondsBetween,
} from '#shepherd/subcommands/shepherd-pr.ts'
import { drive, REPOSITORY, WALL } from './shepherd-pr.test-support.ts'

const HEAD = 'a'.repeat(40)
const ENQUEUED = '2026-10-20T22:00:00Z'
const ENTRY: MergeQueueEntry = { enqueuedAt: ENQUEUED, state: 'AWAITING_CHECKS', position: 1 }
const NO_ENTRY: GhResults['mergeQueueEntry'] = { entry: null, unavailable: null }
const NO_REMOVALS: GhResults['mergeQueueRemovals'] = { rows: [], unavailable: null }
const QUEUE_RULE = {
  checkResponseTimeoutMinutes: 60,
  groupingStrategy: 'ALLGREEN',
  maxEntriesToBuild: 5,
  maxEntriesToMerge: 5,
  mergeMethod: 'SQUASH',
  minEntriesToMerge: 1,
  minEntriesToMergeWaitMinutes: 5,
}

const queued = (entry: MergeQueueEntry = ENTRY): GhResults['mergeQueueEntry'] => ({
  entry,
  unavailable: null,
})
const removed = (...rows: MergeQueueRemoval[]): GhResults['mergeQueueRemovals'] => ({
  rows,
  unavailable: null,
})
const merged = (number: number, updatedAt = '2026-10-20T22:20:00Z'): PullRequestRow => ({
  ...depPr(number, { state: 'MERGED' }),
  updatedAt,
})

/** The server, with a sequence for the two queue reads, which the server
 *  does not route. The last entry repeats, as a server sequence does. */
const queueGh = (
  options: GhServerOptions,
  entries: readonly (GhResults['mergeQueueEntry'] | Error)[] = [NO_ENTRY],
  removals: readonly GhResults['mergeQueueRemovals'][] = [NO_REMOVALS],
): GhClient => {
  const server = createGhServer({
    ...options,
    replies: { viewRepository: REPOSITORY, ...options.replies },
  })
  const take = <T>(list: readonly T[], at: { n: number }): T => {
    const reply = list[Math.min(at.n, list.length - 1)] as T
    at.n += 1
    return reply
  }
  const entryAt = { n: 0 }
  const removalAt = { n: 0 }
  return {
    ...server,
    mergeQueueEntry: async () => {
      const reply = take(entries, entryAt)
      if (reply instanceof Error) throw reply
      return reply
    },
    mergeQueueRemovals: async () => take(removals, removalAt),
  }
}

const queueEnv = (env: NodeJS.ProcessEnv, bound = '90', poll = '30'): NodeJS.ProcessEnv => ({
  ...env,
  SHEPHERD_QUEUE_BOUND: bound,
  SHEPHERD_QUEUE_POLL: poll,
})

// --- the drop classes ------------------------------------------------------------

describe('dropClass', () => {
  it.each([
    ['merge_conflict', 'merge_conflict'],
    ['stack_invalidated', 'stack_invalidated'],
    ['invalid_merge_commit', 'invalid_merge_commit'],
    ['MERGE_CONFLICT', 'other'],
    ['a new reason', 'other'],
    ['', 'other'],
  ])('classes %j as %s', (reason, expected) => {
    expect(dropClass(reason)).toBe(expected)
  })

  it('classes a null reason as other', () => {
    expect(dropClass(null)).toBe('other')
  })

  it('quotes an other reason, and names a null one', () => {
    const at = '2026-10-20T22:10:00Z'
    expect(dropWords({ reason: 'merge_conflict', class: 'merge_conflict', createdAt: at })).toBe(
      'merge_conflict',
    )
    expect(dropWords({ reason: 'checks "x" timed out', class: 'other', createdAt: at })).toBe(
      'other ("checks \\"x\\" timed out")',
    )
    expect(dropWords({ reason: null, class: 'other', createdAt: at })).toBe(
      'other (GitHub gave no reason)',
    )
  })
})

describe('secondsBetween', () => {
  it('counts whole seconds, and refuses a time that is not one or that runs back', () => {
    expect(secondsBetween('2026-10-20T22:00:00Z', '2026-10-20T22:01:30.900Z')).toBe(90)
    expect(secondsBetween('2026-10-20T22:00:00Z', '2026-10-20T22:00:00Z')).toBe(0)
    expect(secondsBetween(null, '2026-10-20T22:00:00Z')).toBeNull()
    expect(secondsBetween('2026-10-20T22:00:00Z', null)).toBeNull()
    expect(secondsBetween('2026-10-20T22:00:01Z', '2026-10-20T22:00:00Z')).toBeNull()
  })
})

describe('argumentRefusal', () => {
  it('asks enqueue for a full sha, and queue for a time', () => {
    expect(argumentRefusal('enqueue', HEAD)).toBeNull()
    expect(argumentRefusal('enqueue', 'abc123')).toBe('enqueue needs the full head sha: abc123')
    expect(argumentRefusal('enqueue', '')).toBe('enqueue needs the full head sha: ')
    expect(argumentRefusal('queue', '')).toBeNull()
    expect(argumentRefusal('queue-wait', ENQUEUED)).toBeNull()
    expect(argumentRefusal('queue-wait', 'yesterday')).toBe('not a time: yesterday')
    expect(argumentRefusal('queue', 'yesterday')).toBe('not a time: yesterday')
    expect(argumentRefusal('state', 'anything')).toBeNull()
  })

  it.each([
    ['39 characters', 'a'.repeat(39)],
    ['41 characters', 'a'.repeat(41)],
    ['a letter past f', `${'a'.repeat(39)}g`],
    ['upper case', 'A'.repeat(40)],
    ['a prefix', `x${'a'.repeat(40)}`],
    ['a new line', `${'a'.repeat(40)}\n`],
  ])('refuses a head of %s', (_what, head) => {
    expect(argumentRefusal('enqueue', head)).toBe(`enqueue needs the full head sha: ${head}`)
  })
})

// --- queue -------------------------------------------------------------------------

describe('queue', () => {
  it('names every queue action in its usage, and the limit of #514', () => {
    for (const usage of ['queue [<since>]', 'queue-wait [<since>]', 'enqueue <head>']) {
      expect(HELP).toContain(`shepherd.ts shepherd-pr <path> <number> ${usage}`)
    }
    expect(HELP).toContain('A\nrequired workflow of a ruleset is not read (#514)')
  })

  it('reads an entry as queued, with the time so far', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1)] }, [queued()]),
    }))

    expect(result.status).toBe(0)
    expect(result.document).toMatchObject({
      action: 'queue',
      ok: true,
      detail: 'in the queue: AWAITING_CHECKS',
      result: 'queued',
      entry: ENTRY,
      drop: null,
      enqueued_at: ENQUEUED,
      left_at: new Date(WALL).toISOString(),
      queue_seconds: 1800,
    })
  })

  it('reads a merged pull request with no entry and no removal, as on #510', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [merged(1)] }),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'merged',
      result: 'merged',
      entry: null,
      drop: null,
      enqueued_at: null,
      left_at: '2026-10-20T22:20:00Z',
      queue_seconds: null,
    })
  })

  it('measures a merge from the since time when no read saw the entry', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [merged(1)] }),
    }))

    expect(result.document).toMatchObject({ result: 'merged', queue_seconds: 1200 })
  })

  it('reads merged first, beside an entry or a removal of an earlier pass', async () => {
    const drop = { reason: 'merge_conflict', createdAt: '2026-10-20T21:00:00Z' }
    const withEntry = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [merged(1)] }, [queued()]),
    }))
    const withDrop = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [merged(1)] }, [NO_ENTRY], [removed(drop)]),
    }))

    expect(withEntry.document).toMatchObject({ result: 'merged' })
    expect(withDrop.document).toMatchObject({ result: 'merged', detail: 'merged' })
  })

  it('ends the time in the queue only at a merge, a drop or now', async () => {
    const row = { ...depPr(1), updatedAt: '2026-10-20T22:20:00Z' }
    const waiting = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [row] }),
    }))
    const idle = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [{ ...row, autoMergeRequest: null }] }),
    }))

    expect(waiting.document).toMatchObject({
      result: 'waiting',
      left_at: null,
      queue_seconds: null,
    })
    expect(idle.document).toMatchObject({
      result: 'not_queued',
      left_at: null,
      queue_seconds: null,
    })
  })

  it('times an entry from its own enqueuedAt, not from an older since', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', '2026-10-20T21:00:00Z'],
      gh: queueGh({ prs: [depPr(1)] }, [queued()]),
    }))

    expect(result.document).toMatchObject({ enqueued_at: ENQUEUED, queue_seconds: 1800 })
  })

  it.each([
    ['an entry with a reason', [{ entry: ENTRY, unavailable: 'rate limit soon' }], [NO_REMOVALS]],
    [
      'removals with a reason',
      [NO_ENTRY],
      [
        {
          rows: [{ reason: 'merge_conflict', createdAt: ENQUEUED }],
          unavailable: 'more than 100 removals',
        },
      ],
    ],
  ] as const)('refuses a read that came back short: %s', async (_what, entries, removals) => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1)] }, entries, removals),
    }))

    expect(result.document).toMatchObject({ ok: false })
  })

  it('gives no end to a merge whose updatedAt is not a time', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [{ ...merged(1), updatedAt: 7 }] }),
    }))

    expect(result.document).toMatchObject({ result: 'merged', left_at: null, queue_seconds: null })
  })

  it('reads the newest removal at or after since as this pass drop', async () => {
    const old = { reason: 'merge_conflict', createdAt: '2026-10-20T21:00:00Z' }
    const fresh = { reason: 'invalid_merge_commit', createdAt: '2026-10-20T22:05:00Z' }
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [depPr(1, { auto: false })] }, [NO_ENTRY], [removed(fresh, old)]),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'removed from the queue: invalid_merge_commit',
      result: 'removed',
      drop: { ...fresh, class: 'invalid_merge_commit' },
      enqueued_at: ENQUEUED,
      left_at: fresh.createdAt,
      queue_seconds: 300,
    })
  })

  it('takes the newest of several removals, in any order', async () => {
    const first = { reason: 'merge_conflict', createdAt: '2026-10-20T22:01:00Z' }
    const second = { reason: 'stack_invalidated', createdAt: '2026-10-20T22:02:00Z' }
    for (const rows of [
      [first, second],
      [second, first],
    ]) {
      const result = await drive((_sandbox, repo) => ({
        argv: [repo, '1', 'queue'],
        gh: queueGh({ prs: [depPr(1, { auto: false })] }, [NO_ENTRY], [removed(...rows)]),
      }))

      expect(result.document).toMatchObject({ drop: { class: 'stack_invalidated' } })
    }
  })

  it('leaves out a removal from before since, and reads a removal exactly at since', async () => {
    const before = { reason: 'merge_conflict', createdAt: '2026-10-20T21:59:59Z' }
    const at = { reason: null, createdAt: ENQUEUED }
    const stale = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [depPr(1, { auto: false })] }, [NO_ENTRY], [removed(before)]),
    }))
    const edge = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', ENQUEUED],
      gh: queueGh({ prs: [depPr(1, { auto: false })] }, [NO_ENTRY], [removed(before, at)]),
    }))

    expect(stale.document).toMatchObject({ result: 'not_queued', drop: null })
    expect(edge.document).toMatchObject({
      result: 'removed',
      detail: 'removed from the queue: other (GitHub gave no reason)',
      drop: { reason: null, class: 'other', createdAt: ENQUEUED },
    })
  })

  it('reads an entry as queued even beside a removal of this pass', async () => {
    const drop = { reason: 'merge_conflict', createdAt: '2026-10-20T22:05:00Z' }
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1)] }, [queued()], [removed(drop)]),
    }))

    expect(result.document).toMatchObject({ result: 'queued' })
  })

  it('reads an open pull request with auto-merge and no entry as waiting', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1)] }),
    }))

    expect(result.document).toMatchObject({
      result: 'waiting',
      detail: 'not in the queue yet; auto-merge adds it when the rules are met',
      queue_seconds: null,
    })
  })

  it('reads one with no auto-merge, or that is closed, as not_queued', async () => {
    const manual = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1, { auto: false })] }),
    }))
    const closed = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue'],
      gh: queueGh({ prs: [depPr(1, { state: 'CLOSED' })] }),
    }))

    for (const result of [manual, closed]) {
      expect(result.document).toMatchObject({
        result: 'not_queued',
        detail: 'not in the queue, and nothing will add it',
      })
    }
  })

  it.each([
    ['the pull request', { prs: [] }, [NO_ENTRY], [NO_REMOVALS], 'GraphQL: Could not resolve'],
    [
      'the entry',
      { prs: [depPr(1)] },
      [{ entry: null, unavailable: 'gh: HTTP 502' }],
      [NO_REMOVALS],
      'the queue entry could not be read: gh: HTTP 502',
    ],
    [
      'the removals',
      { prs: [depPr(1)] },
      [NO_ENTRY],
      [{ rows: [], unavailable: 'gh: HTTP 502' }],
      'the queue removals could not be read: gh: HTTP 502',
    ],
  ] as const)(
    'refuses a read when %s could not be read',
    async (_what, options, entries, removals, said) => {
      const result = await drive((_sandbox, repo) => ({
        argv: [repo, '1', 'queue'],
        gh: queueGh(options, entries, removals),
      }))

      expect(result.status).toBe(0)
      expect(result.document.ok).toBe(false)
      expect(String(result.document.detail)).toContain(
        'could not read the queue of pull request #1: ',
      )
      expect(String(result.document.detail)).toContain(said)
    },
  )

  it('refuses a since that is not a time, before any gh call', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'queue', 'soon'],
      gh: createGhServer({}),
    }))

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('not a time: soon\n')
    expect(result.stdout).toBe('')
  })
})

// --- queue-wait ---------------------------------------------------------------------

describe('queue-wait', () => {
  it('reads until the pull request merges, and measures from the entry it saw', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh(
        { sequences: { viewPullRequest: [depPr(1), merged(1, '2026-10-20T22:15:00Z')] } },
        [queued(), NO_ENTRY],
      ),
    }))

    expect(result.document).toMatchObject({
      action: 'queue-wait',
      ok: true,
      result: 'merged',
      enqueued_at: ENQUEUED,
      left_at: '2026-10-20T22:15:00Z',
      queue_seconds: 900,
      bound: 90,
      waited: 30,
      reads_ok: 2,
      read_failures: 0,
      read_error: '',
    })
  })

  it('times a merge from the newest entry it saw, not from since or the first entry', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait', '2026-10-20T21:00:00Z'],
      env: queueEnv(sandbox.env),
      gh: queueGh(
        {
          sequences: {
            viewPullRequest: [depPr(1), depPr(1), merged(1, '2026-10-20T22:15:00Z')],
          },
        },
        [queued(), queued({ ...ENTRY, enqueuedAt: '2026-10-20T22:05:00Z' }), NO_ENTRY],
      ),
    }))

    expect(result.document).toMatchObject({
      result: 'merged',
      enqueued_at: '2026-10-20T22:05:00Z',
      queue_seconds: 600,
    })
  })

  it('reads for 540 seconds every 30 by default, and for a poll that is not one', async () => {
    for (const env of [{}, { SHEPHERD_QUEUE_POLL: '0' }]) {
      const result = await drive((sandbox, repo) => ({
        argv: [repo, '1', 'queue-wait'],
        env: { ...sandbox.env, ...env },
        gh: queueGh({ prs: [depPr(1)] }, [queued()]),
      }))

      expect(result.document).toMatchObject({
        result: 'pending',
        bound: 540,
        waited: 540,
        reads_ok: 19,
      })
    }
  })

  it('answers at once when the first read is already merged, timed from since', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait', ENQUEUED],
      env: queueEnv(sandbox.env),
      gh: queueGh({ prs: [merged(1)] }),
    }))

    expect(result.elapsed).toBe(0)
    expect(result.document).toMatchObject({ result: 'merged', queue_seconds: 1200, reads_ok: 1 })
  })

  it('reads until the queue removes it, with the class and the time in the queue', async () => {
    const drop = { reason: 'merge_conflict', createdAt: '2026-10-20T22:10:00Z' }
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh(
        { sequences: { viewPullRequest: [depPr(1), depPr(1, { auto: false })] } },
        [queued(), NO_ENTRY],
        [NO_REMOVALS, removed(drop)],
      ),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'removed from the queue: merge_conflict',
      result: 'removed',
      drop: { ...drop, class: 'merge_conflict' },
      queue_seconds: 600,
      reads_ok: 2,
    })
  })

  it('reads stack_invalidated as its own class', async () => {
    const drop = { reason: 'stack_invalidated', createdAt: '2026-10-20T22:10:00Z' }
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait', ENQUEUED],
      env: queueEnv(sandbox.env),
      gh: queueGh({ prs: [depPr(1, { auto: false })] }, [NO_ENTRY], [removed(drop)]),
    }))

    expect(result.document).toMatchObject({
      result: 'removed',
      drop: { class: 'stack_invalidated' },
    })
  })

  it('answers not_queued when nothing will add the pull request', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh({ prs: [depPr(1, { auto: false })] }),
    }))

    expect(result.document).toMatchObject({ ok: true, result: 'not_queued', reads_ok: 1 })
  })

  it('answers pending at the bound for an entry still in the queue', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh({ prs: [depPr(1)] }, [queued()]),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'in the queue: AWAITING_CHECKS; still open after 90s',
      result: 'pending',
      queue_state: 'queued',
      bound: 90,
      waited: 90,
      reads_ok: 4,
      queue_seconds: 1890,
    })
  })

  it('answers pending at the bound for a pull request that waits to go in', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env, '45'),
      gh: queueGh({ prs: [depPr(1, { checks: 'pending' })] }),
    }))

    expect(result.document).toMatchObject({
      result: 'pending',
      queue_state: 'waiting',
      waited: 45,
      reads_ok: 3,
    })
  })

  it('answers failed when the checks of a pull request that waits to go in fail', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh({
        sequences: {
          viewPullRequest: [depPr(1, { checks: 'pending' }), depPr(1, { checks: 'failed' })],
        },
      }),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'checks failed while the pull request waits to go in the queue',
      result: 'failed',
      reads_ok: 2,
    })
  })

  it('reads on past failed checks once the pull request is in the queue', async () => {
    // The checks of the head do not decide an entry: the queue tests the
    // merge group.
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env, '30'),
      gh: queueGh({ prs: [depPr(1, { checks: 'failed' })] }, [queued()]),
    }))

    expect(result.document).toMatchObject({ result: 'pending', queue_state: 'queued' })
  })

  it('counts a failed read that a good read followed, and decides from the good one', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh({ sequences: { viewPullRequest: [depPr(1), depPr(1), merged(1)] } }, [
        queued(),
        { entry: null, unavailable: 'gh: HTTP 502' },
        NO_ENTRY,
      ]),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      result: 'merged',
      reads_ok: 2,
      read_failures: 1,
      read_error: '',
      enqueued_at: ENQUEUED,
    })
  })

  it('is ok:false when the bound arrives on a failed read', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env, '60'),
      gh: queueGh({ prs: [depPr(1)] }, [queued(), { entry: null, unavailable: 'gh: HTTP 502' }]),
    }))

    expect(result.document).toMatchObject({
      ok: false,
      detail:
        'queue-wait waited 60s but could not re-read the queue (2 of 3 reads failed, the last ' +
        'among them): the queue entry could not be read: gh: HTTP 502',
      bound: 60,
      waited: 60,
      reads_ok: 1,
      read_failures: 2,
      read_error: 'the queue entry could not be read: gh: HTTP 502',
    })
  })

  it('refuses when the first read fails', async () => {
    const result = await drive((sandbox, repo) => ({
      argv: [repo, '1', 'queue-wait'],
      env: queueEnv(sandbox.env),
      gh: queueGh({ prs: [depPr(1)] }, [{ entry: null, unavailable: 'gh: HTTP 502' }]),
    }))

    expect(result.elapsed).toBe(0)
    expect(result.document).toMatchObject({
      ok: false,
      detail:
        'could not read the queue of pull request #1: the queue entry could not be read: gh: HTTP 502',
    })
  })
})

// --- enqueue ------------------------------------------------------------------------

describe('enqueue', () => {
  const QUEUE: GhResults['mergeQueue'] = { queue: QUEUE_RULE, unavailable: null }
  const OPEN = (overrides: Partial<PullRequestRow> = {}): PullRequestRow => ({
    ...depPr(1, { head: HEAD }),
    ...overrides,
  })

  /** A server with no `enqueuePullRequest` reply: a write throws, and the
   *  run ends as an internal error. So a refusal here proves no write. */
  const refusing = (options: GhServerOptions): GhClient => queueGh(options)

  it('enqueues an open pull request with the head the caller read', async () => {
    const server = queueGh({
      prs: [OPEN()],
      replies: { mergeQueue: QUEUE, listOpenStacks: { rows: [], unavailable: null } },
    })
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: {
        ...server,
        // Only the right pull request and head get an entry.
        enqueuePullRequest: async (query) =>
          query.pullRequest === 1 && query.expectedHeadOid === HEAD
            ? { entry: { ...ENTRY, state: 'QUEUED' }, unavailable: null }
            : { entry: null, unavailable: `wrong query: ${JSON.stringify(query)}` },
      },
    }))

    expect(result.status).toBe(0)
    expect(result.document).toMatchObject({
      action: 'enqueue',
      ok: true,
      detail: 'enqueued: QUEUED',
      result: 'enqueued',
      entry: { ...ENTRY, state: 'QUEUED' },
    })
  })

  it('reads the queue of the base of the pull request, not of main', async () => {
    const server = queueGh({
      prs: [OPEN({ baseRefName: 'release/1' })],
      replies: { listOpenStacks: { rows: [], unavailable: null } },
    })
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: {
        ...server,
        mergeQueue: async ({ branch }) =>
          branch === 'release/1'
            ? { queue: QUEUE_RULE, unavailable: null }
            : { queue: null, unavailable: null },
        enqueuePullRequest: async () => ({ entry: ENTRY, unavailable: null }),
      },
    }))

    expect(result.document).toMatchObject({ ok: true, result: 'enqueued' })
  })

  it('answers queued when a write gave no entry but the entry is there after it', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh(
        {
          prs: [OPEN()],
          replies: {
            mergeQueue: QUEUE,
            listOpenStacks: { rows: [], unavailable: null },
            enqueuePullRequest: { entry: null, unavailable: 'gh timed out after 60s' },
          },
        },
        [NO_ENTRY, queued()],
      ),
    }))

    expect(result.document).toMatchObject({
      ok: true,
      detail: 'in the queue after the enqueue: AWAITING_CHECKS',
      result: 'queued',
      entry: ENTRY,
    })
  })

  it('answers unconfirmed when a write gave no entry and the entry cannot be read again', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh(
        {
          prs: [OPEN()],
          replies: {
            mergeQueue: QUEUE,
            listOpenStacks: { rows: [], unavailable: null },
            enqueuePullRequest: { entry: null, unavailable: 'gh timed out after 60s' },
          },
        },
        [NO_ENTRY, { entry: null, unavailable: 'gh: HTTP 502' }],
      ),
    }))

    expect(result.document).toMatchObject({
      ok: false,
      result: 'unconfirmed',
      detail:
        'refused: the enqueue gave no entry (gh timed out after 60s), and the entry could not ' +
        'be read again: gh: HTTP 502',
    })
  })

  it('refuses a head that moved by one character, even when an entry is there', async () => {
    const moved = `${'a'.repeat(39)}b`
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh(
        {
          prs: [OPEN({ headRefOid: moved })],
          replies: { mergeQueue: QUEUE, listOpenStacks: { rows: [], unavailable: null } },
        },
        [queued()],
      ),
    }))

    expect(result.document).toMatchObject({ ok: false, result: 'head_moved' })
  })

  it("gives GitHub's own words when it refuses the enqueue", async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh({
        prs: [OPEN()],
        replies: {
          mergeQueue: QUEUE,
          listOpenStacks: { rows: [], unavailable: null },
          enqueuePullRequest: { entry: null, unavailable: 'Pull request is not mergeable' },
        },
      }),
    }))

    expect(result.document).toMatchObject({
      ok: false,
      detail: 'GitHub refused the enqueue: Pull request is not mergeable',
      result: 'refused',
      reason: 'Pull request is not mergeable',
    })
  })

  it('answers an entry already in the queue, with no write', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh(
        {
          prs: [OPEN()],
          replies: { mergeQueue: QUEUE, listOpenStacks: { rows: [], unavailable: null } },
        },
        [queued()],
      ),
    }))

    expect(result.status).toBe(0)
    expect(result.document).toMatchObject({
      ok: true,
      detail: 'already in the queue: AWAITING_CHECKS',
      result: 'queued',
      entry: ENTRY,
    })
  })

  it.each([
    [
      'a base with no queue',
      { prs: [OPEN()], replies: { mergeQueue: { queue: null, unavailable: null } } },
      'no_queue',
      'refused: main has no merge queue',
    ],
    [
      'a queue that could not be read',
      { prs: [OPEN()], replies: { mergeQueue: { queue: null, unavailable: 'gh: HTTP 502' } } },
      'unread',
      'refused: the merge queue of main could not be read: gh: HTTP 502',
    ],
    [
      'a pull request that is not open',
      { prs: [OPEN({ state: 'MERGED' })], replies: { mergeQueue: QUEUE } },
      'not_open',
      'refused: pull request is MERGED, not OPEN',
    ],
    [
      'a layer of a stack',
      {
        prs: [OPEN()],
        replies: {
          mergeQueue: QUEUE,
          listOpenStacks: {
            rows: [
              {
                number: 9,
                base: 'main',
                layers: [
                  { number: 1, state: 'OPEN' },
                  { number: 2, state: 'OPEN' },
                ],
              },
            ],
            unavailable: 'one stack could not be read',
          },
        },
      },
      'stacked',
      'refused: #1 is a layer of stack #9; a stack goes in only with gh stack merge (shepherd-stack merge)',
    ],
    [
      'stacks that could not be read in full',
      {
        prs: [OPEN()],
        replies: {
          mergeQueue: QUEUE,
          listOpenStacks: {
            rows: [{ number: 9, base: 'main', layers: [{ number: 2, state: 'OPEN' }] }],
            unavailable: 'gh: HTTP 502',
          },
        },
      },
      'unread',
      'refused: the stacks could not be read: gh: HTTP 502',
    ],
    [
      'a head that moved',
      {
        prs: [OPEN({ headRefOid: 'b'.repeat(40) })],
        replies: { mergeQueue: QUEUE, listOpenStacks: { rows: [], unavailable: null } },
      },
      'head_moved',
      `refused: the head is ${'b'.repeat(40)}, not ${HEAD}`,
    ],
  ] as const)('refuses %s before any write', async (_what, options, expected, detail) => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: refusing(options as GhServerOptions),
    }))

    expect(result.status).toBe(0)
    expect(result.document).toMatchObject({ ok: false, result: expected, detail })
  })

  it('refuses when the entry could not be read, before any write', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh(
        {
          prs: [OPEN()],
          replies: { mergeQueue: QUEUE, listOpenStacks: { rows: [], unavailable: null } },
        },
        [{ entry: null, unavailable: 'gh: HTTP 502' }],
      ),
    }))

    expect(result.document).toMatchObject({
      ok: false,
      result: 'unread',
      detail: 'refused: the queue entry could not be read: gh: HTTP 502',
    })
  })

  it('reads the queue first: a stacked layer on a base with no queue is no_queue', async () => {
    // The real exercise (#512): a stacked layer on `main`, which has no
    // queue. No stack read is registered, so a later check would throw.
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh({ prs: [OPEN()], replies: { mergeQueue: { queue: null, unavailable: null } } }),
    }))

    expect(result.document).toMatchObject({ ok: false, result: 'no_queue' })
  })

  it('refuses a pull request it could not read', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue', HEAD],
      gh: queueGh({ prs: [] }),
    }))

    expect(result.document).toMatchObject({ ok: false })
    expect(String(result.document.detail)).toContain('could not read pull request #1: ')
  })

  it('refuses a head that is not a full sha, before any gh call', async () => {
    const result = await drive((_sandbox, repo) => ({
      argv: [repo, '1', 'enqueue'],
      gh: createGhServer({}),
    }))

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('enqueue needs the full head sha: \n')
  })
})
