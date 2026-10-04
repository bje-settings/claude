// The pr-state command. Every arm in process: the `gh` client is injected, so
// nothing is spawned and nothing here depends on a machine's login. An
// endpoint with no registration throws and names itself, which is what pins
// that a read this command skips really is skipped.
import { describe, expect, it } from 'vitest'

import {
  type CheckContext,
  type CommitComparison,
  createGhMock,
  type GhReplies,
  ghFails,
  type PullRequestDetail,
  type WorkflowRun,
} from '#harness/gh.ts'
import {
  deriveState,
  isLogicPath,
  type LoopState,
  type PrStateReport,
  runPrState,
  verdictOf,
  waitHintFrom,
} from '#workstreams/subcommands/pr-state.ts'

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 178,
  title: 'feat(workstreams): sweep command and skill (primitive 1)',
  state: 'OPEN',
  draft: true,
  base: 'main',
  head: 'wktr-130-ws-sweep',
  headSha: '9b13a20',
  mergeable: 'MERGEABLE',
  checks: [
    { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
    { name: 'types', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
  ],
  unresolvedThreads: [],
  commentAuthors: ['github-code-quality'],
  ...overrides,
})

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  name: 'CI',
  event: 'pull_request',
  headSha: '9b13a20',
  status: 'completed',
  conclusion: 'success',
  startedAt: '2026-09-22T06:31:17Z',
  updatedAt: '2026-09-22T06:33:14Z',
  ...overrides,
})

/** Every read, answered, with whichever of them a case is about replaced. */
const replies = (overrides: GhReplies = {}): GhReplies => ({
  viewPullRequestDetail: { pullRequest: detail(), unavailable: null, missing: false },
  requiredContexts: { contexts: ['vitest', 'types'], unavailable: null },
  listWorkflowRuns: { rows: [run()], unavailable: null },
  ...overrides,
})

const ran = async (argv: readonly string[], registered: GhReplies = replies()) =>
  runPrState(argv, { gh: createGhMock(registered) })

/** The report a `--json` run answered with. */
const reportOf = async (
  argv: readonly string[],
  registered: GhReplies = replies(),
): Promise<PrStateReport> => {
  const answer = await ran(['--json', ...argv], registered)
  if (answer.outcome !== 'ok') throw new Error(`expected a report, got ${answer.error}`)
  return JSON.parse(answer.value) as PrStateReport
}

