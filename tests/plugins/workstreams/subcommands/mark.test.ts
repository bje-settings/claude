// The mark command. Every arm in process: the `gh` client is injected, so
// nothing is spawned. An endpoint with no registration throws and names
// itself, which pins that a refusal reads nothing and writes nothing.
import { describe, expect, it } from 'vitest'

import {
  createGhMock,
  type GhClient,
  type GhReplies,
  ghFails,
  type PullRequestDetail,
} from '#harness/gh.ts'
import { DESCRIPTION_LIMIT, HELP, runMark } from '#workstreams/subcommands/mark.ts'

const HEAD = '9b13a20ab347d9c3e2053ce90f94ed3090cb36fe'
const OTHER = 'a'.repeat(40)

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 178,
  title: 'refactor(workstreams): record review rounds as commit statuses',
  state: 'OPEN',
  draft: true,
  base: 'main',
  head: 'wktr-377-review-statuses',
  headSha: HEAD,
  mergeable: 'MERGEABLE',
  checks: [],
  unresolvedThreads: [],
  commentAuthors: [],
  ...overrides,
})

/** The write a run asked for. */
type Write = Parameters<GhClient['createCommitStatus']>[0]

/** A client whose write keeps what it was asked to write, so a test asserts
 *  the effect, the status, not a call log. */
const recording = (replies: GhReplies) => {
  const written: Write[] = []
  const gh: GhClient = {
    ...createGhMock(replies),
    createCommitStatus: async (status) => {
      written.push(status)
      return { id: 1 }
    },
  }
  return { gh, written }
}

const viewed: GhReplies = {
  viewPullRequestDetail: { pullRequest: detail(), unavailable: null, missing: false },
}

describe('the command line', () => {
  for (const flag of ['--help', '-h']) {
    it(`prints its own usage for ${flag}, without asking gh anything`, async () => {
      await expect(runMark([flag], { gh: createGhMock() })).resolves.toEqual({
        outcome: 'ok',
        value: HELP,
      })
    })
  }

  for (const [what, argv, reason] of [
    ['no words', [], 'mark takes a pull request number and a name, not 0 words'],
    ['a number alone', ['178'], 'mark takes a pull request number and a name, not 1 words'],
    [
      'three words',
      ['178', 'review-1', 'extra'],
      'mark takes a pull request number and a name, not 3 words',
    ],
    ['a word for a number', ['main', 'review-1'], 'mark takes a pull request number, not "main"'],
    ['a zero', ['0', 'review-1'], 'mark takes a pull request number, not "0"'],
    [
      'an unknown name',
      ['178', 'review-3'],
      'mark takes one of review-1, review-2, rot-check, layer, not "review-3"',
    ],
    [
      'a name with the prefix',
      ['178', 'workstreams/review-1'],
      'mark takes one of review-1, review-2, rot-check, layer, not "workstreams/review-1"',
    ],
    [
      'a short --head',
      ['178', 'review-1', '--head', '9b13a20'],
      '--head takes a full 40-character commit sha, not "9b13a20"',
    ],
    [
      'a --head that is not hex',
      ['178', 'review-1', '--head', 'g'.repeat(40)],
      `--head takes a full 40-character commit sha, not "${'g'.repeat(40)}"`,
    ],
  ] as const) {
    it(`refuses ${what}, and reads and writes nothing`, async () => {
      // Nothing is registered: a read or a write would throw.
      await expect(runMark(argv, { gh: createGhMock() })).resolves.toEqual({
        outcome: 'refused',
        error: reason,
      })
    })
  }

  it(`refuses a description over ${DESCRIPTION_LIMIT} characters, before any read`, async () => {
    const answer = await runMark(
      ['178', 'review-1', '--description', 'x'.repeat(DESCRIPTION_LIMIT + 1)],
      { gh: createGhMock() },
    )

    expect(answer).toEqual({
      outcome: 'refused',
      error: `--description is ${DESCRIPTION_LIMIT} characters at most, not ${DESCRIPTION_LIMIT + 1}`,
    })
  })

  it(`accepts a description of exactly ${DESCRIPTION_LIMIT} characters`, async () => {
    const { gh, written } = recording(viewed)
    const description = 'x'.repeat(DESCRIPTION_LIMIT)

    const answer = await runMark(['178', 'review-1', '--description', description], { gh })

    expect(answer.outcome).toBe('ok')
    expect(written[0]?.description).toBe(description)
  })

  it('refuses an undeclared flag', async () => {
    const answer = await runMark(['178', 'review-1', '--state', 'failure'], { gh: createGhMock() })

    expect(answer.outcome).toBe('refused')
  })
})

