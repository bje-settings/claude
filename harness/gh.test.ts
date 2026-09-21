// The mock's own claims. The suite's other tests read a registered reply back
// through a command, so a mock that quietly answered undefined, or that
// answered every endpoint from the first registration, would make them pass
// for the wrong reason.
import { expect, it } from 'vitest'
import { createGhMock, type GhClient, type GhEndpoint, ghFails } from './gh.ts'

// One call per endpoint, written out rather than derived: a table built from
// the interface would go on passing after an endpoint was renamed, and these
// are the argument shapes the plugins actually pass.
const CALLS: Array<[GhEndpoint, (client: GhClient) => Promise<unknown>]> = [
  [
    'listPullRequests',
    (client) => client.listPullRequests({ state: 'open', label: 'dependencies' }),
  ],
  ['listMergedPullRequests', (client) => client.listMergedPullRequests({ base: 'main' })],
  ['viewPullRequest', (client) => client.viewPullRequest({ pullRequest: 7 })],
  ['viewRepository', (client) => client.viewRepository()],
  ['listRuns', (client) => client.listRuns({ branch: 'main', status: 'completed' })],
  ['readFailedRunLog', (client) => client.readFailedRunLog({ run: 1234, job: 99 })],
  ['updateBranch', (client) => client.updateBranch({ pullRequest: 7, rebase: true })],
  ['addComment', (client) => client.addComment({ pullRequest: 7, body: 'hello' })],
  ['watchChecks', (client) => client.watchChecks({ pullRequest: 7, interval: 30, boundMs: 1_000 })],
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
