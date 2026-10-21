// `shepherd.ts shepherd-stack` (#469): the steps of `/shepherd:merge` for one GitHub
// stack. Each layer is a `shepherd-pr` step, judged by the rules of the
// stack base (ruling 4 on #469).
//
// `gh` here is a small stack that GitHub would hold: each layer has a head,
// and the tip of its base that the head holds. An update in MERGE mode moves
// the head and makes it hold its base. An update with `--rebase` fails, so a
// command that asked for one cannot report success (ruling 3 on #469). The
// rows are the shape of the real stack of #470 and #471 on 2026-10-20.
//
// **No test waits.** `fakeTime` moves the clock by each sleep.
import { mkdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { type GhClient, type GhResults, ghFails, type PullRequestDetail } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { captureOutput } from '#harness/output.ts'
import { createGhServer, type PullRequestRow } from '#harness/pulls.ts'
import { createSandbox } from '#harness/sandbox.ts'
import type { ShepherdContext } from '#shepherd/shepherd.ts'
import { HELP, runShepherdStack } from '#shepherd/subcommands/shepherd-stack.ts'
import { fakeTime, HEAD_DATE, NO_JOBS } from './shepherd-pr.test-support.ts'

const REPOSITORY = { nameWithOwner: 'bje-settings/claude', defaultBranchRef: { name: 'main' } }

const NO_RULE: GhResults['requiredReviews'] = {
  reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
  unavailable: null,
}

const ONE_APPROVAL: GhResults['requiredReviews'] = {
  reviews: { approvals: 1, codeOwner: false, threadResolution: false, lastPush: false },
  unavailable: null,
}

const THREADS: GhResults['requiredReviews'] = {
  reviews: { approvals: 0, codeOwner: false, threadResolution: true, lastPush: false },
  unavailable: null,
}

/** A check run of `name` in `conclusion`, or still running. */
const run = (name: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  startedAt: '2026-10-20T22:29:00Z',
  completedAt: conclusion === null ? '0001-01-01T00:00:00Z' : '2026-10-20T22:29:30Z',
  detailsUrl: 'https://ci.example/vitest',
})

const GREEN = [run('vitest', 'SUCCESS')]

/** One open layer of stack 472, with its head. 470 is the bottom. */
const row = (number: number, head: string, overrides: PullRequestRow = {}): PullRequestRow => ({
  number,
  title: `layer ${number}`,
  author: { login: 'brianespinosa' },
  isDraft: false,
  labels: [],
  autoMergeRequest: null,
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  headRefOid: head,
  headRefName: `wktr-${number}`,
  baseRefName: number === 470 ? 'main' : `wktr-${number - 1}`,
  isCrossRepository: false,
  statusCheckRollup: GREEN,
  createdAt: '2026-10-20T20:00:00Z',
  updatedAt: '2026-10-20T22:00:00Z',
  reviewDecision: '',
  reviews: [],
  mergeCommit: null,
  ...overrides,
})

interface Layer {
  readonly number: number
  /** The head of the layer. */
  head: string
  /** The tip of its base that the head holds. */
  holds: string
  overrides: PullRequestRow
}

interface StackWorld {
  /** The tip of `main`. */
  main: string
  readonly layers: Layer[]
  readonly closed?: readonly number[]
  readonly merged?: readonly number[]
}

/** A stack whose layers each hold their base, with green checks. */
const world = (): StackWorld => ({
  main: 'm1',
  layers: [
    { number: 470, head: 'a1', holds: 'm1', overrides: {} },
    { number: 471, head: 'b1', holds: 'a1', overrides: {} },
  ],
})

/** The tip of the base of `layer`. */
const baseTip = (state: StackWorld, layer: Layer): string => {
  const index = state.layers.indexOf(layer)
  return index === 0 ? state.main : (state.layers[index - 1] as Layer).head
}

interface Serve {
  readonly rules?: (branch: string) => GhResults['requiredReviews']
  readonly contexts?: GhResults['requiredContexts']
  readonly methods?: GhResults['mergeMethods']
  readonly merge?: (
    state: StackWorld,
    query: Parameters<GhClient['mergeStack']>[0],
  ) => GhResults['mergeStack']
  readonly more?: Partial<GhClient>
}

