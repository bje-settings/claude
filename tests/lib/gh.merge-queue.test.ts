// The merge queue reads of the real `gh` client (#503): `mergeQueue`,
// `workflowRunPath`, `fileText`, `pullRequestFiles`, `mergeQueueEntry` and
// `mergeQueueRemovals`. The client takes the process runner as a parameter,
// so a stand-in answers for `gh`, and nothing here reaches GitHub. The
// shapes come from real answers on 2026-11-13: the rules of `main` here, run
// 43462283009, `.github/workflows/ci.yml`, and pull request #510.
import { describe, expect, it } from 'vitest'

import { createGhClient, type GhClient } from '#lib/gh.ts'
import type { Runner, RunResult } from '#lib/process.ts'

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: `${overrides.stdout ?? ''}${overrides.stderr ?? ''}`,
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...overrides,
})

const json = (value: unknown, overrides: Partial<RunResult> = {}): RunResult =>
  result({ stdout: JSON.stringify(value), ...overrides })

const REPO = json({ nameWithOwner: 'bje-settings/claude' })

/** gh's answer when GitHub refused, as gh prints a 4xx body. */
const NOT_FOUND = json(
  { message: 'Not Found', status: '404' },
  { status: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
)

/** gh that printed no JSON at all. */
const BROKEN = result({ status: 1, stderr: 'gh: HTTP 502\n' })

/** A client whose runner answers each call from `replies` in order, and
 *  records the argv of every call. The last reply repeats. */
const clientAnswering = (
  replies: readonly RunResult[],
): { gh: GhClient; calls: (readonly string[])[] } => {
  const calls: (readonly string[])[] = []
  const run: Runner = async (_command, args = []) => {
    calls.push(args)
    return replies[Math.min(calls.length - 1, replies.length - 1)] as RunResult
  }
  return { gh: createGhClient({ run }), calls }
}

const QUEUE_PARAMETERS = {
  check_response_timeout_minutes: 60,
  grouping_strategy: 'ALLGREEN',
  max_entries_to_build: 5,
  max_entries_to_merge: 5,
  merge_method: 'SQUASH',
  min_entries_to_merge: 1,
  min_entries_to_merge_wait_minutes: 5,
}

const QUEUE_RULE = {
  checkResponseTimeoutMinutes: 60,
  groupingStrategy: 'ALLGREEN',
  maxEntriesToBuild: 5,
  maxEntriesToMerge: 5,
  mergeMethod: 'SQUASH',
  minEntriesToMerge: 1,
  minEntriesToMergeWaitMinutes: 5,
}

/** The rules of `main` here on 2026-11-13, with no queue. */
const MAIN_RULES = [
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
  {
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'vitest' }] },
  },
]

