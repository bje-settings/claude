// `gh.ts shepherd-status` and GitHub stacks (#469). A stack is one target,
// after the pull requests. Every open layer is judged by the rules of the
// stack base (ruling 4 on #469). A stack that is not ready goes to
// `not_ready`, with each layer and the requirement that failed.
//
// git is real (`harness/git.ts`). `gh` is the injected server
// (`harness/pulls.ts`), which answers the stacks from the rows that carry
// `stack`. The rows are the shape of the real stack of #470 and #471 on
// 2026-10-20: two layers, the upper one based on the lower one's branch.
import { expect, it } from 'vitest'
import type { ShepherdContext } from '#gh/shepherd.ts'
import { runShepherdStatus } from '#gh/subcommands/shepherd-status.ts'
import { type GhClient, type GhResults, ghFails, type PullRequestDetail } from '#harness/gh.ts'
import { createGitFixtures } from '#harness/git.ts'
import { captureOutput } from '#harness/output.ts'
import { createGhServer, type GhServerOptions, type PullRequestRow } from '#harness/pulls.ts'
import { createSandbox } from '#harness/sandbox.ts'

const REPOSITORY = { nameWithOwner: 'bje-settings/claude', defaultBranchRef: { name: 'main' } }

/** A rule set with no review rule. */
const NO_RULE: GhResults['requiredReviews'] = {
  reviews: { approvals: 0, codeOwner: false, threadResolution: false, lastPush: false },
  unavailable: null,
}

/** One approval and resolved threads, as a strict stack base asks. */
const STRICT: GhResults['requiredReviews'] = {
  reviews: { approvals: 1, codeOwner: false, threadResolution: true, lastPush: false },
  unavailable: null,
}

/** One approval, and no thread rule. */
const ONE_APPROVAL: GhResults['requiredReviews'] = {
  reviews: { approvals: 1, codeOwner: false, threadResolution: false, lastPush: false },
  unavailable: null,
}

const REQUIRED: GhResults['requiredContexts'] = { contexts: ['vitest'], unavailable: null }

/** A check run of `name` in `conclusion`, or still running. */
const run = (name: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  detailsUrl: `https://github.com/bje-settings/claude/actions/runs/1/job/${name.length}`,
})

/** One open layer of stack 472. 470 is the bottom, on `main`. */
const layer = (number: number, overrides: PullRequestRow = {}): PullRequestRow => ({
  number,
  title: `layer ${number}`,
  author: { login: 'brianespinosa' },
  isDraft: false,
  labels: [],
  autoMergeRequest: null,
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  headRefOid: `${number}`.repeat(8),
  headRefName: `wktr-${number}`,
  baseRefName: number === 470 ? 'main' : `wktr-${number - 1}`,
  isCrossRepository: false,
  statusCheckRollup: [run('vitest', 'SUCCESS')],
  createdAt: `2026-10-20T0${number - 469}:00:00Z`,
  reviewDecision: '',
  reviews: [],
  stack: { number: 472, base: 'main' },
  ...overrides,
})

const STACK = { stack: 472, base: 'main', layers: [470, 471] }

/** A server over `prs` that answers the review rules of each branch from
 *  `rules`, and anything else from `options`. */
const serve = (
  prs: readonly PullRequestRow[],
  options: GhServerOptions = {},
  rules: (branch: string) => GhResults['requiredReviews'] = () => NO_RULE,
): GhClient => {
  const server = createGhServer({
    prs,
    ...options,
    replies: {
      viewRepository: REPOSITORY,
      listRuns: [],
      requiredContexts: REQUIRED,
      ...options.replies,
    },
  })
  return { ...server, requiredReviews: async ({ branch }) => rules(branch) }
}

/** Unresolved threads on #471 alone. */
const threadsOn471 = (gh: GhClient): GhClient => ({
  ...gh,
  viewPullRequestDetail: async ({ pullRequest }) => ({
    pullRequest: {
      unresolvedThreads: pullRequest === 471 ? [{ path: 'a.ts' }] : [],
    } as unknown as PullRequestDetail,
    unavailable: null,
    missing: false,
  }),
})