/** `gh`, over `state`. */
const serve = (state: StackWorld, options: Serve = {}): GhClient => {
  const find = (number: number): Layer | undefined =>
    state.layers.find((layer) => layer.number === number)
  const rowOf = (layer: Layer): PullRequestRow => row(layer.number, layer.head, layer.overrides)
  const server = createGhServer({
    replies: {
      viewRepository: REPOSITORY,
      listRunJobs: NO_JOBS,
      commitDate: HEAD_DATE,
      requiredContexts: options.contexts ?? { contexts: ['vitest'], unavailable: null },
      ...(options.methods === undefined ? {} : { mergeMethods: options.methods }),
    },
  })
  return {
    ...server,
    listOpenStacks: async () => ({
      rows: [
        {
          number: 472,
          base: 'main',
          layers: [
            ...(state.merged ?? []).map((number) => ({ number, state: 'MERGED' as const })),
            ...state.layers.map((layer) => ({
              number: layer.number,
              state: String(layer.overrides.state ?? 'OPEN') as 'OPEN' | 'MERGED',
            })),
            ...(state.closed ?? []).map((number) => ({ number, state: 'CLOSED' as const })),
          ],
        },
      ],
      unavailable: null,
    }),
    viewPullRequest: async ({ pullRequest }) => {
      const layer = find(pullRequest)
      if (layer === undefined) throw ghFails(`no pull request #${pullRequest}`)
      return rowOf(layer)
    },
    compareCommits: async ({ head }) => {
      const layer = state.layers.find((each) => each.head === head) as Layer
      const behind = layer.holds !== baseTip(state, layer)
      return {
        comparison: { status: behind ? 'behind' : 'ahead', files: [], filesAtLimit: false },
        unavailable: null,
      }
    },
    branchRef: async ({ branch }) => {
      const layer = state.layers.find((each) => `wktr-${each.number}` === branch) as Layer
      return { sha: layer.head, unavailable: null }
    },
    requiredReviews: async ({ branch }) => (options.rules ?? (() => NO_RULE))(branch),
    updateBranch: async ({ pullRequest, rebase }) => {
      // A rebase rewrites the head and needs a force push. The stack path
      // never asks for one (ruling 3 on #469).
      if (rebase) throw ghFails('a --rebase update is refused here')
      const layer = find(pullRequest) as Layer
      layer.holds = baseTip(state, layer)
      layer.head = `${layer.head}+`
      return '✓ PR branch updated\n'
    },
    mergeStack: async (query) => {
      if (options.merge === undefined) throw new Error('mergeStack must not run here')
      return options.merge(state, query)
    },
    ...options.more,
  }
}

/** One run of the command in a real checkout. */
const stack = async (
  gh: GhClient,
  action: string,
  env: Record<string, string> = {},
  extra: readonly string[] = [],
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
  const code = await runShepherdStack([repo, '472', action, ...extra], context)
  const stdout = output.stdout()
  return {
    code,
    stderr: output.stderr(),
    stdout,
    document: stdout.startsWith('{') ? JSON.parse(stdout) : null,
    repo,
  }
}

// --- state -------------------------------------------------------------------

it('state reads each open layer, and a ready stack is ready', async () => {
  const ran = await stack(serve({ ...world(), merged: [469] }), 'state')

  expect(ran.code).toBe(0)
  expect(ran.document).toMatchObject({
    action: 'state',
    repo: 'bje-settings/claude',
    stack: 472,
    ok: true,
    detail: 'read',
    base: 'main',
    failing: [],
    ready: true,
  })
  expect(
    ran.document.layers.map((layer: { number: number; pr: { behind: boolean } }) => [
      layer.number,
      layer.pr.behind,
    ]),
  ).toEqual([
    [470, false],
    [471, false],
  ])
})

it('state judges every layer by the rules of the stack base, and names each closed entry', async () => {
  const state = { ...world(), closed: [473] }
  ;(state.layers[1] as Layer).overrides = {
    isDraft: true,
    statusCheckRollup: [run('vitest', 'FAILURE')],
  }
  // `main` asks for an approval. The own base of #471 asks for none.
  const rules = (branch: string) => (branch === 'main' ? ONE_APPROVAL : NO_RULE)

  const ran = await stack(serve(state, { rules }), 'state')

  expect(ran.document.failing).toEqual([
    { number: 470, reasons: ['needs an approval'] },
    {
      number: 471,
      reasons: ['is a draft', 'needs an approval', 'required check vitest failed'],
    },
    { number: 473, reasons: ['is closed'] },
  ])
  expect(ran.document.ready).toBe(false)
})