describe('mergeQueue', () => {
  it('reads the merge_queue rule of the branch, with each parameter', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      json([...MAIN_RULES, { type: 'merge_queue', parameters: QUEUE_PARAMETERS }]),
    ])

    await expect(gh.mergeQueue({ branch: 'spike/queue' })).resolves.toEqual({
      queue: QUEUE_RULE,
      unavailable: null,
    })
    expect(calls[1]).toEqual(['api', 'repos/bje-settings/claude/rules/branches/spike%2Fqueue'])
  })

  it('takes the first merge_queue rule when two rulesets each carry one', async () => {
    const { gh } = clientAnswering([
      REPO,
      json([
        { type: 'merge_queue', parameters: QUEUE_PARAMETERS },
        { type: 'merge_queue', parameters: { ...QUEUE_PARAMETERS, merge_method: 'MERGE' } },
      ]),
    ])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: QUEUE_RULE,
      unavailable: null,
    })
  })

  it('answers no queue for rules with no merge_queue entry', async () => {
    const { gh } = clientAnswering([REPO, json(MAIN_RULES)])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: null,
      unavailable: null,
    })
  })

  it('answers no queue for an empty list of rules', async () => {
    const { gh } = clientAnswering([REPO, json([])])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: null,
      unavailable: null,
    })
  })

  it('answers no queue for a plan that has no rulesets', async () => {
    const { gh } = clientAnswering([
      REPO,
      json(
        {
          message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
          status: '403',
        },
        { status: 1 },
      ),
    ])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: null,
      unavailable: null,
    })
  })

  it('names a refusal that is not a plan limit, and never reads it as no queue', async () => {
    const { gh } = clientAnswering([REPO, NOT_FOUND])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: null,
      unavailable: 'the rules for main were not a list of rules (404: Not Found)',
    })
  })

  it('gives what gh said when gh printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, BROKEN])

    await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
      queue: null,
      unavailable: 'gh: HTTP 502',
    })
  })

  for (const [what, rule] of [
    ['with no parameters', { type: 'merge_queue' }],
    [
      'with a count that is not a whole number',
      { type: 'merge_queue', parameters: { ...QUEUE_PARAMETERS, max_entries_to_build: '5' } },
    ],
    [
      'with no merge method',
      { type: 'merge_queue', parameters: { ...QUEUE_PARAMETERS, merge_method: null } },
    ],
  ] as const) {
    it(`refuses a merge_queue rule ${what}`, async () => {
      const { gh } = clientAnswering([REPO, json([rule])])

      await expect(gh.mergeQueue({ branch: 'main' })).resolves.toEqual({
        queue: null,
        unavailable: 'a merge-queue rule on main could not be read',
      })
    })
  }
})

describe('workflowRunPath', () => {
  it('reads the workflow path of one run', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      json({
        id: 43462283009,
        name: 'Plugin validate',
        path: '.github/workflows/plugin-validate.yml',
      }),
    ])

    await expect(gh.workflowRunPath({ run: '43462283009' })).resolves.toEqual({
      path: '.github/workflows/plugin-validate.yml',
      unavailable: null,
    })
    expect(calls[1]).toEqual(['api', 'repos/bje-settings/claude/actions/runs/43462283009'])
  })

  it('names a run that GitHub does not give', async () => {
    const { gh } = clientAnswering([REPO, NOT_FOUND])

    await expect(gh.workflowRunPath({ run: '1' })).resolves.toEqual({
      path: null,
      unavailable: 'run 1 carried no workflow path (404: Not Found)',
    })
  })

  it('refuses a run with an empty path', async () => {
    const { gh } = clientAnswering([REPO, json({ id: 1, path: '' })])

    await expect(gh.workflowRunPath({ run: '1' })).resolves.toEqual({
      path: null,
      unavailable: 'run 1 carried no workflow path',
    })
  })

  it('gives what gh said when gh printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, BROKEN])

    await expect(gh.workflowRunPath({ run: '1' })).resolves.toEqual({
      path: null,
      unavailable: 'gh: HTTP 502',
    })
  })
})

