// The stack reads and the stack merge of the real `gh` client (#469):
// `listOpenStacks`, `mergeMethods` and `mergeStack`. The client takes the
// process runner as a parameter, so a stand-in answers for `gh`, and nothing
// here reaches GitHub. The shapes come from real answers on 2026-10-20: the
// stack of #470 and #471 in this repository, its merge settings and rules,
// and the probe repository of ruling 3 on #469.
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

const REPO = result({ stdout: '{"nameWithOwner":"bje-settings/claude"}' })

interface Call {
  readonly args: readonly string[]
  readonly cwd: string | undefined
}

/** A client whose runner answers each call from `replies` in order, and
 *  records every call. The last reply repeats. */
const clientAnswering = (
  replies: readonly RunResult[],
  options: { cwd?: string; repository?: string } = {},
): { gh: GhClient; calls: Call[] } => {
  const calls: Call[] = []
  const run: Runner = async (_command, args = [], spawn) => {
    calls.push({ args, cwd: spawn?.cwd })
    return replies[Math.min(calls.length - 1, replies.length - 1)] as RunResult
  }
  return { gh: createGhClient({ ...options, run }), calls }
}

/** One page of open pull requests, as gh prints it. */
const page = (nodes: readonly unknown[]) =>
  result({
    stdout: JSON.stringify({
      data: {
        repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
      },
    }),
  })

/** One open pull request and its stack, as the real stack 472 answered. */
const stacked = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  stack: {
    number: 472,
    baseRefName: 'main',
    entries: {
      totalCount: 2,
      nodes: [
        { position: 2, pullRequest: { number: 471, state: 'OPEN' } },
        { position: 1, pullRequest: { number: 470, state: 'MERGED' } },
      ],
    },
    ...overrides,
  },
})

const STACK_472 = {
  number: 472,
  base: 'main',
  layers: [
    { number: 470, state: 'MERGED' },
    { number: 471, state: 'OPEN' },
  ],
}

describe('listOpenStacks', () => {
  it('reads each stack once, bottom first, and passes a pull request in no stack', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      page([stacked(471), { number: 468, stack: null }, stacked(470)]),
    ])

    const answer = await gh.listOpenStacks()

    expect(calls[1]?.args.at(-1)).toContain(
      'stack { number baseRefName entries(first: 100) { totalCount nodes { position pullRequest { number state } } } }',
    )
    expect(calls[1]?.args.at(-1)).toContain('pullRequests(states: OPEN')
    expect(answer).toEqual({ rows: [STACK_472], unavailable: null })
  })

  for (const [what, node] of [
    ['a row with no number', { ...stacked(471), number: null }],
    ['a row with no stack field', { number: 471 }],
    ['a stack with no number', stacked(471, { number: null })],
    ['a stack with no base', stacked(471, { baseRefName: null })],
    ['a stack whose entries are not a connection', stacked(471, { entries: { totalCount: 2 } })],
    [
      'a stack with more entries than were read',
      stacked(471, {
        entries: {
          totalCount: 3,
          nodes: [{ position: 1, pullRequest: { number: 470, state: 'OPEN' } }],
        },
      }),
    ],
    [
      'an entry with no pull request',
      stacked(471, { entries: { totalCount: 1, nodes: [{ position: 1, pullRequest: null }] } }),
    ],
    [
      'an entry with no position',
      stacked(471, {
        entries: {
          totalCount: 1,
          nodes: [{ position: null, pullRequest: { number: 470, state: 'OPEN' } }],
        },
      }),
    ],
    [
      'an entry whose state is not a state',
      stacked(471, {
        entries: {
          totalCount: 1,
          nodes: [{ position: 1, pullRequest: { number: 470, state: 'DRAFT' } }],
        },
      }),
    ],
  ] as const) {
    it(`counts ${what} as a short read, never as a stack`, async () => {
      const { gh } = clientAnswering([REPO, page([node])])

      await expect(gh.listOpenStacks()).resolves.toEqual({
        rows: [],
        unavailable: '1 pullRequests row(s) could not be read',
      })
    })
  }

  it('reports a repository it could not resolve, with no rows', async () => {
    const { gh } = clientAnswering([result({ status: 1, stderr: 'gh: Not Found (HTTP 404)\n' })])

    await expect(gh.listOpenStacks()).resolves.toEqual({
      rows: [],
      unavailable: 'gh: Not Found (HTTP 404)',
    })
  })
})

/** The merge settings of this repository, as GraphQL answered them. */
const settings = (flags: Record<string, unknown> = {}) =>
  result({
    stdout: JSON.stringify({
      data: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          ...flags,
        },
      },
    }),
  })

/** A `pull_request` rule, as the rules of `main` answered it. */
const pullRule = (parameters: Record<string, unknown>) => ({
  type: 'pull_request',
  ruleset_source: 'bje',
  parameters: {
    required_approving_review_count: 0,
    require_code_owner_review: false,
    required_review_thread_resolution: false,
    require_last_push_approval: false,
    ...parameters,
  },
})

const rules = (...entries: readonly unknown[]) => result({ stdout: JSON.stringify(entries) })

