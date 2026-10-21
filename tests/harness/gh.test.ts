// The mock's own claims. The suite's other tests read a registered reply
// back through a command. A mock that quietly answered undefined would
// make them pass for the wrong reason. So would a mock that answered every
// endpoint from the first registration.
import { expect, it } from 'vitest'
import { createGhMock, type GhClient, type GhEndpoint, GhError, ghFails } from '#harness/gh.ts'

// One call per endpoint, written out, not derived. A table built from the
// interface would go on passing after an endpoint was renamed. These are
// the argument shapes the plugins actually pass.
const CALLS: Array<[GhEndpoint, (client: GhClient) => Promise<unknown>]> = [
  [
    'listPullRequests',
    (client) => client.listPullRequests({ state: 'open', label: 'dependencies' }),
  ],
  [
    'listMergedPullRequests',
    (client) => client.listMergedPullRequests({ base: 'main', limit: 200 }),
  ],
  ['viewPullRequest', (client) => client.viewPullRequest({ pullRequest: 7 })],
  ['viewRepository', (client) => client.viewRepository()],
  ['listRuns', (client) => client.listRuns({ branch: 'main', status: 'completed' })],
  ['readFailedRunLog', (client) => client.readFailedRunLog({ run: 1234, job: 99 })],
  ['updateBranch', (client) => client.updateBranch({ pullRequest: 7, rebase: true })],
  ['addComment', (client) => client.addComment({ pullRequest: 7, body: 'hello' })],
  ['issueStates', (client) => client.issueStates({ numbers: [127, 164] })],
  ['listMilestones', (client) => client.listMilestones()],
  ['listIssues', (client) => client.listIssues({ milestone: '4' })],
  ['listOpenPullRequests', (client) => client.listOpenPullRequests()],
  ['listOpenPullRequestHeads', (client) => client.listOpenPullRequestHeads()],
  ['listOpenPullRequestLinks', (client) => client.listOpenPullRequestLinks()],
  ['requiredContexts', (client) => client.requiredContexts({ branch: 'main' })],
  ['requiredReviews', (client) => client.requiredReviews({ branch: 'main' })],
  ['viewPullRequestDetail', (client) => client.viewPullRequestDetail({ pullRequest: 178 })],
  ['listWorkflowRuns', (client) => client.listWorkflowRuns({ branch: 'main', perPage: 10 })],
  ['compareCommits', (client) => client.compareCommits({ base: 'dda20bc', head: 'a51ef71' })],
  ['branchRef', (client) => client.branchRef({ branch: 'dependabot/npm/dep-1' })],
  ['listRunJobs', (client) => client.listRunJobs({ run: '39508680057' })],
  ['commitDate', (client) => client.commitDate({ sha: 'eb0ee17' })],
  [
    'listPullRequestStatuses',
    (client) => client.listPullRequestStatuses({ pullRequest: 178, prefix: 'workstreams/' }),
  ],
  [
    'createCommitStatus',
    (client) =>
      client.createCommitStatus({
        sha: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe',
        context: 'workstreams/review-1',
        state: 'success',
        description: 'minor',
      }),
  ],
  ['repositoryStatus', (client) => client.repositoryStatus(['acme/widgets'], { boundMs: 1_000 })],
]

it('answers with the reply registered for the endpoint', async () => {
  const rows = [{ headRefName: 'feature-a' }]
  const client = createGhMock({ listPullRequests: rows })

  await expect(client.listPullRequests({ state: 'merged' })).resolves.toEqual(rows)
})