describe('fileText', () => {
  const WORKFLOW = 'name: CI\non:\n  pull_request:\n  merge_group:\n'
  const file = (text: string, extra: Record<string, unknown> = {}) =>
    json({
      type: 'file',
      encoding: 'base64',
      // REST wraps the base64 at 60 characters, with a newline.
      content: `${Buffer.from(text).toString('base64')}\n`,
      ...extra,
    })

  it('reads the text of one file at one ref, with each path segment encoded', async () => {
    const { gh, calls } = clientAnswering([REPO, file(WORKFLOW)])

    await expect(
      gh.fileText({ path: '.github/workflows/c i.yml', ref: 'spike/queue' }),
    ).resolves.toEqual({ text: WORKFLOW, unavailable: null })
    expect(calls[1]).toEqual([
      'api',
      'repos/bje-settings/claude/contents/.github/workflows/c%20i.yml?ref=spike%2Fqueue',
    ])
  })

  it('reads an empty file as empty text', async () => {
    const { gh } = clientAnswering([REPO, file('')])

    await expect(gh.fileText({ path: 'empty.yml', ref: 'main' })).resolves.toEqual({
      text: '',
      unavailable: null,
    })
  })

  it('refuses a directory, which REST gives as a list', async () => {
    const { gh } = clientAnswering([REPO, json([{ type: 'file', name: 'ci.yml' }])])

    await expect(gh.fileText({ path: '.github/workflows', ref: 'main' })).resolves.toEqual({
      text: null,
      unavailable: '.github/workflows at main is not a file',
    })
  })

  it('refuses a path that is not there, with what GitHub said', async () => {
    const { gh } = clientAnswering([REPO, NOT_FOUND])

    await expect(gh.fileText({ path: 'gone.yml', ref: 'main' })).resolves.toEqual({
      text: null,
      unavailable: 'gone.yml at main is not a file (404: Not Found)',
    })
  })

  it('refuses a file of more than 1 MB, which REST gives with no content', async () => {
    const { gh } = clientAnswering([REPO, json({ type: 'file', encoding: 'none', content: '' })])

    await expect(gh.fileText({ path: 'big.yml', ref: 'main' })).resolves.toEqual({
      text: null,
      unavailable:
        'big.yml at main came with no base64 content (a file of more than 1 MB has none)',
    })
  })

  it('refuses a file with no content field', async () => {
    const { gh } = clientAnswering([REPO, json({ type: 'file', encoding: 'base64' })])

    await expect(gh.fileText({ path: 'odd.yml', ref: 'main' })).resolves.toEqual({
      text: null,
      unavailable:
        'odd.yml at main came with no base64 content (a file of more than 1 MB has none)',
    })
  })

  it('gives what gh said when gh printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, BROKEN])

    await expect(gh.fileText({ path: 'ci.yml', ref: 'main' })).resolves.toEqual({
      text: null,
      unavailable: 'gh: HTTP 502',
    })
  })
})

describe('pullRequestFiles', () => {
  const files = (count: number, first = 0) =>
    Array.from({ length: count }, (_, index) => ({ filename: `f${first + index}.ts` }))

  it('reads each changed file, and the old path of a renamed one', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      json([
        { filename: 'lib/gh.ts', status: 'modified' },
        { filename: 'lib/new.ts', status: 'renamed', previous_filename: 'lib/old.ts' },
      ]),
    ])

    await expect(gh.pullRequestFiles({ pullRequest: 510 })).resolves.toEqual({
      files: ['lib/gh.ts', 'lib/new.ts', 'lib/old.ts'],
      unavailable: null,
    })
    expect(calls[1]).toEqual([
      'api',
      'repos/bje-settings/claude/pulls/510/files?per_page=100&page=1',
    ])
  })

  it('reads an empty list as no changed file', async () => {
    const { gh } = clientAnswering([REPO, json([])])

    await expect(gh.pullRequestFiles({ pullRequest: 1 })).resolves.toEqual({
      files: [],
      unavailable: null,
    })
  })

  it('reads the next page after a full one, and stops at a short one', async () => {
    const { gh, calls } = clientAnswering([REPO, json(files(100)), json(files(1, 100))])

    const answer = await gh.pullRequestFiles({ pullRequest: 2 })

    expect(answer.files).toHaveLength(101)
    expect(answer.unavailable).toBeNull()
    expect(calls[2]?.[1]).toBe('repos/bje-settings/claude/pulls/2/files?per_page=100&page=2')
  })

  it('refuses a list at the 3000 files REST gives at most', async () => {
    // A page 31 that answers empty must not make the 3000 a whole list.
    const pages = Array.from({ length: 30 }, (_, page) => json(files(100, page * 100)))
    const { gh } = clientAnswering([REPO, ...pages, json([])])

    await expect(gh.pullRequestFiles({ pullRequest: 3 })).resolves.toEqual({
      files: null,
      unavailable: 'pull request 3 has 3000 files or more, the most REST lists',
    })
  })

  it('refuses an answer that is not a list, with what GitHub said', async () => {
    const { gh } = clientAnswering([REPO, NOT_FOUND])

    await expect(gh.pullRequestFiles({ pullRequest: 4 })).resolves.toEqual({
      files: null,
      unavailable: 'the files of pull request 4 could not be read (404: Not Found)',
    })
  })

  it('refuses a file with no filename, and keeps no part of the list', async () => {
    const { gh } = clientAnswering([REPO, json([{ filename: 'a.ts' }, { status: 'added' }])])

    await expect(gh.pullRequestFiles({ pullRequest: 5 })).resolves.toEqual({
      files: null,
      unavailable: 'the files of pull request 5 could not be read',
    })
  })

  it('refuses the whole list when a later page fails', async () => {
    const { gh } = clientAnswering([REPO, json(files(100)), BROKEN])

    await expect(gh.pullRequestFiles({ pullRequest: 6 })).resolves.toEqual({
      files: null,
      unavailable: 'gh: HTTP 502',
    })
  })

  it('names a repository that could not be resolved', async () => {
    // A list after the failure must not be read as the files.
    const { gh } = clientAnswering([
      result({ status: 1, stderr: 'gh: no repository\n' }),
      json(files(1)),
    ])

    await expect(gh.pullRequestFiles({ pullRequest: 7 })).resolves.toEqual({
      files: null,
      unavailable: 'gh: no repository',
    })
  })
})