describe('mergeMethods', () => {
  it('answers the methods that both the settings and the rules allow', async () => {
    const { gh, calls } = clientAnswering([
      REPO,
      settings(),
      REPO,
      rules(
        { type: 'deletion' },
        pullRule({ allowed_merge_methods: ['merge', 'squash', 'rebase'] }),
      ),
    ])

    const answer = await gh.mergeMethods({ branch: 'wktr-461/a' })

    expect(calls[1]?.args.at(-1)).toContain(
      'mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed',
    )
    expect(calls[3]?.args).toEqual(['api', 'repos/bje-settings/claude/rules/branches/wktr-461%2Fa'])
    expect(answer).toEqual({ methods: ['merge', 'squash'], unavailable: null })
  })

  it('keeps only a method that every pull_request rule allows; a rule with no list limits nothing', async () => {
    const { gh } = clientAnswering([
      REPO,
      settings({ rebaseMergeAllowed: true }),
      REPO,
      rules(
        pullRule({ allowed_merge_methods: ['squash', 'rebase'] }),
        pullRule({}),
        pullRule({ allowed_merge_methods: ['rebase', 'merge'] }),
      ),
    ])

    await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
      methods: ['rebase'],
      unavailable: null,
    })
  })

  it('reads a plan limit as no rule, so the settings decide', async () => {
    const { gh } = clientAnswering([
      REPO,
      settings(),
      REPO,
      result({
        status: 1,
        stdout: JSON.stringify({
          message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
          status: '403',
        }),
      }),
    ])

    await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
      methods: ['merge', 'squash'],
      unavailable: null,
    })
  })

  it('answers no methods when the settings carry an error', async () => {
    const { gh } = clientAnswering([
      REPO,
      result({
        status: 1,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ message: 'Resource not accessible by integration' }],
        }),
        stderr: 'gh: Resource not accessible by integration\n',
      }),
    ])

    await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
      methods: null,
      unavailable: 'gh: Resource not accessible by integration',
    })
  })

  it('answers no methods when a setting is not a boolean', async () => {
    const { gh } = clientAnswering([REPO, settings({ squashMergeAllowed: null })])

    await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
      methods: null,
      unavailable: 'the merge settings of the repository could not be read',
    })
  })

  it('answers no methods when the rules could not be read', async () => {
    const { gh } = clientAnswering([
      REPO,
      settings(),
      REPO,
      result({ status: 1, stdout: '', stderr: 'gh: HTTP 502\n' }),
    ])

    await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
      methods: null,
      unavailable: 'gh: HTTP 502',
    })
  })

  for (const [what, reply] of [
    ['rules that are not a list', result({ stdout: '{"message":"Not Found"}' })],
    ['a list of methods that is not a list', rules(pullRule({ allowed_merge_methods: 'squash' }))],
  ] as const) {
    it(`answers no methods for ${what}`, async () => {
      const { gh } = clientAnswering([REPO, settings(), REPO, reply])

      await expect(gh.mergeMethods({ branch: 'main' })).resolves.toEqual({
        methods: null,
        unavailable: 'the merge methods of the rules for main could not be read',
      })
    })
  }
})

describe('mergeStack', () => {
  it('runs gh stack merge in the checkout, with no --repo, and keeps what gh said', async () => {
    const { gh, calls } = clientAnswering(
      [
        result({
          stdout: 'Merging #1, #2 into main via squash...\n✓ Merged #1, #2 into main (e98cf21)\n',
        }),
      ],
      { cwd: '/work/probe', repository: 'brianespinosa/probe' },
    )

    const answer = await gh.mergeStack({ stack: 3, method: 'squash' })

    expect(calls[0]).toEqual({
      args: ['stack', 'merge', '3', '--yes', '--squash'],
      cwd: '/work/probe',
    })
    expect(answer).toEqual({
      accepted: true,
      output: 'Merging #1, #2 into main via squash...\n✓ Merged #1, #2 into main (e98cf21)',
    })
  })

  it('reports a refusal in gh’s own words, and never throws', async () => {
    // The probe's refusal of a stack whose bottom was a draft, on stderr,
    // exit 5.
    const { gh } = clientAnswering([
      result({
        status: 5,
        stderr: '✗ pull request #4 is a draft; mark it ready for review before merging\n',
      }),
    ])

    await expect(gh.mergeStack({ stack: 6, method: 'merge' })).resolves.toEqual({
      accepted: false,
      output: '✗ pull request #4 is a draft; mark it ready for review before merging',
    })
  })

  it('reads a status of 0 whose output broke as a merge GitHub took, with what broke', async () => {
    const { gh } = clientAnswering([
      result({ streamErrors: [{ code: 'EPIPE', message: 'write EPIPE' }] }),
    ])

    await expect(gh.mergeStack({ stack: 6, method: 'rebase' })).resolves.toEqual({
      accepted: true,
      output: "gh's output could not be read: EPIPE, write EPIPE",
    })
  })

  it('reads a gh that a signal killed as not accepted, with the signal', async () => {
    // A signal leaves no status. Only a status of 0 is a merge GitHub took.
    const { gh } = clientAnswering([result({ status: null, signal: 'SIGKILL' })])

    await expect(gh.mergeStack({ stack: 6, method: 'squash' })).resolves.toEqual({
      accepted: false,
      output: 'gh was killed by SIGKILL',
    })
  })

  it('reports a gh that could not start', async () => {
    const { gh } = clientAnswering([
      result({
        status: 127,
        startFailure: { code: 'ENOENT', message: 'spawn gh ENOENT' },
      }),
    ])

    await expect(gh.mergeStack({ stack: 6, method: 'squash' })).resolves.toEqual({
      accepted: false,
      output: 'cannot run gh: spawn gh ENOENT',
    })
  })
})