it('state reads the threads of each layer when the stack base asks for them', async () => {
  const gh = serve(world(), {
    rules: () => THREADS,
    more: {
      viewPullRequestDetail: async ({ pullRequest }) => ({
        pullRequest: {
          unresolvedThreads: pullRequest === 471 ? [{ path: 'a.ts' }] : [],
        } as unknown as PullRequestDetail,
        unavailable: null,
        missing: false,
      }),
    },
  })

  const ran = await stack(gh, 'state')

  expect(ran.document.failing).toEqual([
    { number: 471, reasons: ['has unresolved review threads'] },
  ])
})

it('state refuses, with the layer, when a layer cannot be read', async () => {
  const gh = serve(world(), {
    more: { viewPullRequest: async () => Promise.reject(ghFails('gh: HTTP 502')) },
  })

  const ran = await stack(gh, 'state')

  expect(ran.document).toMatchObject({
    ok: false,
    detail: 'could not read #470: gh: HTTP 502',
    base: 'main',
    layer: 470,
  })
})

it('names a stack with no open pull request, and a stack read that came back short', async () => {
  const none = serve(world(), {
    more: { listOpenStacks: async () => ({ rows: [], unavailable: null }) },
  })
  const short = serve(world(), {
    more: { listOpenStacks: async () => ({ rows: [], unavailable: 'gh: HTTP 502' }) },
  })

  const unread = await stack(short, 'merge')

  for (const action of ['state', 'update', 'wait', 'merge']) {
    const gone = await stack(none, action)
    expect(gone.document).toMatchObject({
      action,
      ok: false,
      detail: 'no open pull request is in stack #472',
    })
  }
  expect(unread.document).toMatchObject({
    ok: false,
    detail: 'could not read stack #472: gh: HTTP 502',
    read_error: 'gh: HTTP 502',
  })
})

// --- update ------------------------------------------------------------------

it('update merges the base into each layer that is behind, bottom up, and never with --rebase', async () => {
  const state = world()
  state.main = 'm2'

  const updated = await stack(serve(state), 'update')
  const after = await stack(serve(state), 'state')

  expect(updated.document).toMatchObject({ ok: true, result: 'updated' })
  expect(
    updated.document.updates.map(
      (update: { number: number; report: { result: string; after: string } }) => [
        update.number,
        update.report.result,
        update.report.after,
      ],
    ),
  ).toEqual([
    [470, 'moved', 'a1+'],
    [471, 'moved', 'b1+'],
  ])
  expect(updated.document.updates[0].report.detail).toBe('updated')
  expect(
    after.document.layers.map((layer: { pr: { behind: boolean } }) => layer.pr.behind),
  ).toEqual([false, false])
})

it('update leaves a layer that holds its base, and says when no layer is behind', async () => {
  const state = world()
  ;(state.layers[1] as Layer).holds = 'a0'

  const partial = await stack(serve(state), 'update')
  const none = await stack(serve(state), 'update')

  expect(
    partial.document.updates.map((update: { result?: string }) => update.result ?? 'report'),
  ).toEqual(['current', 'report'])
  expect(none.document).toMatchObject({ ok: true, detail: 'no layer is behind', result: 'current' })
})

it('update stops at a layer whose head does not move, with its report', async () => {
  const state = world()
  state.main = 'm2'
  const gh = serve(state, { more: { updateBranch: async () => 'already up to date\n' } })

  const ran = await stack(gh, 'update')

  expect(ran.document).toMatchObject({
    ok: true,
    result: 'stopped',
    layer: 470,
    report: { result: 'up_to_date' },
  })
})

it('update refuses, with gh’s words, when GitHub refuses the branch update', async () => {
  const state = world()
  state.main = 'm2'
  const gh = serve(state, {
    more: {
      updateBranch: async () => Promise.reject(ghFails('gh: merge conflict between base and head')),
    },
  })

  const ran = await stack(gh, 'update')

  expect(ran.document).toMatchObject({
    ok: false,
    detail: '#470: update failed: gh: merge conflict between base and head',
    layer: 470,
  })
})

it('update gives no verdict on a compare it cannot read, nor on a layer it cannot read', async () => {
  const blind = serve(world(), {
    more: { compareCommits: async () => ({ comparison: null, unavailable: 'gh: HTTP 502' }) },
  })
  const unread = serve(world(), {
    more: { viewPullRequest: async () => Promise.reject(ghFails('gh: HTTP 502')) },
  })

  const compare = await stack(blind, 'update')
  const layer = await stack(unread, 'update')

  expect(compare.document).toMatchObject({
    ok: false,
    detail: 'the compare of #470 could not be read; nothing was updated past it',
  })
  expect(compare.stderr).toContain('behind is null')
  expect(layer.document).toMatchObject({ ok: false, detail: 'could not read #470: gh: HTTP 502' })
})