describe('the command line', () => {
  it('prints its own usage for --help, without asking gh anything', async () => {
    // Nothing is registered: an endpoint reached for here would throw and
    // name itself.
    const answer = await ran(['--help'], {})

    expect(answer.outcome).toBe('ok')
    expect(answer.outcome === 'ok' && answer.value).toMatch(/^One pull request's review-loop state/)
  })

  it('accepts -h as the short form of --help', async () => {
    const answer = await ran(['-h'], {})

    expect(answer.outcome).toBe('ok')
    expect(answer.outcome === 'ok' && answer.value).toMatch(/^One pull request's review-loop state/)
  })

  it('refuses an undeclared short flag', async () => {
    const answer = await ran(['178', '-x'], {})

    expect(answer.outcome).toBe('refused')
  })

  for (const [what, argv, reason] of [
    ['no pull request at all', [], 'pr-state takes a pull request number'],
    ['two pull requests', ['178', '177'], 'pr-state takes one pull request number, not 2'],
    ['a word that is not a number', ['main'], 'pr-state takes a pull request number, not "main"'],
    ['a number with a tail', ['178x'], 'pr-state takes a pull request number, not "178x"'],
    ['a zero', ['0'], 'pr-state takes a pull request number, not "0"'],
  ] as const) {
    it(`refuses ${what}`, async () => {
      const answer = await ran(argv, {})

      expect(answer).toEqual({ outcome: 'refused', error: reason })
    })
  }

  it('refuses a round that is not one of the three', async () => {
    const answer = await ran(['178', '--round', '3'], {})

    expect(answer.outcome).toBe('refused')
    expect(answer.outcome !== 'ok' && answer.error).toContain('--round must be one of 0, 1, 2')
  })

  for (const flag of ['--substantial', '--rot-checked'] as const) {
    it(`refuses ${flag} with --round 0, where no round has finished`, async () => {
      // Silently ignored otherwise: deriveState returns from every round-0 arm
      // before it reads either flag, so a caller that miscounted its own
      // rounds would be told nothing.
      const answer = await ran(['178', '--round', '0', flag])

      expect(answer.outcome).toBe('refused')
    })
  }

  it('accepts --round 2 without --substantial, which describes round 1 alone', async () => {
    const report = await reportOf(['178', '--round', '2'])

    expect(report.state).toBe('rot-check')
  })

  it('refuses a flag nobody declared', async () => {
    const answer = await ran(['178', '--nope'], {})

    expect(answer.outcome).toBe('refused')
  })
})

describe('the facts it reads', () => {
  it('reports the pull request, its required contexts, its run and its state', async () => {
    const report = await reportOf(['178'])

    expect(report.pullRequest).toBe(178)
    expect(report.head).toBe('wktr-130-ws-sweep')
    expect(report.headSha).toBe('9b13a20')
    expect(report.base).toBe('main')
    expect(report.draft).toBe(true)
    expect(report.mergeable).toBe('MERGEABLE')
    expect(report.requiredContexts).toEqual(['vitest', 'types'])
    expect(report.contextsFrom).toBe('ruleset')
    expect(report.contexts).toEqual([
      { name: 'vitest', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
      { name: 'types', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
    ])
    expect(report.hasPullRequestRun).toBe(true)
    expect(report.runsForHead).toEqual([{ name: 'CI', status: 'completed', conclusion: 'success' }])
    expect(report.verdict).toBe('green')
    expect(report.state).toBe('review-1')
    expect(report.unavailable).toEqual([])
  })

  it('counts unresolved review threads and comments as separate facts', async () => {
    // The enterprise coverage bot posts a COMMENT on every pull request here,
    // and a loop that counted it as an unresolved thread would never finish.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [{ author: 'reviewer-a', bot: false }],
            commentAuthors: ['github-code-quality', 'reviewer-a'],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.unresolvedThreads).toBe(1)
    expect(report.unresolvedThreadAuthors).toEqual(['reviewer-a'])
    expect(report.comments).toBe(2)
  })

  it('leaves fixing once every unresolved thread is a bot preview, and names them', async () => {
    // #219: 12 of #213's 13 unresolved threads were the mermaid-preview
    // workflow, posted by `github-actions` on every changed file. A bot
    // thread is informational, so it must not hold the loop at fixing.
    const report = await reportOf(
      ['178', '--round', '1'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [
              { author: 'github-actions', bot: true },
              { author: 'github-actions', bot: true },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.unresolvedThreads).toBe(0)
    expect(report.unresolvedThreadAuthors).toEqual([])
    expect(report.botThreads).toBe(2)
    // Raw, one entry per thread, the way `unresolvedThreadAuthors` already
    // is: `renderReport`'s own `authors()` helper is what dedupes for a
    // person to read.
    expect(report.botThreadAuthors).toEqual(['github-actions', 'github-actions'])
    expect(report.state).toBe('rot-check')
  })

  it('holds fixing on a mixed set, and names both counts apart', async () => {
    const report = await reportOf(
      ['178', '--round', '1'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [
              { author: 'github-actions', bot: true },
              { author: 'reviewer-a', bot: false },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.unresolvedThreads).toBe(1)
    expect(report.unresolvedThreadAuthors).toEqual(['reviewer-a'])
    expect(report.botThreads).toBe(1)
    expect(report.botThreadAuthors).toEqual(['github-actions'])
    expect(report.state).toBe('fixing')
  })

  it('holds fixing on a person-only set, with no bot threads named', async () => {
    const report = await reportOf(
      ['178', '--round', '1'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [{ author: 'reviewer-a', bot: false }],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.unresolvedThreads).toBe(1)
    expect(report.botThreads).toBe(0)
    expect(report.botThreadAuthors).toEqual([])
    expect(report.state).toBe('fixing')
  })

  it('asks the rules about the pull request’s OWN base branch', async () => {
    // A stacked pull request is based on a topic branch, and the default
    // branch's nine contexts are not what its ruleset requires.
    const asked: string[] = []
    const gh = createGhMock(replies())
    const answer = await runPrState(['--json', '178'], {
      gh: {
        ...gh,
        requiredContexts: async (query) => {
          asked.push(query.branch)
          return { contexts: ['vitest'], unavailable: null }
        },
      },
    })

    expect(answer.outcome).toBe('ok')
    expect(asked).toEqual(['main'])
  })

  it('asks for the runs on the head BRANCH, never by head sha', async () => {
    // Round 7 finding 6: `?head_sha=` answered nothing for a head whose runs
    // existed, and a pull request was closed and reopened over it.
    const queries: Array<{ branch?: string; perPage?: number }> = []
    const gh = createGhMock(replies())
    await runPrState(['--json', '178'], {
      gh: {
        ...gh,
        listWorkflowRuns: async (query = {}) => {
          queries.push(query)
          return { rows: [run()], unavailable: null }
        },
      },
    })

    expect(queries[0]).toEqual({ branch: 'wktr-130-ws-sweep' })
    // The second read is the wait-hint sample, which is not branch-scoped.
    expect(queries[1]).toEqual({ perPage: 30 })
  })
})

describe('a pull request that finished', () => {
  // #277: `pr-state` once gave a merged pull request a review-loop state as
  // if it were still open. `deriveState` checks the pull request's own
  // state right after `awaiting-pr`, before every other rule.
  it('reports merged at round 0, before any round has run', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ state: 'MERGED' }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.state).toBe('merged')
  })

  it('reports closed at round 0, before any round has run', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ state: 'CLOSED' }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.state).toBe('closed')
  })

  it('reports merged at round 2 with --rot-checked, never done', async () => {
    const report = await reportOf(
      ['178', '--round', '2', '--rot-checked'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ state: 'MERGED' }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.state).toBe('merged')
  })

  it('reports closed at round 2 with --rot-checked, never done', async () => {
    const report = await reportOf(
      ['178', '--round', '2', '--rot-checked'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ state: 'CLOSED' }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.state).toBe('closed')
  })

  it('reports merged even when a required context is red', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            state: 'MERGED',
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: ['vitest'], unavailable: null },
      }),
    )

    expect(report.verdict).toBe('red')
    expect(report.state).toBe('merged')
  })

  it('reports closed even with an unresolved review thread from a person', async () => {
    const report = await reportOf(
      ['178', '--round', '1'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            state: 'CLOSED',
            unresolvedThreads: [{ author: 'reviewer-a', bot: false }],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.state).toBe('closed')
  })

  it('leaves an open pull request unchanged', async () => {
    const report = await reportOf(['178'])

    expect(report.state).toBe('review-1')
  })

  it('stays null, never a guess, when the pull request state could not be read', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: { pullRequest: null, unavailable: 'gh: HTTP 500', missing: false },
      }),
    )

    expect(report.state).toBeNull()
  })
})

