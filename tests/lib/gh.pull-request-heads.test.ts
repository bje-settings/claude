// `listOpenPullRequestHeads`: every open pull request with its head commit and
// the checks on that commit, in one paginated read. The client takes the
// process runner as a parameter, so a stand-in answers for `gh`, and nothing
// here reaches GitHub. The query was run once against the real API on
// 2026-09-26; the argv test below pins its text.
import { expect, it } from 'vitest'

import { createGhClient, type GhClient } from '#lib/gh.ts'
import type { Runner, RunResult } from '#lib/process.ts'

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...overrides,
})

const REPO = result({ stdout: '{"nameWithOwner":"acme/widgets"}' })

/** A client whose runner answers each call from `replies` in order, and
 *  records every argv. The last reply repeats. */
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

/** One page of the connection, as gh prints it. */
const page = (nodes: readonly unknown[], hasNextPage = false, endCursor: string | null = null) =>
  result({
    stdout: JSON.stringify({
      data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } },
    }),
  })

const SHA = 'a'.repeat(40)

/** One pull request node, as the query asks for it. */
const node = (overrides: Record<string, unknown> = {}) => ({
  number: 259,
  title: 'feat(workstreams): pr-state and sweep',
  isDraft: true,
  headRefName: 'wktr-219-pr-sweep',
  headRefOid: SHA,
  baseRefName: 'wktr-244-ws-hook',
  isCrossRepository: false,
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'vitest',
                  status: 'COMPLETED',
                  conclusion: 'SUCCESS',
                  startedAt: '2026-09-26T00:05:00Z',
                  checkSuite: {
                    conclusion: 'SUCCESS',
                    workflowRun: {
                      databaseId: 37098610809,
                      createdAt: '2026-09-26T00:04:58Z',
                      workflow: { name: 'CI' },
                    },
                  },
                },
                {
                  __typename: 'CheckRun',
                  name: 'CodeQL',
                  status: 'COMPLETED',
                  conclusion: 'SUCCESS',
                  startedAt: '2026-09-26T00:06:00Z',
                  checkSuite: { conclusion: 'SUCCESS', workflowRun: null },
                },
                {
                  __typename: 'StatusContext',
                  context: 'Preview',
                  state: 'PENDING',
                  createdAt: '2026-09-26T00:00:00Z',
                },
              ],
            },
          },
        },
      },
    ],
  },
  ...overrides,
})

it('asks for every open pull request with its head commit and the checks on it', async () => {
  const { gh, calls } = clientAnswering([REPO, page([node()])])

  const answer = await gh.listOpenPullRequestHeads()

  expect(calls[1]?.slice(0, 6)).toEqual([
    'api',
    'graphql',
    '-f',
    'owner=acme',
    '-f',
    'name=widgets',
  ])
  const query = calls[1]?.[7] ?? ''
  expect(query).toContain('pullRequests(states: OPEN, first: 100, after: $cursor')
  expect(query).toContain(
    'number title isDraft headRefName headRefOid baseRefName isCrossRepository\n',
  )
  expect(query).toContain('commits(last: 1) { nodes { commit { statusCheckRollup {')
  // One page of checks per head: a row whose checks run past it is refused.
  expect(query).toContain('contexts(first: 100) {')
  // `startedAt`/`createdAt` are what tells a re-run from the run it
  // cancelled apart (#243). The check suite names the run behind a check,
  // so a newer run can supersede a cancelled one (#364).
  expect(query).toContain(
    '... on CheckRun {\n' +
      '                name status conclusion startedAt\n' +
      '                checkSuite { conclusion workflowRun { databaseId createdAt workflow { name } } }\n' +
      '              }',
  )
  expect(query).toContain('... on StatusContext { context state createdAt }')
  expect(answer).toEqual({
    rows: [
      {
        number: 259,
        title: 'feat(workstreams): pr-state and sweep',
        head: 'wktr-219-pr-sweep',
        headSha: SHA,
        base: 'wktr-244-ws-hook',
        draft: true,
        crossRepository: false,
        // A commit status that has not concluded carries no conclusion, the
        // same rule `viewPullRequestDetail` applies. Each carries when it
        // started, read from a check run's `startedAt` or a commit
        // status's `createdAt`.
        checks: [
          {
            name: 'vitest',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            startedAt: '2026-09-26T00:05:00Z',
            run: {
              id: 37098610809,
              workflow: 'CI',
              createdAt: '2026-09-26T00:04:58Z',
              conclusion: 'SUCCESS',
            },
          },
          // A check run that no workflow made has no run.
          {
            name: 'CodeQL',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            startedAt: '2026-09-26T00:06:00Z',
          },
          {
            name: 'Preview',
            status: null,
            conclusion: null,
            startedAt: '2026-09-26T00:00:00Z',
          },
        ],
      },
    ],
    unavailable: null,
  })
})

it('reads a head nothing has reported on as a head with no checks', async () => {
  const { gh } = clientAnswering([
    REPO,
    page([node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })]),
  ])

  const answer = await gh.listOpenPullRequestHeads()

  expect(answer.rows[0]?.checks).toEqual([])
  expect(answer.unavailable).toBeNull()
})

it('reads a head branch in a fork as one', async () => {
  const { gh } = clientAnswering([REPO, page([node({ isCrossRepository: true })])])

  const answer = await gh.listOpenPullRequestHeads()

  expect(answer.rows[0]?.crossRepository).toBe(true)
})

it('refuses a row it cannot trust, and says how many it left out', async () => {
  const truncated = {
    nodes: [
      {
        commit: {
          statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true }, nodes: [] } },
        },
      },
    ],
  }
  const { gh } = clientAnswering([
    REPO,
    page([
      node({ number: null }),
      node({ title: null }),
      node({ headRefName: null }),
      node({ headRefOid: null }),
      node({ baseRefName: null }),
      node({ isDraft: 'yes' }),
      node({ isCrossRepository: null }),
      node({ commits: null }),
      node({ commits: { nodes: [] } }),
      node({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: null } } }] } }),
      node({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'x' }] },
                },
              },
            },
          ],
        },
      }),
      // More checks than one page holds: a check list cut short could
      // leave out the one required context that failed.
      node({ commits: truncated }),
      node({ number: 260 }),
    ]),
  ])

  const answer = await gh.listOpenPullRequestHeads()

  expect(answer.rows.map((row) => row.number)).toEqual([260])
  expect(answer.unavailable).toBe('12 pullRequests row(s) could not be read')
})

it('reports a reply it could not read at all, and throws nothing', async () => {
  const { gh } = clientAnswering([
    REPO,
    result({ status: 1, stdout: '', stderr: 'gh: HTTP 502\n' }),
  ])

  await expect(gh.listOpenPullRequestHeads()).resolves.toEqual({
    rows: [],
    unavailable: 'gh: HTTP 502',
  })
})