/** One GraphQL answer for pull request `pullRequest`. */
const graphql = (pullRequest: unknown, errors?: readonly unknown[]): RunResult =>
  json({ data: { repository: { pullRequest } }, ...(errors === undefined ? {} : { errors }) })

describe('mergeQueueEntry', () => {
  const ENTRY = { enqueuedAt: '2026-11-13T17:00:00Z', state: 'AWAITING_CHECKS', position: 0 }

  it('reads the queue entry of one pull request', async () => {
    const { gh, calls } = clientAnswering([REPO, graphql({ mergeQueueEntry: ENTRY })])

    await expect(gh.mergeQueueEntry({ pullRequest: 510 })).resolves.toEqual({
      entry: ENTRY,
      unavailable: null,
    })
    expect(calls[1]).toContain('number=510')
    expect(calls[1]?.at(-1)).toContain('mergeQueueEntry { enqueuedAt state position }')
  })

  it('answers no entry for a pull request that is not in a queue', async () => {
    const { gh } = clientAnswering([REPO, graphql({ mergeQueueEntry: null })])

    await expect(gh.mergeQueueEntry({ pullRequest: 510 })).resolves.toEqual({
      entry: null,
      unavailable: null,
    })
  })

  it('names a pull request that GraphQL does not give, and never reads it as out of a queue', async () => {
    const { gh } = clientAnswering([
      REPO,
      graphql(null, [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'gone' }]),
    ])

    await expect(gh.mergeQueueEntry({ pullRequest: 9 })).resolves.toEqual({
      entry: null,
      unavailable: 'the queue entry of pull request 9 could not be read: gone',
    })
  })

  it('refuses an entry with no position', async () => {
    const { gh } = clientAnswering([
      REPO,
      graphql({ mergeQueueEntry: { ...ENTRY, position: null } }),
    ])

    await expect(gh.mergeQueueEntry({ pullRequest: 9 })).resolves.toEqual({
      entry: null,
      unavailable: 'the queue entry of pull request 9 could not be read',
    })
  })

  it('keeps an entry, and the error GraphQL gave beside it', async () => {
    const { gh } = clientAnswering([
      REPO,
      graphql({ mergeQueueEntry: ENTRY }, [{ message: 'rate limit soon' }]),
    ])

    await expect(gh.mergeQueueEntry({ pullRequest: 9 })).resolves.toEqual({
      entry: ENTRY,
      unavailable: 'rate limit soon',
    })
  })

  it('gives what gh said when gh printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, BROKEN])

    await expect(gh.mergeQueueEntry({ pullRequest: 9 })).resolves.toEqual({
      entry: null,
      unavailable: 'gh: HTTP 502',
    })
  })
})