describe('the verdict over the required contexts', () => {
  it('is red when a required context concluded a failure', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null },
              { name: 'types', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.contexts[0]?.verdict).toBe('failed')
    expect(report.verdict).toBe('red')
    expect(report.state).toBe('red')
  })

  it('is pending when a required context has not reported at all', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.contexts[1]).toEqual({
      name: 'types',
      reported: false,
      conclusion: null,
      verdict: 'pending',
    })
    expect(report.verdict).toBe('pending')
    expect(report.state).toBe('ci-pending')
  })

  it('is pending when a required context has reported and not concluded', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
              { name: 'types', status: 'IN_PROGRESS', conclusion: null, startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.contexts[1]).toEqual({
      name: 'types',
      reported: true,
      conclusion: null,
      verdict: 'pending',
    })
    expect(report.verdict).toBe('pending')
  })

  for (const conclusion of ['SUCCESS', 'SKIPPED', 'NEUTRAL']) {
    it(`treats a required context that concluded ${conclusion} as satisfied`, async () => {
      // GitHub's own merge gate accepts all three. To report a skipped
      // required job as red would be a loop that never finishes, on any
      // repository whose workflow skips a job by path filter.
      const report = await reportOf(
        ['178'],
        replies({
          viewPullRequestDetail: {
            pullRequest: detail({
              checks: [
                { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
                { name: 'types', status: 'COMPLETED', conclusion, startedAt: null },
              ],
            }),
            unavailable: null,
            missing: false,
          },
        }),
      )

      expect(report.verdict).toBe('green')
      // The raw conclusion is carried beside the verdict, so a caller can
      // still see which of the three it was.
      expect(report.contexts[1]?.conclusion).toBe(conclusion)
    })
  }

  it('reads the LATEST check reported under a name, not merely the first', async () => {
    // A `gh stack push` cancels the run in flight and starts a new one.
    // The rollup then lists both under the same name. The run that
    // started later must answer, or a cancelled first run would report
    // the whole pull request red even though the later run passed (#243).
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            checks: [
              {
                name: 'vitest',
                status: 'COMPLETED',
                conclusion: 'CANCELLED',
                startedAt: '2026-09-26T00:00:00Z',
              },
              { name: 'types', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
              {
                name: 'vitest',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: '2026-09-26T00:05:00Z',
              },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(report.verdict).toBe('green')
    expect(report.state).not.toBe('red')
  })

  it('names a failure over a pending context, because the failure is what to act on', () => {
    const verdict = verdictOf(
      [
        { name: 'a', reported: false, conclusion: null, verdict: 'pending' },
        { name: 'b', reported: true, conclusion: 'FAILURE', verdict: 'failed' },
      ],
      true,
      true,
    )

    expect(verdict).toBe('red')
  })

  it('is pending, never green, over a list of contexts that is not settled yet', () => {
    // The head fallback's list is whatever has reported. Green over it would
    // be green over however little that is.
    const settled = [
      { name: 'a', reported: true, conclusion: 'SUCCESS', verdict: 'success' },
    ] as const

    expect(verdictOf(settled, true, true)).toBe('green')
    expect(verdictOf(settled, true, false)).toBe('pending')
    expect(verdictOf([], true, true)).toBe('pending')
  })

  for (const [what, rows] of [
    ['no runs at all', []],
    ['a run for another event on the same head', [run({ event: 'push' })]],
    ['a pull_request run on another head', [run({ headSha: 'deadbee' })]],
  ] as const) {
    it(`is no-run for ${what}`, async () => {
      const report = await reportOf(
        ['178'],
        replies({ listWorkflowRuns: { rows, unavailable: null } }),
      )

      expect(report.hasPullRequestRun).toBe(false)
      expect(report.verdict).toBe('no-run')
      expect(report.state).toBe('no-run')
    })
  }
})

describe('a base branch no ruleset covers', () => {
  it('falls back to the contexts that reported on the head, and says so', async () => {
    // Every layer of a stack is based on a topic branch, and a verdict over
    // an empty required list would be green before a single check had run.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ base: 'wktr-130-ws-sweep' }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
      }),
    )

    expect(report.requiredContexts).toEqual([])
    expect(report.contextsFrom).toBe('head')
    expect(report.contexts.map((context) => context.name)).toEqual(['vitest', 'types'])
    expect(report.verdict).toBe('green')
    // NOT under `unavailable`: a caller keys on that to decide whether the
    // report is an answer at all, and a stacked pull request is an answer.
    expect(report.unavailable).toEqual([])
  })

  it('is no-run, not green, when nothing has reported on the head either', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ base: 'wktr-130-ws-sweep', checks: [] }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
        listWorkflowRuns: { rows: [], unavailable: null },
      }),
    )

    expect(report.contexts).toEqual([])
    expect(report.verdict).toBe('no-run')
  })

  it('is pending, not green, when a run exists and nothing has reported yet', async () => {
    // The run is there, so it is not `no-run`; the rollup is still empty, so
    // there is nothing to be green about. Green here would send a round to
    // review a diff no check has looked at.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ base: 'wktr-130-ws-sweep', checks: [] }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
        listWorkflowRuns: { rows: [run()], unavailable: null },
      }),
    )

    expect(report.hasPullRequestRun).toBe(true)
    expect(report.contexts).toEqual([])
    expect(report.verdict).toBe('pending')
    expect(report.state).toBe('ci-pending')
  })

  it('is pending while one workflow has finished and another is still running', async () => {
    // Two workflows run on a pull request here. The finished one's context is
    // satisfying and the other has not created its checks yet, so a verdict
    // over the reported list alone would be green over a fraction of it.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            base: 'wktr-130-ws-sweep',
            checks: [
              {
                name: 'plugin-validate',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: null,
              },
            ],
          }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
        listWorkflowRuns: {
          rows: [
            run({ name: 'Plugin validate' }),
            run({ name: 'CI', status: 'in_progress', conclusion: null }),
          ],
          unavailable: null,
        },
      }),
    )

    expect(report.contexts.map((context) => context.name)).toEqual(['plugin-validate'])
    expect(report.verdict).toBe('pending')
  })

  it('is green once every run on the head has finished adding contexts', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ base: 'wktr-130-ws-sweep' }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
        listWorkflowRuns: {
          rows: [run({ name: 'Plugin validate' }), run({ name: 'CI' })],
          unavailable: null,
        },
      }),
    )

    expect(report.verdict).toBe('green')
  })

  it('reads one name reported twice as one context', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            base: 'topic',
            checks: [
              { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
              { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
      }),
    )

    expect(report.contexts).toHaveLength(1)
  })
})