/** One run of the command in a real checkout. */
const status = async (gh: GhClient, ...argv: string[]) => {
  const sandbox = createSandbox()
  const repo = createGitFixtures(sandbox).create(sandbox.join('r'))
  const output = captureOutput()
  const context: ShepherdContext = {
    cwd: repo,
    env: sandbox.env,
    output,
    createGh: () => gh,
    now: () => 0,
    clock: () => {
      throw new Error('shepherd-status must not read the wall clock')
    },
    sleep: async () => {
      throw new Error('shepherd-status must not sleep')
    },
  }
  const code = await runShepherdStatus([repo, ...argv], context)
  const stdout = output.stdout()
  return {
    code,
    stderr: output.stderr(),
    document: stdout === '' ? null : JSON.parse(stdout),
  }
}

it('gives a ready stack as one target after the pull requests, and no layer as a pull request', async () => {
  const pull = layer(468, { stack: undefined, autoMergeRequest: { mergeMethod: 'SQUASH' } })
  // A layer with auto-merge is still no pull request target.
  const bottom = layer(470, { autoMergeRequest: { mergeMethod: 'SQUASH' } })

  const ran = await status(serve([pull, bottom, layer(471)]))

  expect(ran.code).toBe(0)
  expect(
    ran.document.targets.map((target: { number?: number }) => target.number ?? 'stack'),
  ).toEqual([468, 'stack'])
  expect(ran.document.targets.at(-1)).toEqual(STACK)
  expect(ran.document.not_ready).toEqual([])
})

it('drops a merged entry from the layers, and gives a closed one as not ready', async () => {
  const merged = layer(469, { state: 'MERGED' })
  const closed = layer(473, { state: 'CLOSED', baseRefName: 'wktr-471' })

  const landed = await status(serve([merged, layer(470), layer(471)]))
  const shut = await status(serve([layer(470), layer(471), closed]))

  expect(landed.document.targets).toEqual([STACK])
  expect(shut.document.not_ready).toEqual([
    { ...STACK, failing: [{ number: 473, reasons: ['is closed'] }] },
  ])
})

for (const [what, prs, reasons] of [
  [
    'a draft layer',
    [layer(470), layer(471, { isDraft: true })],
    [{ number: 471, reasons: ['is a draft'] }],
  ],
  [
    'a red required check on the bottom layer',
    [layer(470, { statusCheckRollup: [run('vitest', 'FAILURE')] }), layer(471)],
    [{ number: 470, reasons: ['required check vitest failed'] }],
  ],
] as const) {
  it(`leaves out a stack with ${what}, with or without --all`, async () => {
    const plain = await status(serve(prs))
    const forced = await status(serve(prs), '--all')

    expect(plain.document.targets).toEqual([])
    expect(plain.document.not_ready).toEqual([{ ...STACK, failing: reasons }])
    expect(forced.document.not_ready).toEqual([{ ...STACK, failing: reasons }])
  })
}

it('leaves out a stack with a missing approval or an unresolved thread, but not with --all', async () => {
  const gh = threadsOn471(serve([layer(470), layer(471)], {}, () => STRICT))

  const plain = await status(gh)
  const forced = await status(gh, '--all')

  expect(plain.document.not_ready).toEqual([
    {
      ...STACK,
      failing: [
        { number: 470, reasons: ['needs an approval'] },
        { number: 471, reasons: ['needs an approval', 'has unresolved review threads'] },
      ],
    },
  ])
  expect(forced.document.targets).toEqual([STACK])
  expect(forced.document.not_ready).toEqual([])
})

it('judges an upper layer by the rules of the stack base, not of its own base', async () => {
  const approved = {
    reviews: [{ author: { login: 'a' }, state: 'APPROVED', commit: { oid: 'x' } }],
  }
  const prs = [layer(470, approved), layer(471)]
  const baseStrict = (branch: string) => (branch === 'main' ? ONE_APPROVAL : NO_RULE)
  const ownStrict = (branch: string) => (branch === 'main' ? NO_RULE : ONE_APPROVAL)

  const byBase = await status(serve(prs, {}, baseStrict))
  const byOwn = await status(serve(prs, {}, ownStrict))

  expect(byBase.document.not_ready).toEqual([
    { ...STACK, failing: [{ number: 471, reasons: ['needs an approval'] }] },
  ])
  expect(byOwn.document.targets).toEqual([STACK])
})