// --- wait --------------------------------------------------------------------

it('wait passes when every layer passed', async () => {
  const ran = await stack(serve(world()), 'wait')

  expect(ran.document).toMatchObject({
    ok: true,
    result: 'passed',
    bound: 540,
    waited: 0,
    layers: [470, 471],
  })
})

it('wait reports the first layer that did not pass, with its report', async () => {
  const failed = world()
  ;(failed.layers[1] as Layer).overrides = { statusCheckRollup: [run('vitest', 'FAILURE')] }
  const behind = world()
  ;(behind.layers[1] as Layer).holds = 'a0'

  const red = await stack(serve(failed), 'wait')
  const back = await stack(serve(behind), 'wait')

  expect(red.document).toMatchObject({
    ok: true,
    result: 'failed',
    layer: 471,
    report: { result: 'failed', number: 471 },
  })
  expect(back.document).toMatchObject({ ok: true, result: 'behind', layer: 471 })
})

it('wait shares one bound across the layers', async () => {
  const state = world()
  for (const layer of state.layers) layer.overrides = { statusCheckRollup: [run('vitest', null)] }

  const ran = await stack(serve(state), 'wait', {
    SHEPHERD_WAIT_BOUND: '60',
    SHEPHERD_WAIT_POLL: '30',
  })

  // The bottom layer spends the whole bound, so the stack reports it.
  expect(ran.document).toMatchObject({
    ok: true,
    result: 'pending',
    layer: 470,
    bound: 60,
    waited: 60,
    report: { result: 'pending', bound: 60, waited: 60 },
  })
})

it('wait gives each layer what is left of the one bound', async () => {
  const state = world()
  const gh = serve(state, {
    more: {
      // The bottom read takes the whole bound of the stack.
      viewPullRequest: async ({ pullRequest }) => {
        const layer = state.layers.find((each) => each.number === pullRequest) as Layer
        return row(
          layer.number,
          layer.head,
          pullRequest === 471 ? { statusCheckRollup: [run('vitest', null)] } : {},
        )
      },
    },
  })

  const ran = await stack(gh, 'wait', { SHEPHERD_WAIT_BOUND: '1', SHEPHERD_WAIT_POLL: '30' })

  expect(ran.document).toMatchObject({ result: 'pending', layer: 471, report: { bound: 1 } })
})

/** `gh` over a stack whose bottom goes green on read `greenAt` of it, and
 *  whose top stays pending. */
const slowBottom = (greenAt: number): GhClient => {
  const state = world()
  let reads = 0
  return serve(state, {
    more: {
      viewPullRequest: async ({ pullRequest }) => {
        const layer = state.layers.find((each) => each.number === pullRequest) as Layer
        if (pullRequest === 470) reads += 1
        const green = pullRequest === 470 && reads >= greenAt
        return row(layer.number, layer.head, {
          statusCheckRollup: green ? GREEN : [run('vitest', null)],
        })
      },
    },
  })
}

it('wait gives the next layer only what the layers below it left of the bound', async () => {
  const env = { SHEPHERD_WAIT_BOUND: '60', SHEPHERD_WAIT_POLL: '30' }
  // The bottom passes after 30 s, so the top gets the other 30 s.
  const half = await stack(slowBottom(2), 'wait', env)
  // The bottom passes at the bound, so the top still gets 1 s.
  const late = await stack(slowBottom(3), 'wait', env)

  expect(half.document).toMatchObject({
    result: 'pending',
    layer: 471,
    bound: 60,
    waited: 60,
    report: { bound: 30, waited: 30 },
  })
  expect(late.document).toMatchObject({
    result: 'pending',
    layer: 471,
    bound: 60,
    report: { bound: 1, waited: 1 },
  })
})