describe('a cancelled run that a newer run supersedes (#364)', () => {
  const OLD = '2026-10-01T00:00:00Z'
  const NEW = '2026-10-01T00:01:00Z'
  /** A check from run `id` of CI, whose own conclusion and whose run's
   *  conclusion can differ: a fan-in job of a cancelled run fails. */
  const fromRun = (
    name: string,
    conclusion: string | null,
    id: number,
    runConclusion: string | null,
  ): CheckContext => ({
    name,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion,
    startedAt: id === 1 ? OLD : NEW,
    run: {
      id,
      workflowId: 1,
      workflow: 'CI',
      createdAt: id === 1 ? OLD : NEW,
      conclusion: runConclusion,
    },
  })
  /** The shadcn#33 shape on a stack layer's base: a matrix placeholder and
   *  a fan-in failure from the cancelled run, then the newer run's own. */
  const SUPERSEDED: readonly CheckContext[] = [
    fromRun(`ab-style (\${{ matrix.style }})`, 'CANCELLED', 1, 'CANCELLED'),
    fromRun('vitest', 'FAILURE', 1, 'CANCELLED'),
    fromRun('types', 'CANCELLED', 1, 'CANCELLED'),
  ]
  const onHead = (checks: readonly CheckContext[]): GhReplies =>
    replies({
      viewPullRequestDetail: {
        pullRequest: detail({ base: 'wktr-130-ws-sweep', checks }),
        unavailable: null,
        missing: false,
      },
      requiredContexts: { contexts: [], unavailable: null },
      listWorkflowRuns: {
        rows: [run({ conclusion: 'cancelled' }), run({ conclusion: 'success' })],
        unavailable: null,
      },
    })

  it('reads green, and reaches done, once the newer run passed', async () => {
    const checks = [
      ...SUPERSEDED,
      fromRun('vitest', 'SUCCESS', 2, 'SUCCESS'),
      fromRun('types', 'SUCCESS', 2, 'SUCCESS'),
    ]

    const fresh = await reportOf(['178'], onHead(checks))
    const finished = await reportOf(['178', '--round', '2', '--rot-checked'], onHead(checks))

    expect(fresh.contextsFrom).toBe('head')
    expect(fresh.contexts.map((context) => [context.name, context.verdict])).toEqual([
      ['vitest', 'success'],
      ['types', 'success'],
    ])
    expect(fresh.verdict).toBe('green')
    expect(finished.state).toBe('done')
  })

  it('is pending, not red, while the newer run has not made a required check', async () => {
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ checks: [...SUPERSEDED, fromRun('lint', null, 2, null)] }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: ['vitest', 'types'], unavailable: null },
      }),
    )

    expect(report.contexts.map((context) => context.verdict)).toEqual(['pending', 'pending'])
    expect(report.verdict).toBe('pending')
    expect(report.state).toBe('ci-pending')
  })

  it('stays red when no newer run of the workflow follows the cancelled one', async () => {
    const report = await reportOf(['178'], onHead(SUPERSEDED.slice(1)))

    expect(report.verdict).toBe('red')
    expect(report.state).toBe('red')
  })

  it('drops a matrix placeholder from the head list even with no newer run', async () => {
    const report = await reportOf(
      ['178'],
      onHead([
        fromRun(`ab-style (\${{ matrix.style }})`, 'SKIPPED', 1, 'SUCCESS'),
        fromRun('vitest', 'SUCCESS', 1, 'SUCCESS'),
      ]),
    )

    expect(report.contexts.map((context) => context.name)).toEqual(['vitest'])
  })
})

describe('what it does with a read that fell short', () => {
  it('names no state when the pull request itself was read only in part', async () => {
    // A thread list longer than one page reads as fewer unresolved threads
    // than there are. A report that believed it would reach done on a
    // pull request somebody still waits on.
    const report = await reportOf(
      ['178', '--round', '2', '--rot-checked'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail(),
          unavailable: 'pull request 178 has more review threads than the 100 this reads',
          missing: false,
        },
      }),
    )

    expect(report.unresolvedThreads).toBe(0)
    expect(report.verdict).toBe('unavailable')
    expect(report.state).toBeNull()
    expect(report.unavailable).toEqual([
      'pull request 178 has more review threads than the 100 this reads',
    ])
  })

  it('reports a pull request GitHub named NOT_FOUND as awaiting-pr, and exits 0', async () => {
    // `missing` is true only when GraphQL itself said the number does not
    // exist. That is a state the loop has a name for.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: null,
          unavailable: 'pull request 178 could not be read: Could not resolve to a PullRequest',
          missing: true,
        },
      }),
    )

    expect(report.state).toBe('awaiting-pr')
    expect(report.verdict).toBe('unavailable')
    // Neither source: no pull request means no base branch to ask about, so
    // no list was asked for. To say `ruleset` would claim an empty answer
    // from a question nobody put.
    expect(report.contextsFrom).toBe('unread')
    expect(report.title).toBeNull()
    expect(report.unresolvedThreads).toBe(0)
    expect(report.unavailable).toEqual([
      'pull request 178 could not be read: Could not resolve to a PullRequest',
    ])
  })

  it('names no state, never awaiting-pr, for a failed read that was not NOT_FOUND', async () => {
    // A read gh refused is not a report that the number does not exist.
    // Neither is a malformed reply or an unresolved repository. Only
    // `missing` says that. Here it is false.
    const report = await reportOf(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: null,
          unavailable: 'gh: HTTP 500',
          missing: false,
        },
      }),
    )

    expect(report.state).toBeNull()
    expect(report.verdict).toBe('unavailable')
    expect(report.unavailable).toEqual(['gh: HTTP 500'])
  })

  it('leads with "The state below holds" when a state was named despite a short reason', async () => {
    // A read can fall short without a cost to the answer. The verdict
    // deliberately leaves out the wait hint's own sample. So the report
    // still names a state. The text must then say the state holds, not
    // that the whole report is incomplete.
    const gh = createGhMock(replies())
    const answer = await runPrState(['178'], {
      gh: {
        ...gh,
        listWorkflowRuns: async (query = {}) => {
          if (query.branch !== undefined) return { rows: [run()], unavailable: null }
          return { rows: [], unavailable: 'gh: API rate limit exceeded' }
        },
      },
    })

    expect(answer.outcome === 'ok' && answer.value).toContain('The state below holds')
    expect(answer.outcome === 'ok' && answer.value).toContain('gh: API rate limit exceeded')
    expect(answer.outcome === 'ok' && answer.value).not.toMatch(/^INCOMPLETE:/)
  })

  it('leads with INCOMPLETE, never "The state below holds", for a failed read with a good sample', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: { pullRequest: null, unavailable: 'gh: HTTP 500', missing: false },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toMatch(/^INCOMPLETE:/)
    expect(answer.outcome === 'ok' && answer.value).not.toContain('The state below holds')
  })

  it('asks nothing about rules or runs for a pull request it could not read', async () => {
    // There is no base and no head to ask about. To ask about a guess
    // would be worse than to ask nothing. An unregistered endpoint throws.
    const answer = await ran(['--json', '178'], {
      viewPullRequestDetail: { pullRequest: null, unavailable: 'not found', missing: false },
      listWorkflowRuns: { rows: [run()], unavailable: null },
    })

    expect(answer.outcome).toBe('ok')
  })

  for (const [what, overrides] of [
    ['the rules', { requiredContexts: { contexts: [], unavailable: 'gh: HTTP 403' } }],
    ['the runs', { listWorkflowRuns: { rows: [], unavailable: 'gh: HTTP 403' } }],
  ] as const) {
    it(`names no state at all when ${what} could not be read`, async () => {
      // A state is an instruction to the caller. To name one from facts
      // nobody could read would send a round to review a pull request
      // whose checks nobody has seen.
      const report = await reportOf(['178'], replies(overrides))

      expect(report.verdict).toBe('unavailable')
      expect(report.state).toBeNull()
      expect(report.unavailable).toContain('gh: HTTP 403')
    })
  }

  it('keeps the wait hint out of the verdict when only the sample failed', async () => {
    const gh = createGhMock(replies())
    const answer = await runPrState(['--json', '178'], {
      gh: {
        ...gh,
        listWorkflowRuns: async (query = {}) => {
          if (query.branch !== undefined) return { rows: [run()], unavailable: null }
          return { rows: [], unavailable: 'gh: API rate limit exceeded' }
        },
      },
    })

    expect(answer.outcome).toBe('ok')
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as PrStateReport
    expect(report.verdict).toBe('green')
    expect(report.waitHint).toBeNull()
    expect(report.unavailable).toEqual(['gh: API rate limit exceeded'])
  })

  it('fails, writing nothing to stdout, when nothing at all could be read', async () => {
    const answer = await ran(['178'], {
      viewPullRequestDetail: {
        pullRequest: null,
        unavailable: 'gh: could not resolve',
        missing: false,
      },
      listWorkflowRuns: { rows: [], unavailable: 'gh: could not resolve' },
    })

    expect(answer.outcome).toBe('failed')
    expect(answer.outcome !== 'ok' && answer.error).toBe(
      'pr-state read nothing about #178: gh: could not resolve; gh: could not resolve',
    )
  })

  it('still reports awaiting-pr, not a failed read, when the wait-hint sample also fails', async () => {
    // GitHub already gave a complete answer: the number does not exist.
    // An unrelated read failing beside it must not turn that answer into
    // "nothing at all could be read".
    const answer = await ran(['--json', '178'], {
      viewPullRequestDetail: {
        pullRequest: null,
        unavailable: 'pull request 178 could not be read: Could not resolve to a PullRequest',
        missing: true,
      },
      listWorkflowRuns: { rows: [], unavailable: 'gh: API rate limit exceeded' },
    })

    expect(answer.outcome).toBe('ok')
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as PrStateReport
    expect(report.state).toBe('awaiting-pr')
  })

  it('lets a thrown endpoint through rather than reporting a state it did not read', async () => {
    // Every endpoint this command uses answers, rather than throw. So a
    // throw here means the double found an endpoint the test did not
    // register.
    await expect(ran(['178'], { viewPullRequestDetail: ghFails('gh: HTTP 500') })).rejects.toThrow(
      'gh: HTTP 500',
    )
  })
})