describe('mergeQueueRemovals', () => {
  const removals = (nodes: unknown, hasPreviousPage = false) =>
    graphql({ timelineItems: { pageInfo: { hasPreviousPage }, nodes } })

  it('reads each removal with its reason as GitHub wrote it', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      removals([
        { reason: 'merge_conflict', createdAt: '2026-11-13T17:00:00Z' },
        { reason: null, createdAt: '2026-11-13T17:10:00Z' },
      ]),
    ])

    await expect(gh.mergeQueueRemovals({ pullRequest: 510 })).resolves.toEqual({
      rows: [
        { reason: 'merge_conflict', createdAt: '2026-11-13T17:00:00Z' },
        { reason: null, createdAt: '2026-11-13T17:10:00Z' },
      ],
      unavailable: null,
    })
    expect(calls[1]).toContain('number=510')
    expect(calls[1]?.at(-1)).toContain(
      'timelineItems(last: 100, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT])',
    )
  })

  it('reads no removal as an empty list', async () => {
    const { gh } = clientAnswering([REPO, removals([])])

    await expect(gh.mergeQueueRemovals({ pullRequest: 510 })).resolves.toEqual({
      rows: [],
      unavailable: null,
    })
  })

  it('says so when older removals were not read', async () => {
    const row = { reason: 'merge_conflict', createdAt: '2026-11-13T17:00:00Z' }
    const { gh } = clientAnswering([REPO, removals([row], true)])

    await expect(gh.mergeQueueRemovals({ pullRequest: 8 })).resolves.toEqual({
      rows: [row],
      unavailable: 'pull request 8 has more than the 100 queue removals this reads',
    })
  })

  it('counts a removal with no time, or a reason that is not text, as unread', async () => {
    const { gh } = clientAnswering([
      REPO,
      removals([
        { reason: 'merge_conflict' },
        { reason: 7, createdAt: '2026-11-13T17:00:00Z' },
        { createdAt: '2026-11-13T17:00:00Z' },
      ]),
    ])

    await expect(gh.mergeQueueRemovals({ pullRequest: 8 })).resolves.toEqual({
      rows: [],
      unavailable: '3 queue removal(s) of pull request 8 could not be read',
    })
  })

  it('names a timeline that is not a connection, and the error beside it', async () => {
    const { gh } = clientAnswering([REPO, graphql(null, [{ message: 'gone' }])])

    await expect(gh.mergeQueueRemovals({ pullRequest: 8 })).resolves.toEqual({
      rows: [],
      unavailable: 'the queue removals of pull request 8 could not be read; gone',
    })
  })

  it('gives what gh said when gh printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, BROKEN])

    await expect(gh.mergeQueueRemovals({ pullRequest: 8 })).resolves.toEqual({
      rows: [],
      unavailable: 'gh: HTTP 502',
    })
  })
})