it('wait reports a layer that merged, or stalled, while the layers below it passed', async () => {
  const state = world()
  const merged = serve(state, {
    more: {
      viewPullRequest: async ({ pullRequest }) => {
        const layer = state.layers.find((each) => each.number === pullRequest) as Layer
        return row(layer.number, layer.head, pullRequest === 471 ? { state: 'MERGED' } : {})
      },
    },
  })
  const stuck = world()
  // The check of the top layer started long ago, and nothing moved since.
  ;(stuck.layers[1] as Layer).overrides = {
    statusCheckRollup: [{ ...run('vitest', null), startedAt: '2026-10-19T00:00:00Z' }],
  }

  const ranMerged = await stack(merged, 'wait')
  const ranStuck = await stack(serve(stuck), 'wait', { SHEPHERD_STALL_FLOOR: '60' })

  expect(ranMerged.document).toMatchObject({ ok: true, result: 'merged', layer: 471 })
  expect(ranStuck.document).toMatchObject({ ok: true, result: 'stalled', layer: 471 })
})

it('wait holds a layer whose required check has no row, until the bound ends', async () => {
  const lint = world()
  ;(lint.layers[1] as Layer).overrides = { statusCheckRollup: [run('lint', 'SUCCESS')] }
  const none = world()
  ;(none.layers[1] as Layer).overrides = { statusCheckRollup: [] }

  // Only `main`, the stack base, requires `vitest`. A layer's own base
  // requires nothing.
  const byBranch = (served: StackWorld) =>
    serve(served, {
      more: {
        requiredContexts: async ({ branch }) => ({
          contexts: branch === 'main' ? ['vitest'] : [],
          unavailable: null,
        }),
      },
    })

  const env = { SHEPHERD_WAIT_BOUND: '60', SHEPHERD_WAIT_POLL: '30' }
  const withLint = await stack(byBranch(lint), 'wait', env)
  const withNone = await stack(byBranch(none), 'wait', env)

  for (const ran of [withLint, withNone]) {
    expect(ran.document).toMatchObject({
      ok: true,
      result: 'pending',
      layer: 471,
      report: { result: 'pending', unreported: ['vitest'], waited: 60 },
    })
  }
})

it('wait passes a layer once its required check reports', async () => {
  const state = world()
  const layer = state.layers[1] as Layer
  layer.overrides = { statusCheckRollup: [] }
  const gh = serve(state, {
    more: {
      // The required check reports on the second read of the top layer.
      viewPullRequest: async ({ pullRequest }) => {
        const found = state.layers.find((each) => each.number === pullRequest) as Layer
        const reply = row(found.number, found.head, found.overrides)
        if (pullRequest === 471) layer.overrides = {}
        return reply
      },
    },
  })

  const ran = await stack(gh, 'wait', { SHEPHERD_WAIT_BOUND: '60', SHEPHERD_WAIT_POLL: '30' })

  expect(ran.document).toMatchObject({ ok: true, result: 'passed' })
})

it('wait decides from the rollup alone when the required checks cannot be read', async () => {
  const state = world()
  ;(state.layers[1] as Layer).overrides = { statusCheckRollup: [] }

  const ran = await stack(
    serve(state, { contexts: { contexts: [], unavailable: 'gh: HTTP 502' } }),
    'wait',
  )

  expect(ran.document).toMatchObject({ ok: true, result: 'passed' })
  expect(ran.stderr).toContain('the required checks of main are unavailable')
})

it('wait refuses, with the layer, when the wait of a layer did not complete', async () => {
  const gh = serve(world(), {
    more: { viewPullRequest: async () => Promise.reject(ghFails('gh: HTTP 502')) },
  })

  const ran = await stack(gh, 'wait')

  expect(ran.document).toMatchObject({
    ok: false,
    detail: '#470: could not read pull request #470: gh: HTTP 502',
    layer: 470,
  })
})

// --- merge -------------------------------------------------------------------

/** The merge of a stack as GitHub runs it: every layer merges. */
const mergeAll = (state: StackWorld): GhResults['mergeStack'] => {
  for (const layer of state.layers) {
    layer.overrides = {
      ...layer.overrides,
      state: 'MERGED',
      mergeCommit: { oid: `${layer.head}-merged` },
    }
  }
  return { accepted: true, output: '✓ Merged #470, #471 into main (b1-merged)' }
}

const BOTH: GhResults['mergeMethods'] = { methods: ['merge', 'squash'], unavailable: null }

it('merge runs gh stack merge once every layer is ready, and gives each merge commit', async () => {
  const ran = await stack(serve(world(), { methods: BOTH, merge: mergeAll }), 'merge')

  expect(ran.code).toBe(0)
  expect(ran.document).toEqual({
    action: 'merge',
    repo: 'bje-settings/claude',
    stack: 472,
    ok: true,
    detail: 'merged',
    result: 'merged',
    method: 'squash',
    output: '✓ Merged #470, #471 into main (b1-merged)',
    layers: [
      { number: 470, state: 'MERGED', mergeCommit: 'a1-merged' },
      { number: 471, state: 'MERGED', mergeCommit: 'b1-merged' },
    ],
  })
})