describe('the state the facts add up to', () => {
  const facts = (overrides: Parameters<typeof deriveState>[0]) => deriveState(overrides)
  const green = {
    missing: false,
    pullRequestState: 'OPEN',
    verdict: 'green',
    unresolvedThreads: 0,
    round: 0,
    substantial: false,
    logicSinceRound1: false,
    rotChecked: false,
  } as const

  for (const [expected, overrides] of [
    ['awaiting-pr', { missing: true }],
    ['review-1', {}],
    ['fixing', { round: 1, verdict: 'pending' }],
    ['fixing', { round: 1, verdict: 'red' }],
    ['no-run', { round: 2, verdict: 'no-run' }],
    ['review-2', { round: 1, substantial: true }],
    ['rot-check', { round: 1, substantial: false }],
    ['rot-check', { round: 2, substantial: true }],
    ['done', { round: 1, rotChecked: true }],
    ['done', { round: 2, substantial: true, rotChecked: true }],
    ['fixing', { round: 2, rotChecked: true, unresolvedThreads: 1 }],
    ['merged', { pullRequestState: 'MERGED' }],
    ['closed', { pullRequestState: 'CLOSED' }],
  ] as const) {
    it(`is ${expected} for ${JSON.stringify(overrides)}`, () => {
      expect(facts({ ...green, ...overrides })).toBe(expected as LoopState)
    })
  }

  it('is no-run before it is anything a round would act on', () => {
    expect(facts({ ...green, verdict: 'no-run' })).toBe('no-run')
  })

  it('names no state when the verdict is unavailable, whatever round it is', () => {
    expect(facts({ ...green, verdict: 'unavailable', round: 2 })).toBeNull()
  })

  it('never schedules a third round', () => {
    // The two-round ceiling: a substantial round 2 does not buy a round
    // 3.
    expect(facts({ ...green, round: 2, substantial: true })).toBe('rot-check')
  })

  it('keeps an unresolved review thread out of done however green CI is', () => {
    expect(facts({ ...green, round: 1, unresolvedThreads: 1, rotChecked: true })).toBe('fixing')
  })

  it('names merged before the CI rule, whatever the verdict is', () => {
    expect(facts({ ...green, pullRequestState: 'MERGED', verdict: 'red' })).toBe('merged')
  })

  it('names closed before the review-thread rule, whatever markers say', () => {
    expect(
      facts({
        ...green,
        pullRequestState: 'CLOSED',
        round: 2,
        unresolvedThreads: 1,
        substantial: true,
        rotChecked: true,
      }),
    ).toBe('closed')
  })

  it('names awaiting-pr over merged or closed: a missing number never carries a state', () => {
    expect(facts({ ...green, missing: true, pullRequestState: 'MERGED' })).toBe('awaiting-pr')
  })

  it('names merged before the unavailable rule, when the checks themselves could not be read', () => {
    // #277, round 11 review: a mutation that moved the merged and closed
    // checks below this rule left every other test green. This test pins
    // the order the code claims: merged wins even when nothing about CI
    // could be read.
    expect(facts({ ...green, pullRequestState: 'MERGED', verdict: 'unavailable' })).toBe('merged')
  })

  it('names closed before the unavailable rule, when the checks themselves could not be read', () => {
    expect(facts({ ...green, pullRequestState: 'CLOSED', verdict: 'unavailable' })).toBe('closed')
  })

  it('carries the caller’s three inputs into the report', async () => {
    const report = await reportOf(['178', '--round', '1', '--substantial', '--rot-checked'])

    expect(report.round).toBe(1)
    expect(report.substantial).toBe(true)
    expect(report.rotChecked).toBe(true)
    expect(report.state).toBe('review-2')
  })
})