describe('enqueuePullRequest', () => {
  const HEAD = 'a'.repeat(40)
  const ENTRY = { enqueuedAt: '2026-11-13T17:00:00Z', state: 'QUEUED', position: 2 }
  const NODE = graphql({ id: 'PR_kwDO' })
  const enqueued = (mergeQueueEntry: unknown, errors?: readonly unknown[]): RunResult =>
    json({
      data: { enqueuePullRequest: mergeQueueEntry === undefined ? null : { mergeQueueEntry } },
      ...(errors === undefined ? {} : { errors }),
    })

  it('enqueues the pull request with the head the caller read, and never jumps', async () => {
    // A stand-in GitHub: it gives the node id of #512 only, and an entry
    // only to a mutation with that id and head, as strings, and no jump.
    const pair = (args: readonly string[], flag: string, value: string): boolean =>
      args.some((arg, at) => arg === value && args[at - 1] === flag)
    const head = '1'.repeat(40)
    const run: Runner = async (_command, args = []) => {
      const query = args.at(-1) ?? ''
      if (args[0] === 'repo') return REPO
      if (query.startsWith('query=query')) {
        return pair(args, '-F', 'number=512') ? NODE : graphql({ id: null })
      }
      const right =
        pair(args, '-f', 'id=PR_kwDO') &&
        pair(args, '-f', `head=${head}`) &&
        query.includes(
          'enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head })',
        ) &&
        !query.includes('jump')
      return right ? enqueued(ENTRY) : enqueued(null, [{ message: 'wrong mutation' }])
    }

    await expect(
      createGhClient({ run }).enqueuePullRequest({ pullRequest: 512, expectedHeadOid: head }),
    ).resolves.toEqual({ entry: ENTRY, unavailable: null })
  })

  it("gives GitHub's own words when it refuses the enqueue", async () => {
    const { gh } = clientAnswering([
      REPO,
      NODE,
      json(
        { data: { enqueuePullRequest: null }, errors: [{ message: 'Head sha did not match' }] },
        { status: 1 },
      ),
    ])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ entry: null, unavailable: 'Head sha did not match' })
  })

  it('names a reply with no entry and no error as no entry', async () => {
    const { gh } = clientAnswering([REPO, NODE, enqueued(null)])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({
      entry: null,
      unavailable: 'GitHub gave no queue entry for pull request 512',
    })
  })

  it('refuses an entry that is not the shape asked for', async () => {
    const { gh } = clientAnswering([REPO, NODE, enqueued({ ...ENTRY, position: '2' })])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({
      entry: null,
      unavailable: 'GitHub gave no queue entry for pull request 512',
    })
  })

  it('keeps an entry, and an error GitHub gave beside it', async () => {
    const { gh } = clientAnswering([REPO, NODE, enqueued(ENTRY, [{ message: 'slow' }, 'odd'])])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ entry: ENTRY, unavailable: 'slow' })
  })

  it('reads errors that are not a list as no message', async () => {
    const { gh } = clientAnswering([REPO, NODE, json({ data: null, errors: 'denied' })])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({
      entry: null,
      unavailable: 'GitHub gave no queue entry for pull request 512',
    })
  })

  it('reads a body that is not an object as no entry', async () => {
    const { gh } = clientAnswering([REPO, NODE, json('text')])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({
      entry: null,
      unavailable: 'GitHub gave no queue entry for pull request 512',
    })
  })

  it('gives what gh said when the mutation printed no JSON', async () => {
    const { gh } = clientAnswering([REPO, NODE, BROKEN])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ entry: null, unavailable: 'gh: HTTP 502' })
  })

  it('names the bound when the mutation timed out, whatever it printed', async () => {
    const { gh } = clientAnswering([
      REPO,
      NODE,
      result({ timedOut: true, elapsedMs: 9, stdout: JSON.stringify({ data: {} }) }),
    ])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ entry: null, unavailable: 'gh did not answer in 9 ms' })
  })

  it('writes nothing when the node id could not be read', async () => {
    // A write would answer the entry of the third reply.
    const { gh } = clientAnswering([REPO, BROKEN, enqueued(ENTRY)])

    await expect(
      gh.enqueuePullRequest({ pullRequest: 512, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ entry: null, unavailable: 'gh: HTTP 502' })
  })

  it('writes nothing for a pull request with no node id, and keeps the error beside it', async () => {
    const { gh } = clientAnswering([
      REPO,
      graphql(null, [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'gone' }]),
      enqueued(ENTRY),
    ])

    await expect(gh.enqueuePullRequest({ pullRequest: 9, expectedHeadOid: HEAD })).resolves.toEqual(
      {
        entry: null,
        unavailable: 'pull request 9 gave no node id: gone',
      },
    )
  })

  it('writes nothing for an id that is not text', async () => {
    const { gh } = clientAnswering([REPO, graphql({ id: 7 }), enqueued(ENTRY)])

    await expect(gh.enqueuePullRequest({ pullRequest: 9, expectedHeadOid: HEAD })).resolves.toEqual(
      {
        entry: null,
        unavailable: 'pull request 9 gave no node id',
      },
    )
  })
})