/** GitHub, which merges only stack 472, and says by which method. */
const mergeAs: NonNullable<Serve['merge']> = (state, query) => {
  if (query.stack !== 472) return { accepted: false, output: `✗ no stack #${query.stack}` }
  mergeAll(state)
  return { accepted: true, output: `✓ Merged stack #${query.stack} by ${query.method}` }
}

it('merge takes the first method the base allows, squash before merge before rebase', async () => {
  const merge = await stack(
    serve(world(), {
      methods: { methods: ['merge', 'rebase'], unavailable: null },
      merge: mergeAs,
    }),
    'merge',
  )
  const rebase = await stack(
    serve(world(), { methods: { methods: ['rebase'], unavailable: null }, merge: mergeAs }),
    'merge',
  )
  const squash = await stack(serve(world(), { methods: BOTH, merge: mergeAs }), 'merge')

  // The output is GitHub's, so it proves which stack and method gh got.
  expect(merge.document).toMatchObject({
    result: 'merged',
    method: 'merge',
    output: '✓ Merged stack #472 by merge',
  })
  expect(rebase.document).toMatchObject({
    result: 'merged',
    method: 'rebase',
    output: '✓ Merged stack #472 by rebase',
  })
  expect(squash.document).toMatchObject({
    result: 'merged',
    method: 'squash',
    output: '✓ Merged stack #472 by squash',
  })
})

it('merge reports a merge GitHub accepted that has not landed on every layer', async () => {
  const queued = (state: StackWorld): GhResults['mergeStack'] => {
    ;(state.layers[0] as Layer).overrides = { state: 'MERGED', mergeCommit: { oid: 'a1-merged' } }
    return { accepted: true, output: 'Added the stack to the merge queue' }
  }
  const unread = (state: StackWorld): GhResults['mergeStack'] => {
    state.layers.splice(1, 1)
    return mergeAll(state)
  }

  const ran = await stack(serve(world(), { methods: BOTH, merge: queued }), 'merge')
  const lost = await stack(serve(world(), { methods: BOTH, merge: unread }), 'merge')

  expect(ran.document).toMatchObject({
    ok: true,
    result: 'accepted',
    layers: [
      { number: 470, state: 'MERGED', mergeCommit: 'a1-merged' },
      { number: 471, state: 'OPEN', mergeCommit: null },
    ],
  })
  expect(lost.document.layers[1]).toEqual({
    number: 471,
    state: null,
    mergeCommit: null,
    read_error: 'no pull request #471',
  })
})

it('merge reports GitHub’s refusal in gh’s own words, as a skip, and never throws', async () => {
  const refuse = (): GhResults['mergeStack'] => ({
    accepted: false,
    output: '✗ Repository rule violations found: Required status check "vitest" is expected.',
  })

  const ran = await stack(serve(world(), { methods: BOTH, merge: refuse }), 'merge')

  expect(ran.code).toBe(0)
  expect(ran.document).toMatchObject({
    ok: true,
    result: 'refused',
    method: 'squash',
    reason: '✗ Repository rule violations found: Required status check "vitest" is expected.',
  })
})

/** Each way a layer is not ready, current and green, with the reason
 *  `merge` gives. No case registers a merge, so a merge would throw. */
const NOT_READY: readonly [string, (state: StackWorld) => void, string][] = [
  [
    'a layer behind its base',
    (state) => {
      ;(state.layers[1] as Layer).holds = 'a0'
    },
    'is behind its base',
  ],
  [
    'pending checks',
    (state) => {
      ;(state.layers[1] as Layer).overrides = { statusCheckRollup: [run('vitest', null)] }
    },
    'checks are pending',
  ],
  [
    'a draft',
    (state) => {
      ;(state.layers[1] as Layer).overrides = { isDraft: true }
    },
    'is a draft',
  ],
  [
    'a required check that has not reported',
    (state) => {
      ;(state.layers[1] as Layer).overrides = { statusCheckRollup: [run('lint', 'SUCCESS')] }
    },
    'required check vitest has not reported',
  ],
]