it('reads the required checks of the stack base, not of a layer', async () => {
  const prs = [layer(470), layer(471, { statusCheckRollup: [run('vitest', 'FAILURE')] })]
  const gh: GhClient = {
    ...serve(prs),
    requiredContexts: async ({ branch }) => ({
      contexts: branch === 'main' ? ['vitest'] : [],
      unavailable: null,
    }),
  }

  const ran = await status(gh)

  expect(ran.document.not_ready).toEqual([
    { ...STACK, failing: [{ number: 471, reasons: ['required check vitest failed'] }] },
  ])
})

it('reads the threads of a layer only when the stack base asks, and once for a pull request target too', async () => {
  const resolved = threadsOn471(
    serve(
      [
        layer(470, {
          autoMergeRequest: { mergeMethod: 'SQUASH' },
          reviews: [{ author: { login: 'a' }, state: 'APPROVED', commit: { oid: 'x' } }],
        }),
        layer(471, {
          reviews: [{ author: { login: 'a' }, state: 'APPROVED', commit: { oid: 'x' } }],
        }),
      ],
      {},
      () => STRICT,
    ),
  )

  const ran = await status(resolved)

  expect(ran.document.not_ready).toEqual([
    { ...STACK, failing: [{ number: 471, reasons: ['has unresolved review threads'] }] },
  ])
})

it('keeps a stack whose required check is pending or has not reported', async () => {
  const pending = await status(
    serve([
      layer(470, { statusCheckRollup: [run('vitest', null)] }),
      layer(471, { statusCheckRollup: [] }),
    ]),
  )

  expect(pending.document.targets).toEqual([STACK])
})

it('judges a stack by its rollup alone when the required checks cannot be read', async () => {
  const red = [layer(470, { statusCheckRollup: [run('vitest', 'FAILURE')] }), layer(471)]

  const ran = await status(
    serve(red, { replies: { requiredContexts: { contexts: [], unavailable: 'gh: HTTP 502' } } }),
  )

  expect(ran.document.targets).toEqual([STACK])
  expect(ran.stderr).toBe(
    'the required checks of main are unavailable: gh: HTTP 502; the rollup alone decides\n',
  )
})

it('with a label, takes a stack when one layer carries it, and reads the other layer', async () => {
  const labelled = layer(470, { labels: [{ name: 'ship' }] })

  const taken = await status(serve([labelled, layer(471)]), 'ship')
  const other = await status(serve([layer(470), layer(471)]), 'ship')

  expect(taken.document.targets).toEqual([STACK])
  expect(other.document.targets).toEqual([])
})

it('leaves out a stack whose layer cannot be read, and never as not ready', async () => {
  const labelled = layer(470, { labels: [{ name: 'ship' }] })
  const prs = [labelled, layer(471)]

  const ran = await status(
    serve(prs, { replies: { viewPullRequest: ghFails('gh: HTTP 502') } }),
    'ship',
  )

  expect(ran.document.targets).toEqual([])
  expect(ran.document.not_ready).toEqual([])
  expect(ran.stderr).toBe('stack #472 is left out: #471 could not be read: gh: HTTP 502\n')
})

it('says when the stacks could not all be read, and keeps each stack it read', async () => {
  const ran = await status(
    serve([], {
      replies: {
        listOpenStacks: {
          rows: [{ number: 9, base: 'main', layers: [{ number: 8, state: 'OPEN' }] }],
          unavailable: '1 pullRequests row(s) could not be read',
        },
        viewPullRequest: layer(8, { stack: undefined }),
      },
    }),
  )

  expect(ran.document.targets).toEqual([{ stack: 9, base: 'main', layers: [8] }])
  expect(ran.stderr).toBe(
    'a stack may be left out: the stacks could not all be read: 1 pullRequests row(s) could not be read\n',
  )
})

it('gives two stacks on one base, each in the order it was read', async () => {
  const second = (number: number) => layer(number, { stack: { number: 9, base: 'main' } })

  const ran = await status(serve([layer(470), layer(471), second(8)]))

  expect(ran.document.targets).toEqual([STACK, { stack: 9, base: 'main', layers: [8] }])
})