describe('logic after the round 1 head (#356)', () => {
  const ROUND_1_HEAD = 'dda20bc0d4ffa930f6b84b5128a2273260e26377'
  const compared = (overrides: Partial<CommitComparison> = {}): GhReplies =>
    replies({
      compareCommits: {
        comparison: { status: 'ahead', files: [], filesAtLimit: false, ...overrides },
        unavailable: null,
      },
    })
  const round1 = ['178', '--round', '1', '--round-1-head', ROUND_1_HEAD]

  it('is review-2 when a commit after the round 1 head changed logic', async () => {
    const report = await reportOf(
      round1,
      compared({ files: ['plugins/workstreams/src/subcommands/pr-state.ts', 'README.md'] }),
    )

    expect(report.state).toBe('review-2')
    expect(report.round1Head).toBe(ROUND_1_HEAD)
    expect(report.sinceRound1).toEqual({
      logic: true,
      reason: 'logic changed: plugins/workstreams/src/subcommands/pr-state.ts',
    })
    expect(report.unavailable).toEqual([])
  })

  it('is review-2 for logic after the round 1 head even once the rot check is done', async () => {
    const report = await reportOf([...round1, '--rot-checked'], compared({ files: ['lib/gh.ts'] }))

    expect(report.state).toBe('review-2')
  })

  it('is rot-check when only prose and tests changed after the round 1 head', async () => {
    const report = await reportOf(
      round1,
      compared({
        files: [
          'plugins/workstreams/README.md',
          'docs/flows/workstreams/review/pr-state-flow.md',
          'tests/lib/gh.test.ts',
          'tests/plugins/workstreams/subcommands/pr-state.test.ts',
        ],
      }),
    )

    expect(report.state).toBe('rot-check')
    expect(report.sinceRound1).toEqual({
      logic: false,
      reason: 'no logic changed under src/, lib/, scripts/ or hooks/',
    })
  })

  it('is done when nothing changed after the round 1 head and the rot check is done', async () => {
    const report = await reportOf([...round1, '--rot-checked'], compared({ status: 'identical' }))

    expect(report.state).toBe('done')
  })

  for (const status of ['diverged', 'behind'] as const) {
    it(`is review-2 when the round 1 head is not an ancestor (${status}), whatever changed`, async () => {
      // A rebase moves the head off the round 1 head. Its files list then
      // compares two lines of history, and proves nothing.
      const report = await reportOf(round1, compared({ status, files: ['README.md'] }))

      expect(report.state).toBe('review-2')
      expect(report.sinceRound1).toEqual({
        logic: true,
        reason: `the round 1 head is not an ancestor of the head (${status})`,
      })
    })
  }

  it('is review-2 when the files list is at GitHub’s limit, even with no logic in it', async () => {
    const report = await reportOf(round1, compared({ files: ['README.md'], filesAtLimit: true }))

    expect(report.state).toBe('review-2')
    expect(report.sinceRound1?.reason).toBe("the compare lists GitHub's limit of changed files")
  })

  it('names no state when the compare could not be read, and says why', async () => {
    const report = await reportOf(
      round1,
      replies({
        compareCommits: { comparison: null, unavailable: 'gh: API rate limit exceeded' },
      }),
    )

    expect(report.state).toBeNull()
    expect(report.sinceRound1).toBeNull()
    expect(report.unavailable).toEqual(['gh: API rate limit exceeded'])
  })

  it('keeps a state that does not depend on the compare when the compare fails', async () => {
    const report = await reportOf(
      round1,
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ unresolvedThreads: [{ author: 'brianespinosa', bot: false }] }),
          unavailable: null,
          missing: false,
        },
        compareCommits: { comparison: null, unavailable: 'gh: API rate limit exceeded' },
      }),
    )

    expect(report.state).toBe('fixing')
  })

  it('compares the round 1 head as the base and the current head as the head', async () => {
    // A double that answers by its arguments: the other order is a
    // different compare (`behind` for `ahead`), and gets no answer here.
    const gh = {
      ...createGhMock(replies()),
      compareCommits: async (query: { readonly base: string; readonly head: string }) =>
        query.base === ROUND_1_HEAD && query.head === '9b13a20'
          ? {
              comparison: { status: 'ahead', files: [], filesAtLimit: false } as const,
              unavailable: null,
            }
          : { comparison: null, unavailable: `asked for ${query.base}...${query.head}` },
    }

    const answer = await runPrState(['--json', ...round1], { gh })

    expect(answer.outcome === 'ok' && (JSON.parse(answer.value) as PrStateReport).state).toBe(
      'rot-check',
    )
  })

  it('still gives review-2 for --substantial, and reads no compare', async () => {
    // Nothing is registered for compareCommits: a read would throw.
    const report = await reportOf([...round1, '--substantial'])

    expect(report.state).toBe('review-2')
    expect(report.sinceRound1).toBeNull()
  })

  it('reads no compare without --round-1-head, and is rot-check as before', async () => {
    const report = await reportOf(['178', '--round', '1'])

    expect(report.state).toBe('rot-check')
    expect(report.round1Head).toBeNull()
    expect(report.sinceRound1).toBeNull()
  })

  it('reads no compare for a pull request it could not read', async () => {
    const report = await reportOf(
      round1,
      replies({
        viewPullRequestDetail: { pullRequest: null, unavailable: 'gh: HTTP 502', missing: false },
      }),
    )

    expect(report.state).toBeNull()
    expect(report.unavailable).toEqual(['gh: HTTP 502'])
  })

  for (const round of ['0', '2'] as const) {
    it(`refuses --round-1-head with --round ${round}`, async () => {
      const answer = await ran(['178', '--round', round, '--round-1-head', ROUND_1_HEAD], {})

      expect(answer).toEqual({
        outcome: 'refused',
        error: '--round-1-head names the head round 1 reviewed, so it holds only with --round 1',
      })
    })
  }

  it('refuses --round-1-head with no --round, which is round 0', async () => {
    const answer = await ran(['178', '--round-1-head', ROUND_1_HEAD], {})

    expect(answer.outcome).toBe('refused')
  })

  for (const value of ['Head', 'dda20bc.', 'dda20b', 'DDA20BC', `${ROUND_1_HEAD}0`] as const) {
    it(`refuses --round-1-head "${value}", which is not a commit sha`, async () => {
      const answer = await ran(['178', '--round', '1', '--round-1-head', value], {})

      expect(answer).toEqual({
        outcome: 'refused',
        error: `--round-1-head takes a commit sha, not "${value}"`,
      })
    })
  }

  it('accepts a short sha of seven characters', async () => {
    const report = await reportOf(['178', '--round', '1', '--round-1-head', 'dda20bc'], compared())

    expect(report.state).toBe('rot-check')
  })

  it('names the reason in the report a person reads', async () => {
    const answer = await ran(round1, compared({ files: ['lib/gh.ts'] }))

    expect(answer.outcome === 'ok' && answer.value).toContain(
      'since round 1: logic changed: lib/gh.ts',
    )
  })

  it('says nothing about round 1 in the report a person reads when no compare was read', async () => {
    const answer = await ran(['178', '--round', '1'])

    expect(answer.outcome === 'ok' && answer.value).not.toContain('since round 1')
  })

  for (const [what, facts] of [
    ['red CI', { verdict: 'red', unresolvedThreads: 0 }],
    ['an unresolved thread', { verdict: 'green', unresolvedThreads: 1 }],
  ] as const) {
    it(`is fixing with ${what}, even with logic after the round 1 head`, () => {
      expect(
        deriveState({
          missing: false,
          pullRequestState: 'OPEN',
          round: 1,
          substantial: false,
          logicSinceRound1: true,
          rotChecked: false,
          ...facts,
        }),
      ).toBe('fixing')
    })
  }

  it('never schedules a third round from the compare', () => {
    expect(
      deriveState({
        missing: false,
        pullRequestState: 'OPEN',
        verdict: 'green',
        unresolvedThreads: 0,
        round: 2,
        substantial: false,
        logicSinceRound1: true,
        rotChecked: false,
      }),
    ).toBe('rot-check')
  })

  it('names a state at round 2 even with an unread compare fact', () => {
    expect(
      deriveState({
        missing: false,
        pullRequestState: 'OPEN',
        verdict: 'green',
        unresolvedThreads: 0,
        round: 2,
        substantial: false,
        logicSinceRound1: null,
        rotChecked: true,
      }),
    ).toBe('done')
  })

  describe('which paths are logic', () => {
    for (const path of [
      'src/a.ts',
      'lib/gh.ts',
      'scripts/workstreams.ts',
      'hooks/guard.ts',
      'plugins/workstreams/src/subcommands/pr-state.ts',
      'plugins/workstreams/scripts/workstreams.ts',
      'plugins/workstreams/hooks/guard.ts',
      'packages/eslint-plugin-claude/src/rules/a.ts',
      'plugins/workstreams/hooks/hooks.json',
      // A name that holds "test" or "spec" with no dot on each side is not
      // a test file.
      'src/latest.ts',
      'lib/contest.ts',
      'scripts/inspector.ts',
      'src/spec.ts',
      'src/test.ts',
    ]) {
      it(`counts ${path}`, () => {
        expect(isLogicPath(path)).toBe(true)
      })
    }

    for (const path of [
      'README.md',
      'lib/README.md',
      'plugins/workstreams/skills/start/SKILL.md',
      'tests/lib/gh.test.ts',
      'tests/lib/helpers.ts',
      'test/lib/gh.ts',
      'src/__tests__/a.ts',
      'src/a.test.ts',
      'src/a.spec.ts',
      'harness/gh.ts',
      'docs/flows/workstreams/review/pr-state-flow.md',
      'source/a.ts',
      'mylib/a.ts',
      'lib',
      'package.json',
    ]) {
      it(`does not count ${path}`, () => {
        expect(isLogicPath(path)).toBe(false)
      })
    }
  })
})