it('answers with the same reply on every call', async () => {
  // A reply consumed by the first call would make a command that asks
  // twice pass or fail on how many times it asked. ADR 001 rules out that
  // coupling.
  const client = createGhMock({ viewRepository: { nameWithOwner: 'acme/widgets' } })

  await expect(client.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
  await expect(client.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
})

it('answers every endpoint it declares', async () => {
  const client = createGhMock({
    listPullRequests: [{ number: 1 }],
    listMergedPullRequests: [{ headRefName: 'feature-a' }],
    viewPullRequest: { number: 7, state: 'OPEN' },
    viewRepository: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'acme/widgets' },
    listRuns: [{ databaseId: 10 }],
    readFailedRunLog: 'FAIL tests/thing\n',
    updateBranch: 'Updated branch\n',
    addComment: 'https://github.com/acme/widgets/pull/7#issuecomment-1\n',
    issueStates: { states: { '127': 'OPEN', '164': 'not_found' }, unavailable: null },
    listMilestones: {
      rows: [{ number: 4, title: 'workstreams primitives', openIssues: 13, closedIssues: 1 }],
      unavailable: null,
    },
    listIssues: {
      rows: [
        {
          number: 130,
          title: 'feat(workstreams): sweep (primitive 1)',
          milestone: { number: 4, title: 'workstreams primitives' },
          labels: ['enhancement'],
          blockedBy: [{ number: 127, state: 'CLOSED' }],
          blocking: [{ number: 131, state: 'OPEN' }],
          pullRequests: [],
        },
      ],
      unavailable: null,
    },
    listOpenPullRequests: {
      rows: [
        { number: 177, title: 'audit L2', head: 'wktr-171-audit-split', base: 'main', draft: true },
      ],
      unavailable: null,
    },
    listOpenPullRequestHeads: {
      rows: [
        {
          number: 177,
          title: 'audit L2',
          head: 'wktr-171-audit-split',
          headSha: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe',
          base: 'main',
          draft: true,
          crossRepository: false,
          checks: [{ name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null }],
        },
      ],
      unavailable: null,
    },
    listOpenPullRequestLinks: {
      rows: [{ number: 177, head: 'wktr-171-audit-split', base: 'main', crossRepository: false }],
      unavailable: null,
    },
    requiredContexts: { contexts: ['vitest', 'types'], unavailable: null },
    requiredReviews: {
      reviews: { approvals: 1, codeOwner: false, threadResolution: true, lastPush: false },
      unavailable: null,
    },
    viewPullRequestDetail: {
      pullRequest: {
        number: 178,
        title: 'feat(workstreams): sweep command and skill (primitive 1)',
        state: 'OPEN',
        draft: true,
        base: 'main',
        head: 'wktr-130-ws-sweep',
        headSha: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe',
        mergeable: 'MERGEABLE',
        checks: [{ name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null }],
        unresolvedThreads: [],
        commentAuthors: ['github-code-quality'],
      },
      unavailable: null,
      missing: false,
    },
    listWorkflowRuns: {
      rows: [
        {
          id: 1000,
          workflowId: 10,
          createdAt: '2026-09-22T06:31:10Z',
          name: 'CI',
          event: 'pull_request',
          headSha: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-09-22T06:31:17Z',
          updatedAt: '2026-09-22T06:33:14Z',
        },
      ],
      unavailable: null,
    },
    compareCommits: {
      comparison: { status: 'ahead', files: ['lib/gh.ts'], filesAtLimit: false },
      unavailable: null,
    },
    branchRef: { sha: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe', unavailable: null },
    listRunJobs: {
      rows: [{ id: 1, startedAt: '2026-10-20T22:31:04Z', completedAt: null, steps: [] }],
      unavailable: null,
    },
    commitDate: { date: '2026-10-20T22:47:46Z', unavailable: null },
    listPullRequestStatuses: {
      rows: [
        {
          commit: '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe',
          context: 'workstreams/review-1',
          state: 'success',
          description: 'minor',
          createdAt: '2026-10-13T10:00:00Z',
        },
      ],
      unavailable: null,
    },
    createCommitStatus: { id: 1, context: 'workstreams/review-1', state: 'success' },
    repositoryStatus: {
      repositories: {
        'acme/widgets': { alerts: 1, dependencies: 2, mergedPullRequests: [] },
      },
      unavailable: null,
    },
  })

  for (const [endpoint, call] of CALLS) {
    await expect(call(client), endpoint).resolves.toBeDefined()
  }
})

it('fails only the endpoint the fail switch was registered for', async () => {
  const client = createGhMock({
    listPullRequests: ghFails('gh: could not resolve to a Repository'),
    viewRepository: { nameWithOwner: 'acme/widgets' },
  })

  await expect(client.listPullRequests()).rejects.toThrow('gh: could not resolve to a Repository')
  await expect(client.viewRepository()).resolves.toEqual({ nameWithOwner: 'acme/widgets' })
})

it('fails with the error type the real client throws, carrying the status it was given', async () => {
  // Round 5's handoff fact 3: failure from `lib/gh.ts` is a `GhError` that
  // carries gh's own exit status. So a command branches on a value, not on
  // prose. A double that threw a plain `Error` would leave that branch
  // unreachable from every command's own suite, while the command looked
  // covered.
  const client = createGhMock({
    listPullRequests: ghFails('gh: HTTP 403', 4),
    viewRepository: ghFails('gh: could not resolve to a Repository'),
  })

  const listed = await client.listPullRequests().catch((thrown: unknown) => thrown)
  expect(listed).toBeInstanceOf(GhError)
  expect((listed as GhError).status).toBe(4)
  expect((listed as GhError).message).toBe('gh: HTTP 403')
  // `detail` holds the real client's "gh's own account, without the
  // `gh <argv> failed: ` prefix". A command reads it for a one-line reason.
  // The double has no argv, so the message it was given IS that account. A
  // `detail` left empty here would make a command that reads it print
  // nothing, for a reason the real client never produces.
  expect((listed as GhError).detail).toBe('gh: HTTP 403')

  // 1 by default: gh's own generic non-zero status. A test that does not
  // care about the number need not name one.
  const viewed = await client.viewRepository().catch((thrown: unknown) => thrown)
  expect((viewed as GhError).status).toBe(1)
})

it('throws and names the endpoint when nothing is registered for it', async () => {
  // This is the property a stub binary cannot give. If a command reaches
  // for gh where the test expected no call, the command fails. It does not
  // read an empty reply as an answer.
  const client = createGhMock()

  for (const [endpoint, call] of CALLS) {
    await expect(call(client), endpoint).rejects.toThrow(
      `gh mock: no reply registered for ${endpoint}`,
    )
  }
})