for (const [what, arrange, reason] of NOT_READY) {
  it(`merge refuses a stack with ${what}, and merges nothing`, async () => {
    const state = world()
    arrange(state)

    const ran = await stack(serve(state, { methods: BOTH }), 'merge')

    expect(ran.document).toMatchObject({
      ok: false,
      result: 'not_ready',
      base: 'main',
      failing: [{ number: 471, reasons: [reason] }],
    })
  })
}

it('merge refuses a layer out of sync with its branch, a missing approval, and a closed entry', async () => {
  const state = { ...world(), closed: [473] }
  const gh = serve(state, {
    methods: BOTH,
    rules: (branch) => (branch === 'main' ? ONE_APPROVAL : NO_RULE),
    more: { branchRef: async () => ({ sha: 'moved', unavailable: null }) },
  })

  const ran = await stack(gh, 'merge')

  expect(ran.document.failing).toEqual([
    { number: 470, reasons: ['needs an approval', 'is out of sync with its branch'] },
    { number: 471, reasons: ['needs an approval', 'is out of sync with its branch'] },
    { number: 473, reasons: ['is closed'] },
  ])
})

it('merge refuses unresolved threads, a red required check, and any red check', async () => {
  const threads = serve(world(), {
    methods: BOTH,
    rules: () => THREADS,
    more: {
      viewPullRequestDetail: async ({ pullRequest }) => ({
        pullRequest: {
          unresolvedThreads: pullRequest === 471 ? [{ path: 'a.ts' }] : [],
        } as unknown as PullRequestDetail,
        unavailable: null,
        missing: false,
      }),
    },
  })
  const required = world()
  ;(required.layers[1] as Layer).overrides = { statusCheckRollup: [run('vitest', 'FAILURE')] }
  const other = world()
  ;(other.layers[1] as Layer).overrides = {
    statusCheckRollup: [run('vitest', 'SUCCESS'), run('lint', 'FAILURE')],
  }

  const ranThreads = await stack(threads, 'merge')
  const ranRequired = await stack(serve(required, { methods: BOTH }), 'merge')
  const ranOther = await stack(serve(other, { methods: BOTH }), 'merge')

  expect(ranThreads.document.failing).toEqual([
    { number: 471, reasons: ['has unresolved review threads'] },
  ])
  expect(ranRequired.document.failing).toEqual([
    { number: 471, reasons: ['required check vitest failed', 'checks are failed'] },
  ])
  expect(ranOther.document.failing).toEqual([{ number: 471, reasons: ['checks are failed'] }])
})

it('merge takes a stack with no checks and none required, and a ref it could not read', async () => {
  const none = world()
  for (const layer of none.layers) layer.overrides = { statusCheckRollup: [] }
  const noRef = serve(world(), {
    methods: BOTH,
    merge: mergeAll,
    more: { branchRef: async () => ({ sha: null, unavailable: 'gh: HTTP 502' }) },
  })

  const ranNone = await stack(
    serve(none, { methods: BOTH, merge: mergeAll, contexts: { contexts: [], unavailable: null } }),
    'merge',
  )
  const ranNoRef = await stack(noRef, 'merge')

  // GitHub applies the rules of the base to the merge, so an unread ref
  // is no reason to refuse it here.
  expect(ranNone.document.result).toBe('merged')
  expect(ranNoRef.document.result).toBe('merged')
})

it('merge reads the required checks and the merge methods of the stack base', async () => {
  const state = world()
  ;(state.layers[1] as Layer).overrides = { statusCheckRollup: [run('lint', 'SUCCESS')] }
  // Only `main`, the stack base, requires `vitest` and allows a method.
  const byBranch = (served: StackWorld) =>
    serve(served, {
      merge: mergeAll,
      more: {
        requiredContexts: async ({ branch }) => ({
          contexts: branch === 'main' ? ['vitest'] : [],
          unavailable: null,
        }),
        mergeMethods: async ({ branch }) => ({
          methods: branch === 'main' ? ['squash'] : [],
          unavailable: null,
        }),
      },
    })

  const unreported = await stack(byBranch(state), 'merge')
  const ready = await stack(byBranch(world()), 'merge')

  expect(unreported.document.failing).toEqual([
    { number: 471, reasons: ['required check vitest has not reported'] },
  ])
  expect(ready.document).toMatchObject({ result: 'merged', method: 'squash' })
})

