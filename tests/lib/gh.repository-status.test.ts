// `repositoryStatus`: the GitHub half of the gh plugin's status line. The
// client takes the process runner as a parameter, so a stand-in answers for
// `gh api graphql`, and nothing here reaches GitHub. The query itself was
// checked once against the real API (#230): the argv test below pins that
// text.
import { expect, it } from 'vitest'

import { createGhClient } from '#lib/gh.ts'
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

/** The query text a call carries, from its `-f query=...` argument. */
const queryOf = (args: readonly string[] | undefined): string =>
  (args ?? []).find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? ''

/** The repositories a query names, in alias order. */
const reposOf = (query: string): string[] =>
  [...query.matchAll(/repository\(owner: "([^"]*)", name: "([^"]*)"\)/g)].map(
    (match) => `${match[1]}/${match[2]}`,
  )

/** One repository node, as GitHub answers it. */
const node = (alerts: number, dependencies: number, merged: unknown[] = []) => ({
  vulnerabilityAlerts: { totalCount: alerts },
  dependencies: { totalCount: dependencies },
  merged: { nodes: merged },
})

/** A runner that answers every query with a node per repository it names,
 *  numbered by the repository's place in `all`. */
const serverFor =
  (all: readonly string[]): Runner =>
  async (_command, args) => {
    const data: Record<string, unknown> = {}
    reposOf(queryOf(args)).forEach((repo, index) => {
      data[`r${index}`] = node(all.indexOf(repo), 0)
    })
    return result({ stdout: JSON.stringify({ data }) })
  }

it('asks gh one aliased query, bounded by the time it was given', async () => {
  const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = []
  const gh = createGhClient({
    run: async (_command, args = [], options) => {
      calls.push({ args, timeoutMs: options?.timeoutMs })
      return result({ stdout: JSON.stringify({ data: { r0: node(0, 0) } }) })
    },
  })

  await gh.repositoryStatus(['acme/widgets'], { boundMs: 4_000 })

  expect(calls).toEqual([
    {
      args: [
        'api',
        'graphql',
        '-f',
        `query=query {
  r0: repository(owner: "acme", name: "widgets") {
    vulnerabilityAlerts(states: OPEN) { totalCount }
    dependencies: pullRequests(states: OPEN, labels: ["dependencies"]) { totalCount }
    merged: pullRequests(states: MERGED, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { headRefName headRefOid isCrossRepository }
    }
  }
}`,
      ],
      timeoutMs: 4_000,
    },
  ])
})

it('answers each repository with its two counts and its merged pull requests', async () => {
  const head = { headRefName: 'feature', headRefOid: 'abc123', isCrossRepository: false }
  const gh = createGhClient({
    run: async () =>
      result({ stdout: JSON.stringify({ data: { r0: node(2, 3, [head]), r1: node(0, 1) } }) }),
  })

  const answer = await gh.repositoryStatus(['acme/widgets', 'acme/gadgets'], { boundMs: 1_000 })

  expect(answer).toEqual({
    repositories: {
      'acme/widgets': { alerts: 2, dependencies: 3, mergedPullRequests: [head] },
      'acme/gadgets': { alerts: 0, dependencies: 1, mergedPullRequests: [] },
    },
    unavailable: null,
  })
})

it('drops only the field a partial answer could not give, and says why', async () => {
  // A token that cannot read Dependabot alerts gets `null` there, an entry
  // in `errors`, and exit 1 from gh. The other fields are still answers.
  const gh = createGhClient({
    run: async () =>
      result({
        status: 1,
        stderr: 'gh: Resource not accessible by integration\n',
        stdout: JSON.stringify({
          data: { r0: { ...node(0, 4), vulnerabilityAlerts: null } },
          errors: [
            {
              type: 'FORBIDDEN',
              path: ['r0', 'vulnerabilityAlerts'],
              message: 'Resource not accessible by integration',
            },
          ],
        }),
      }),
  })

  const answer = await gh.repositoryStatus(['acme/widgets'], { boundMs: 1_000 })

  expect(answer).toEqual({
    repositories: { 'acme/widgets': { alerts: null, dependencies: 4, mergedPullRequests: [] } },
    unavailable: 'Resource not accessible by integration',
  })
})

it('leaves out a repository GitHub could not resolve, and keeps the others', async () => {
  const gh = createGhClient({
    run: async () =>
      result({
        status: 1,
        stdout: JSON.stringify({
          data: { r0: null, r1: node(1, 0) },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['r0'],
              message: "Could not resolve to a Repository with the name 'acme/gone'.",
            },
          ],
        }),
      }),
  })

  const answer = await gh.repositoryStatus(['acme/gone', 'acme/widgets'], { boundMs: 1_000 })

  expect(answer).toEqual({
    repositories: { 'acme/widgets': { alerts: 1, dependencies: 0, mergedPullRequests: [] } },
    unavailable: "Could not resolve to a Repository with the name 'acme/gone'.",
  })
})

