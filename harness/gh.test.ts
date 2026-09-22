// The mock's own claims. The suite's other tests read a registered reply back
// through a command, so a mock that quietly answered undefined, or that
// answered every endpoint from the first registration, would make them pass
// for the wrong reason.
import { expect, it } from 'vitest'
import { createGhMock, type GhClient, type GhEndpoint, GhError, ghFails } from './gh.ts'

// One call per endpoint, written out rather than derived: a table built from
// the interface would go on passing after an endpoint was renamed, and these
// are the argument shapes the plugins actually pass.
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
  ['watchChecks', (client) => client.watchChecks({ pullRequest: 7, interval: 30, boundMs: 1_000 })],
  ['issueStates', (client) => client.issueStates({ numbers: [127, 164] })],
]

it('answers with the reply registered for the endpoint', async () => {
  const rows = [{ headRefName: 'feature-a' }]
  const client = createGhMock({ listPullRequests: rows })

  await expect(client.listPullRequests({ state: 'merged' })).resolves.toEqual(rows)
})

it('answers with the same reply on every call', async () => {
  // A reply consumed by the first call would make a command that asks twice
  // pass or fail on how many times it asked, which is the coupling ADR 001
  // rules out.
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
    watchChecks: { status: 0, timedOut: false, waitedMs: 12, problem: '' },
    issueStates: { states: { '127': 'OPEN', '164': 'not_found' }, unavailable: null },
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
  // Round 5's handoff fact 3: failure from `lib/gh.ts` is a `GhError` carrying
  // gh's own exit status, so a command branches on a value rather than on
  // prose. A double that threw a plain `Error` would leave that branch
  // unreachable from every command's own suite while the command looked
  // covered.
  const client = createGhMock({
    listPullRequests: ghFails('gh: HTTP 403', 4),
    viewRepository: ghFails('gh: could not resolve to a Repository'),
  })

  const listed = await client.listPullRequests().catch((thrown: unknown) => thrown)
  expect(listed).toBeInstanceOf(GhError)
  expect((listed as GhError).status).toBe(4)
  expect((listed as GhError).message).toBe('gh: HTTP 403')
  // `detail` is the real client's "gh's own account, without the
  // `gh <argv> failed: ` prefix", and it is what a command reads for a
  // one-line reason. The double has no argv, so the message it was given IS
  // that account: a `detail` left empty here would make a command that reads
  // it print nothing, for a reason the real client never produces.
  expect((listed as GhError).detail).toBe('gh: HTTP 403')

  // 1 by default: gh's own generic non-zero, so a test that does not care
  // about the number does not have to name one.
  const viewed = await client.viewRepository().catch((thrown: unknown) => thrown)
  expect((viewed as GhError).status).toBe(1)
})

it('throws and names the endpoint when nothing is registered for it', async () => {
  // The property a stub binary cannot give: a command that reaches for gh
  // where the test expected no call fails, instead of reading an empty reply
  // as an answer.
  const client = createGhMock()

  for (const [endpoint, call] of CALLS) {
    await expect(call(client), endpoint).rejects.toThrow(
      `gh mock: no reply registered for ${endpoint}`,
    )
  }
})