describe('the wait hint', () => {
  it('is scoped to the head’s own workflows by the command, not only by the helper', async () => {
    // The sample carries a slower workflow that never ran on this head. The
    // hint must still answer for the head's own, or a caller waits on a
    // number measured from a workflow it does not wait for.
    const gh = createGhMock(replies())
    const answer = await runPrState(['--json', '178'], {
      gh: {
        ...gh,
        listWorkflowRuns: async (query = {}) => {
          if (query.branch !== undefined) return { rows: [run({ name: 'CI' })], unavailable: null }
          return {
            rows: [
              run({ name: 'CI' }),
              run({
                name: 'Nightly',
                startedAt: '2026-09-22T06:00:00Z',
                updatedAt: '2026-09-22T07:00:00Z',
              }),
            ],
            unavailable: null,
          }
        },
      },
    })

    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as PrStateReport
    expect(report.waitHint?.workflow).toBe('CI')
  })

  it('is measured over the workflows that ran on THIS head', () => {
    // Measured over everything, the hint is whichever unrelated workflow
    // happens to be slowest: on the first live run here that was a `push`
    // workflow with one sample.
    const hint = waitHintFrom(
      [
        run({ name: 'CI', startedAt: '2026-09-22T06:00:00Z', updatedAt: '2026-09-22T06:02:00Z' }),
        run({ name: 'CI', startedAt: '2026-09-22T07:00:00Z', updatedAt: '2026-09-22T07:04:00Z' }),
        run({
          name: 'Push on main',
          startedAt: '2026-09-22T08:00:00Z',
          updatedAt: '2026-09-22T08:30:00Z',
        }),
      ],
      ['CI'],
    )

    expect(hint).toEqual({ workflow: 'CI', medianMs: 180_000, samples: 2 })
  })

  for (const order of ['quick first', 'slow first'] as const) {
    it(`answers for the slowest workflow whichever ran most recently (${order})`, () => {
      // The loop waits for the LAST context to report, so the answer must not
      // depend on which group the sample happened to name first.
      const quick = [
        run({
          name: 'quick',
          startedAt: '2026-09-22T06:00:00Z',
          updatedAt: '2026-09-22T06:00:20Z',
        }),
        run({
          name: 'quick',
          startedAt: '2026-09-22T07:00:00Z',
          updatedAt: '2026-09-22T07:00:20Z',
        }),
      ]
      const slow = [
        run({ name: 'slow', startedAt: '2026-09-22T08:00:00Z', updatedAt: '2026-09-22T08:05:00Z' }),
      ]
      const rows = order === 'quick first' ? [...quick, ...slow] : [...slow, ...quick]

      expect(waitHintFrom(rows, ['quick', 'slow'])?.workflow).toBe('slow')
    })
  }

  it('takes the middle of an odd sample', () => {
    const hint = waitHintFrom(
      [
        run({ startedAt: '2026-09-22T06:00:00Z', updatedAt: '2026-09-22T06:01:00Z' }),
        run({ startedAt: '2026-09-22T07:00:00Z', updatedAt: '2026-09-22T07:05:00Z' }),
        run({ startedAt: '2026-09-22T08:00:00Z', updatedAt: '2026-09-22T08:02:00Z' }),
      ],
      ['CI'],
    )

    expect(hint).toEqual({ workflow: 'CI', medianMs: 120_000, samples: 3 })
  })

  it('measures over everything when nothing has run on the head yet', () => {
    const hint = waitHintFrom([run({ name: 'anything' })], [])

    expect(hint?.workflow).toBe('anything')
  })

  for (const [what, row] of [
    ['a run that has not concluded', run({ conclusion: null })],
    ['a run whose timestamps do not parse', run({ updatedAt: 'whenever' })],
    [
      'a run that reports finishing before it started',
      run({ startedAt: '2026-09-22T08:00:00Z', updatedAt: '2026-09-22T07:00:00Z' }),
    ],
  ] as const) {
    it(`is not measured from ${what}`, () => {
      expect(waitHintFrom([row], [])).toBeNull()
    })
  }

  it('is null when there is nothing to measure at all', () => {
    expect(waitHintFrom([], [])).toBeNull()
  })
})