it('reads a field that is not the shape it asked for as unreadable', async () => {
  const gh = createGhClient({
    run: async () =>
      result({
        stdout: JSON.stringify({
          data: {
            r0: {
              vulnerabilityAlerts: { totalCount: '2' },
              dependencies: {},
              merged: { nodes: [{ headRefName: 'feature', headRefOid: 7 }] },
            },
            r1: { ...node(0, 0), merged: { nodes: 'none' } },
            r2: 'not a node',
            r3: { ...node(0, 0), merged: { nodes: [null] } },
            r4: { ...node(0, 0), merged: { nodes: [{ headRefName: 'x', headRefOid: 'y' }] } },
          },
        }),
      }),
  })

  const answer = await gh.repositoryStatus(['acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e'], {
    boundMs: 1_000,
  })

  // One malformed pull request makes the whole list unreadable. A list that
  // is one row short could hide the row that proves a squash merge.
  expect(answer).toEqual({
    repositories: {
      'acme/a': { alerts: null, dependencies: null, mergedPullRequests: null },
      'acme/b': { alerts: 0, dependencies: 0, mergedPullRequests: null },
      'acme/d': { alerts: 0, dependencies: 0, mergedPullRequests: null },
      'acme/e': { alerts: 0, dependencies: 0, mergedPullRequests: null },
    },
    unavailable: null,
  })
})

it('reports a call that gave no body it could read, and answers for no repository', async () => {
  const cases: Array<[Partial<RunResult>, string]> = [
    [{ status: 1, stderr: 'gh: API rate limit exceeded\n' }, 'gh: API rate limit exceeded'],
    [
      { status: 127, startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' } },
      'cannot run gh: spawn gh ENOENT',
    ],
    [{ stdout: '{"data":' }, 'gh exited 0'],
    [{ stdout: '{"errors":[]}' }, 'gh exited 0'],
    [{ status: null, signal: 'SIGKILL', timedOut: true }, 'gh did not answer in 250 ms'],
    [
      {
        stdout: JSON.stringify({ data: { r0: node(1, 1) } }),
        streamErrors: [{ code: 'EIO', message: 'read EIO' }],
      },
      "gh's output could not be read: EIO, read EIO",
    ],
  ]

  for (const [reply, reason] of cases) {
    const gh = createGhClient({ run: async () => result(reply) })
    const answer = await gh.repositoryStatus(['acme/widgets'], { boundMs: 250 })
    expect(answer).toEqual({ repositories: {}, unavailable: reason })
  }
})

it('asks about five repositories at most in one query, and answers for all of them', async () => {
  const all = ['o/r0', 'o/r1', 'o/r2', 'o/r3', 'o/r4', 'o/r5']
  const server = serverFor(all)
  // The stand-in refuses a query that names more than five repositories. So
  // a sixth repository gets an answer only in a query of its own.
  const gh = createGhClient({
    run: async (command, args, options) =>
      reposOf(queryOf(args)).length > 5
        ? result({ status: 1, stderr: 'too many repositories in one query' })
        : server(command, args, options),
  })

  const answer = await gh.repositoryStatus(all, { boundMs: 1_000 })

  expect(answer.unavailable).toBeNull()
  expect(Object.keys(answer.repositories).sort()).toEqual(all)
  // Each repository gets its own node back, not the node at the same alias
  // in another batch.
  expect(answer.repositories['o/r5']?.alerts).toBe(5)
  expect(answer.repositories['o/r0']?.alerts).toBe(0)
})

it('sends the batches at the same time, not one after another', async () => {
  const all = ['o/r0', 'o/r1', 'o/r2', 'o/r3', 'o/r4', 'o/r5']
  const server = serverFor(all)
  // Each query waits until the other one has started. Batches sent one after
  // another would each wait out the fallback and answer with a failure.
  let started = 0
  let release: () => void = () => {}
  const both = new Promise<void>((resolve) => {
    release = resolve
  })
  const gh = createGhClient({
    run: async (command, args, options) => {
      started += 1
      if (started === 2) release()
      const waited = await Promise.race([
        both.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])
      return waited
        ? server(command, args, options)
        : result({ status: 1, stderr: 'the other batch never started' })
    },
  })

  const answer = await gh.repositoryStatus(all, { boundMs: 5_000 })

  expect(answer.unavailable).toBeNull()
  expect(Object.keys(answer.repositories)).toHaveLength(6)
})

it('asks nothing for no repositories', async () => {
  const gh = createGhClient({
    run: async () => {
      throw new Error('gh must not run for an empty list')
    },
  })

  await expect(gh.repositoryStatus([], { boundMs: 1_000 })).resolves.toEqual({
    repositories: {},
    unavailable: null,
  })
})