describe('the write', () => {
  for (const name of ['review-1', 'review-2', 'rot-check', 'layer'] as const) {
    it(`writes workstreams/${name}, success, on the pull request's head`, async () => {
      const { gh, written } = recording(viewed)

      const answer = await runMark(['178', name], { gh })

      expect(answer).toEqual({
        outcome: 'ok',
        value: `workstreams/${name} success on ${HEAD} (#178)`,
      })
      expect(written).toEqual([{ sha: HEAD, context: `workstreams/${name}`, state: 'success' }])
    })
  }

  it('sends the description it was given', async () => {
    const { gh, written } = recording(viewed)

    await runMark(['178', 'review-1', '--description', 'substantial'], { gh })

    expect(written).toEqual([
      { sha: HEAD, context: 'workstreams/review-1', state: 'success', description: 'substantial' },
    ])
  })

  it('writes on --head, and reads no pull request', async () => {
    // No detail is registered: a read would throw.
    const { gh, written } = recording({})

    const answer = await runMark(['178', 'rot-check', '--head', OTHER], { gh })

    expect(answer).toEqual({
      outcome: 'ok',
      value: `workstreams/rot-check success on ${OTHER} (#178)`,
    })
    expect(written.map((status) => status.sha)).toEqual([OTHER])
  })

  it('writes on the head of a pull request whose lists ran past one page', async () => {
    const { gh, written } = recording({
      viewPullRequestDetail: {
        pullRequest: detail(),
        unavailable: 'pull request 178 has more comments than the 100 this reads',
        missing: false,
      },
    })

    const answer = await runMark(['178', 'review-2'], { gh })

    expect(answer.outcome).toBe('ok')
    expect(written.map((status) => status.sha)).toEqual([HEAD])
  })
})

describe('what stops the write', () => {
  it('refuses a pull request that GitHub says does not exist, and writes nothing', async () => {
    const { gh, written } = recording({
      viewPullRequestDetail: {
        pullRequest: null,
        unavailable: 'pull request 99999 could not be read',
        missing: true,
      },
    })

    const answer = await runMark(['99999', 'review-1'], { gh })

    expect(answer).toEqual({ outcome: 'refused', error: 'pull request 99999 does not exist' })
    expect(written).toEqual([])
  })

  it('fails, and writes nothing, when the pull request could not be read', async () => {
    const { gh, written } = recording({
      viewPullRequestDetail: { pullRequest: null, unavailable: 'gh: HTTP 502', missing: false },
    })

    const answer = await runMark(['178', 'review-1'], { gh })

    expect(answer).toEqual({
      outcome: 'failed',
      error: 'mark could not read pull request 178: gh: HTTP 502',
    })
    expect(written).toEqual([])
  })

  it("fails with gh's own words when the write failed", async () => {
    const gh = createGhMock({
      ...viewed,
      createCommitStatus: ghFails('gh: HTTP 403: Resource not accessible by integration', 1),
    })

    const answer = await runMark(['178', 'review-1'], { gh })

    expect(answer).toEqual({
      outcome: 'failed',
      error: `mark could not write workstreams/review-1 on ${HEAD}: gh: HTTP 403: Resource not accessible by integration`,
    })
  })
})