it('state names a red required check of the stack base, not of the own base', async () => {
  const state = world()
  ;(state.layers[1] as Layer).overrides = { statusCheckRollup: [run('vitest', 'FAILURE')] }
  const gh = serve(state, {
    more: {
      requiredContexts: async ({ branch }) => ({
        contexts: branch === 'main' ? ['vitest'] : [],
        unavailable: null,
      }),
    },
  })

  const ran = await stack(gh, 'state')

  expect(ran.document.failing).toEqual([{ number: 471, reasons: ['required check vitest failed'] }])
})

it('merge relies on the rollup when the required checks cannot be read', async () => {
  const gh = serve(world(), {
    methods: BOTH,
    merge: mergeAll,
    contexts: { contexts: [], unavailable: 'gh: HTTP 502' },
  })

  const ran = await stack(gh, 'merge')

  expect(ran.document.result).toBe('merged')
  expect(ran.stderr).toContain('the required checks of main are unavailable')
})

it('merge proves nothing, and merges nothing, on a read that failed', async () => {
  const layer = await stack(
    serve(world(), {
      more: { viewPullRequest: async () => Promise.reject(ghFails('gh: HTTP 502')) },
    }),
    'merge',
  )
  const compare = await stack(
    serve(world(), {
      more: { compareCommits: async () => ({ comparison: null, unavailable: 'gh: HTTP 502' }) },
    }),
    'merge',
  )
  const methods = await stack(
    serve(world(), { methods: { methods: null, unavailable: 'gh: HTTP 502' } }),
    'merge',
  )

  expect(layer.document).toMatchObject({ ok: false, result: 'unread', layer: 470 })
  expect(compare.document).toMatchObject({
    ok: false,
    result: 'unread',
    detail: 'the compare of #470 could not be read',
  })
  expect(methods.document).toMatchObject({
    ok: false,
    result: 'unread',
    detail: 'the merge methods of main could not be read: gh: HTTP 502',
  })
})

it('merge refuses a base that allows no merge method', async () => {
  const ran = await stack(serve(world(), { methods: { methods: [], unavailable: null } }), 'merge')

  expect(ran.document).toMatchObject({
    ok: false,
    result: 'not_ready',
    detail: 'refused: main allows no merge method',
    base: 'main',
    failing: [],
  })
})

// --- the command line -----------------------------------------------------------

it('prints its own usage for --help, naming every action', async () => {
  const ran = await stack(serve(world()), '--help')

  expect(ran.code).toBe(0)
  expect(ran.stdout).toBe(`${HELP}\n`)
})

it('refuses a usage error with exit 2, before any gh call', async () => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const plain = sandbox.join('plain')
  mkdirSync(plain)
  const run = async (argv: string[]) => {
    const output = captureOutput()
    const time = fakeTime()
    const code = await runShepherdStack(argv, {
      cwd: repo,
      env: sandbox.env,
      output,
      createGh: () => {
        throw new Error('no gh call on a usage error')
      },
      ...time,
    })
    return [code, output.stderr().split('\n')[0]]
  }

  expect(await run([repo, '472'])).toEqual([2, HELP.split('\n')[0]])
  expect(await run([sandbox.join('nope'), '472', 'state'])).toEqual([
    2,
    `not a directory: ${sandbox.join('nope')}`,
  ])
  expect(await run([repo, '0', 'state'])).toEqual([2, 'not a stack number: 0'])
  expect(await run([plain, '472', 'state'])).toEqual([2, `not a git repository: ${plain}`])
  expect(await run([repo, '472', 'constructor'])).toEqual([2, 'unknown action: constructor'])
})

it('refuses with exit 1 when gh cannot resolve the repository', async () => {
  const gh = {
    ...serve(world()),
    viewRepository: async () => Promise.reject(ghFails('gh: x', 127)),
  }

  const ran = await stack(gh, 'state')

  expect(ran).toMatchObject({ code: 1, stdout: '', stderr: 'gh is required\n' })
})

it('reports an internal error rather than a stack trace, and exits 3', async () => {
  const thrown = {
    ...serve(world()),
    listOpenStacks: async () => Promise.reject(new TypeError('boom')),
  }
  const odd = { ...serve(world()), listOpenStacks: async () => Promise.reject('odd') }

  const error = await stack(thrown, 'state')
  const value = await stack(odd, 'state')

  expect(error).toMatchObject({
    code: 3,
    stdout: '',
    stderr: 'shepherd.ts shepherd-stack: internal error: TypeError: boom\n',
  })
  expect(value.stderr).toBe('shepherd.ts shepherd-stack: internal error: string: odd\n')
})