describe('the report a person reads', () => {
  it('leads with the state, the verdict and the head', async () => {
    const answer = await ran(['178'])

    expect(answer.outcome === 'ok' && answer.value).toContain(
      '#178  feat(workstreams): sweep command and skill (primitive 1)',
    )
    expect(answer.outcome === 'ok' && answer.value).toContain('state    review-1')
    expect(answer.outcome === 'ok' && answer.value).toContain(
      'head     wktr-130-ws-sweep at 9b13a20 (draft, MERGEABLE)',
    )
    expect(answer.outcome === 'ok' && answer.value).toContain('success  vitest  SUCCESS')
    expect(answer.outcome === 'ok' && answer.value).toContain('CI  completed  success')
    expect(answer.outcome === 'ok' && answer.value).toContain('comments: 1 (github-code-quality)')
    expect(answer.outcome === 'ok' && answer.value).toContain('wait hint: CI takes about 2m')
  })

  it('says a ready pull request is ready, and names a context still running', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            draft: false,
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
              { name: 'types', status: 'IN_PROGRESS', conclusion: null, startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain('(ready, MERGEABLE)')
    expect(answer.outcome === 'ok' && answer.value).toContain('pending  types  running')
  })

  it('names a required context nothing has reported', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            checks: [
              { name: 'vitest', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null },
            ],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain('pending  types  not reported')
  })

  it('says outright when no ruleset requires anything of the base', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({ base: 'topic' }),
          unavailable: null,
          missing: false,
        },
        requiredContexts: { contexts: [], unavailable: null },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain(
      'no ruleset requires a status check of topic, so the verdict below is over',
    )
    expect(answer.outcome === 'ok' && answer.value).toContain(
      'the 2 context(s) that have reported on the head instead',
    )
    expect(answer.outcome === 'ok' && answer.value).not.toMatch(/^INCOMPLETE:/)
  })

  it('leads with INCOMPLETE, and names no state, when a read fell short', async () => {
    const answer = await ran(
      ['178'],
      replies({ requiredContexts: { contexts: [], unavailable: 'gh: HTTP 403' } }),
    )

    expect(answer.outcome === 'ok' && answer.value).toMatch(/^INCOMPLETE:/)
    expect(answer.outcome === 'ok' && answer.value).toContain('  gh: HTTP 403')
    expect(answer.outcome === 'ok' && answer.value).toContain(
      'state    not derivable from what could be read',
    )
  })

  it('prints the pull request’s number and nothing it could not read', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: { pullRequest: null, unavailable: 'not found', missing: false },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain('#178  (unread)')
    expect(answer.outcome === 'ok' && answer.value).not.toContain('head     ')
  })

  it('names several samples as runs', async () => {
    const answer = await ran(
      ['178'],
      replies({
        listWorkflowRuns: {
          rows: [run(), run({ updatedAt: '2026-09-22T06:33:20Z' })],
          unavailable: null,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain('(2 recent runs)')
  })

  it('prints no wait hint when there was nothing to measure', async () => {
    const answer = await ran(
      ['178'],
      replies({ listWorkflowRuns: { rows: [], unavailable: null } }),
    )

    expect(answer.outcome === 'ok' && answer.value).not.toContain('wait hint')
  })

  it('reports a run with no conclusion yet as exactly that', async () => {
    const answer = await ran(
      ['178'],
      replies({
        listWorkflowRuns: {
          rows: [run({ status: 'in_progress', conclusion: null })],
          unavailable: null,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain('CI  in_progress  no conclusion yet')
  })

  it('prints a short wait in seconds and names one sample as one run', async () => {
    const answer = await ran(
      ['178'],
      replies({
        listWorkflowRuns: {
          rows: [run({ updatedAt: '2026-09-22T06:31:47Z' })],
          unavailable: null,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain(
      'wait hint: CI takes about 30s (1 recent run)',
    )
  })

  it('names every distinct author once', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [
              { author: 'reviewer-a', bot: false },
              { author: 'reviewer-a', bot: false },
            ],
            commentAuthors: [],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    expect(answer.outcome === 'ok' && answer.value).toContain(
      'unresolved review threads: 2 (reviewer-a)',
    )
    expect(answer.outcome === 'ok' && answer.value).toContain('comments: 0')
  })

  it('names the bot threads on their own line, apart from the ones that hold fixing', async () => {
    const answer = await ran(
      ['178'],
      replies({
        viewPullRequestDetail: {
          pullRequest: detail({
            unresolvedThreads: [
              { author: 'github-actions', bot: true },
              { author: 'reviewer-a', bot: false },
            ],
            commentAuthors: [],
          }),
          unavailable: null,
          missing: false,
        },
      }),
    )

    const text = answer.outcome === 'ok' ? answer.value : ''
    expect(text).toContain('unresolved review threads: 1 (reviewer-a)')
    expect(text).toContain('bot threads (informational, not waited on): 1 (github-actions)')
  })

  it('says nothing about bot threads when there are none', async () => {
    const answer = await ran(['178'])

    const text = answer.outcome === 'ok' ? answer.value : ''
    expect(text).not.toContain('bot threads')
  })
})
