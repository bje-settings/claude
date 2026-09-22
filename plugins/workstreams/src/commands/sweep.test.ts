// The sweep command. Two kinds of example here, and the difference matters.
//
// The acceptance case replays `fixtures/sweep-capture.json`, which is every
// child process the real client started while answering the four reads
// against this repository on 2026-09-21, and it drives the REAL
// `createGhClient` over a runner that answers by argv. So it exercises the
// query text, the argv, the parsing in `lib/gh.ts` and this command's own
// classification together, against GitHub's own bytes, and the sets it
// asserts are round 8's hand sweep of milestone 4. That is the issue's
// acceptance line ("the report matches a hand sweep") held by a test rather
// than by a memory of one.
//
// Everything else uses the in-process `gh` double, where a reply is written
// to reach one arm: the refusals, the partial reads, and the tiers a real
// tracker does not happen to contain.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createGhMock, ghFails } from '../../../../harness/gh.ts'
import { createGhClient, type IssueSummary } from '../lib/gh.ts'
import type { Runner, RunResult } from '../lib/process.ts'
import { classify, renderReport, runSweep, type SweepReport } from './sweep.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CAPTURE = path.join(HERE, '..', 'fixtures', 'sweep-capture.json')

interface Capture {
  readonly calls: ReadonlyArray<{
    readonly args: readonly string[]
    readonly status: number
    readonly stdout: string
  }>
}

/** A runner that answers only the calls the capture recorded, matched on the
 *  whole argv. An argv that was never recorded throws and says so: a runner
 *  that answered an unrecorded call with an empty body would let a query this
 *  command changed pass as though the capture still covered it. */
const replaying = (): Runner => {
  const capture = JSON.parse(readFileSync(CAPTURE, 'utf8')) as Capture
  return async (_command, args = []) => {
    const wanted = JSON.stringify(args)
    const call = capture.calls.find((recorded) => JSON.stringify(recorded.args) === wanted)
    if (call === undefined) throw new Error(`sweep-capture.json has no call for ${wanted}`)
    return {
      status: call.status,
      signal: null,
      stdout: call.stdout,
      stderr: '',
      combined: call.stdout,
      timedOut: false,
      elapsedMs: 0,
      startFailure: null,
      streamErrors: [],
    } satisfies RunResult
  }
}

const captured = () => createGhClient({ repository: 'bje-settings/claude', run: replaying() })

/** An issue row, with everything a test does not care about filled in. */
const issue = (number: number, fields: Partial<IssueSummary> = {}): IssueSummary => ({
  number,
  title: `issue ${number}`,
  milestone: { number: 4, title: 'workstreams primitives' },
  labels: [],
  blockedBy: [],
  blocking: [],
  pullRequests: [],
  ...fields,
})

/** A double answering every read, with the issues given. */
const mockWith = (issues: readonly IssueSummary[], unavailable: string | null = null) =>
  createGhMock({
    listMilestones: {
      rows: [{ number: 4, title: 'workstreams primitives', openIssues: 13, closedIssues: 1 }],
      unavailable: null,
    },
    listOpenPullRequests: { rows: [], unavailable: null },
    listIssues: { rows: issues, unavailable },
  })

const reportOf = async (argv: readonly string[], gh: ReturnType<typeof createGhMock>) => {
  const answer = await runSweep([...argv, '--json'], { gh })
  if (answer.outcome !== 'ok') throw new Error(`expected a report, got ${answer.error}`)
  return JSON.parse(answer.value) as SweepReport
}

describe('the round 8 hand sweep, replayed against the captured tracker', () => {
  it('reproduces the unblocked set, the next tier and the rest for milestone 4', async () => {
    const answer = await runSweep(['--milestone', '4', '--json'], { gh: captured() })

    expect(answer.outcome).toBe('ok')
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as SweepReport
    expect(report.unavailable).toEqual([])

    const group = report.groups[0]
    expect(group?.milestone).toEqual({
      number: 4,
      title: 'workstreams primitives',
      openIssues: 13,
      closedIssues: 1,
    })
    // Round 8's hand sweep, issue for issue. #111 is in the unblocked set
    // with no blockers at all, which is a different fact from #130's and
    // #133's "every blocker closed", and the report carries both.
    expect(group?.unblocked.map((entry) => entry.number)).toEqual([111, 130, 133])
    expect(group?.next.map((entry) => entry.number)).toEqual([18, 96, 100, 101, 131, 132])
    expect(group?.blocked.map((entry) => entry.number)).toEqual([98, 102, 134, 135])
    expect(group?.unblocked.find((entry) => entry.number === 111)?.blockedBy).toEqual([])
    expect(group?.unblocked.find((entry) => entry.number === 130)?.blockedBy).toEqual([
      { number: 127, state: 'CLOSED' },
      { number: 129, state: 'CLOSED' },
    ])
  })

  it('reads #98 as blocked, not as the next tier, because its one open blocker is not unblocked', async () => {
    // The case that separates "one open blocker" from "next tier": #98 is
    // behind #132 alone, and #132 is itself behind #130. A rule that stopped
    // at the blocker count would have promoted it.
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport
    const ninetyEight = parsed.groups[0]?.blocked.find((entry) => entry.number === 98)

    expect(ninetyEight?.openBlockers).toEqual([132])
    expect(parsed.groups[0]?.next.map((entry) => entry.number)).not.toContain(98)
  })

  it('finds the issues on no milestone, which the milestone filter cannot', async () => {
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport

    expect(parsed.unassigned.milestone).toBeNull()
    expect(parsed.unassigned.unblocked.map((entry) => entry.number)).toEqual([1, 5, 15, 22, 106])
    expect(parsed.unassigned.blocked.map((entry) => entry.number)).toEqual([37])
  })

  it('reports the open milestones and every open pull request, including one no round opened', async () => {
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport

    expect(parsed.milestones.map((milestone) => milestone.number)).toEqual([4, 5, 6])
    expect(parsed.pullRequests).toEqual([
      {
        number: 177,
        title: 'feat(audit): plugin skeleton and the pure markdown splitter',
        head: 'wktr-171-audit-split',
        base: 'main',
        draft: true,
      },
    ])
  })

  it('prints the same sweep for a person', async () => {
    const answer = await runSweep(['--milestone', '4'], { gh: captured() })
    const text = answer.outcome === 'ok' ? answer.value : ''

    expect(text).toContain('milestone 4: workstreams primitives (13 open, 1 closed)')
    expect(text).toContain('  unblocked (3)')
    expect(text).toContain('        every blocker closed: #127, #129')
    expect(text).toContain('        no blockers')
    expect(text).toContain('        behind #132, #133')
    expect(text).toContain('  #177  wktr-171-audit-split -> main  draft  ')
    expect(text).toContain('  unblocked: #111, #130, #133, #1, #5, #15, #22, #106')
    expect(text).toContain('  next tier: #18, #96, #100, #101, #131, #132')
    expect(text).toContain('  blocked: #98, #102, #134, #135, #37')
    expect(text).not.toContain('INCOMPLETE')
  })
})

describe('the command line', () => {
  it('prints its own usage for --help and asks gh nothing', async () => {
    // The double has no registration at all, so any read would throw and name
    // the endpoint: that is what proves help is answered before anything is
    // asked.
    const answer = await runSweep(['--help'], { gh: createGhMock() })

    expect(answer.outcome).toBe('ok')
    expect(answer.outcome === 'ok' ? answer.value : '').toMatch(/^What a round could start on/)
  })

  it('refuses a flag nobody declared, in node’s own words', async () => {
    const answer = await runSweep(['--nope'], { gh: createGhMock() })

    expect(answer.outcome).toBe('refused')
    expect(answer.outcome === 'refused' ? answer.error : '').toContain('--nope')
  })

  it('refuses a --milestone value that is not a milestone number', async () => {
    for (const bad of ['4x', 'main', '0', '1.5']) {
      const answer = await runSweep(['--milestone', bad], { gh: createGhMock() })
      expect(answer.outcome, bad).toBe('refused')
      expect(answer.outcome === 'refused' ? answer.error : '').toContain(
        '--milestone takes milestone numbers',
      )
    }
  })

  it('refuses a repeated --milestone rather than silently sweeping the last one', async () => {
    // `parseArgs` answers a repeated option with its last value and no
    // complaint, so without this the caller would be told about milestone 5
    // and hear nothing about the 4 they also asked for.
    for (const argv of [
      ['--milestone', '4', '--milestone', '5'],
      ['--milestone=4', '--milestone=5'],
    ]) {
      const answer = await runSweep(argv, { gh: createGhMock() })
      expect(answer.outcome).toBe('refused')
      expect(answer.outcome === 'refused' ? answer.error : '').toBe(
        '--milestone is not repeatable; pass one comma-separated list',
      )
    }
  })

  it('takes a comma list, trims it, and sweeps each milestone once', async () => {
    const report = await reportOf(['--milestone', ' 4 , 5 , 4'], mockWith([issue(130)]))

    expect(report.groups.map((group) => group.milestone?.number)).toEqual([4, 5])
  })

  it('sweeps every open milestone when none was asked for', async () => {
    const report = await reportOf([], mockWith([issue(130)]))

    expect(report.groups.map((group) => group.milestone?.number)).toEqual([4])
  })

  it('says so when a milestone that was asked for is not an open one', async () => {
    const report = await reportOf(['--milestone', '9'], mockWith([issue(130)]))

    expect(report.groups[0]?.milestone).toEqual({
      number: 9,
      title: null,
      openIssues: null,
      closedIssues: null,
    })
    expect(renderReport(report)).toContain('milestone 9 (not an open milestone)')
  })
})

describe('what the sweep does with a read it could not complete', () => {
  it('reports the reason, marks the report incomplete, and still answers', async () => {
    // A partial answer is an answer, and a caller is told to read
    // `unavailable` before acting on the sets. Losing the rows that did
    // arrive would help nobody.
    const report = await reportOf([], mockWith([issue(130)], 'gh: API rate limit exceeded'))

    // Once for the unfiltered read and once for milestone 4's, because the
    // double answers every call from the one registration.
    expect(report.unavailable).toEqual([
      'gh: API rate limit exceeded',
      'gh: API rate limit exceeded',
    ])
    expect(report.groups[0]?.unblocked.map((entry) => entry.number)).toEqual([130])
    expect(renderReport(report)).toContain('INCOMPLETE: the sets below are short')
  })

  it('fails when it read nothing at all and something went wrong', async () => {
    const answer = await runSweep([], {
      gh: createGhMock({
        listMilestones: { rows: [], unavailable: 'gh: could not resolve to a Repository' },
        listOpenPullRequests: { rows: [], unavailable: null },
        listIssues: { rows: [], unavailable: 'gh: could not resolve to a Repository' },
      }),
    })

    expect(answer.outcome).toBe('failed')
    expect(answer.outcome === 'failed' ? answer.error : '').toBe(
      'the sweep read nothing: gh: could not resolve to a Repository; ' +
        'gh: could not resolve to a Repository',
    )
  })

  it('answers with empty sets for a repository that simply has no open issues', async () => {
    // Nothing read and nothing wrong is a different answer from nothing read
    // because a read failed, and reporting the first as a failure would make
    // a quiet repository look broken.
    const answer = await runSweep([], {
      gh: createGhMock({
        listMilestones: { rows: [], unavailable: null },
        listOpenPullRequests: { rows: [], unavailable: null },
        listIssues: { rows: [], unavailable: null },
      }),
    })

    expect(answer.outcome).toBe('ok')
    const text = answer.outcome === 'ok' ? answer.value : ''
    expect(text).toContain('open milestones (0)')
    expect(text).toContain('  unblocked: none')
  })

  it('lets a gh failure through as a thrown error rather than swallowing it', async () => {
    // The three reads never throw; anything that does is not this command's
    // to turn into an empty sweep.
    await expect(
      runSweep([], { gh: createGhMock({ listMilestones: ghFails('gh: HTTP 500') }) }),
    ).rejects.toThrow('gh: HTTP 500')
  })
})

describe('classification', () => {
  it('treats a MERGED blocker as done, the way a CLOSED one is', async () => {
    const classified = classify([
      issue(1, { blockedBy: [{ number: 2, state: 'MERGED' }] }),
      issue(3, { blockedBy: [{ number: 4, state: 'CLOSED' }] }),
    ])

    expect(classified.map((entry) => entry.tier)).toEqual(['unblocked', 'unblocked'])
  })

  it('reads an issue whose only open blocker was never read as blocked, not as the next tier', async () => {
    // The conservative direction: a page that could not be read makes the
    // sweep claim less, never more.
    const classified = classify([issue(1, { blockedBy: [{ number: 999, state: 'OPEN' }] })])

    expect(classified[0]?.tier).toBe('blocked')
    expect(classified[0]?.openBlockers).toEqual([999])
  })

  it('carries the labels, the blocking edges and the pull requests of each issue', async () => {
    const classified = classify([
      issue(130, {
        labels: ['enhancement'],
        blocking: [{ number: 131, state: 'OPEN' }],
        pullRequests: [{ number: 158, state: 'MERGED' }],
      }),
    ])

    expect(classified[0]).toMatchObject({
      labels: ['enhancement'],
      blocking: [{ number: 131, state: 'OPEN' }],
      pullRequests: [{ number: 158, state: 'MERGED' }],
      milestone: 4,
    })
  })
})

describe('the report a person reads', () => {
  it('names a ready pull request as ready', async () => {
    const report = await reportOf(
      [],
      createGhMock({
        listMilestones: { rows: [], unavailable: null },
        listOpenPullRequests: {
          rows: [{ number: 9, title: 'a change', head: 'topic', base: 'main', draft: false }],
          unavailable: null,
        },
        listIssues: { rows: [issue(1, { milestone: null })], unavailable: null },
      }),
    )

    expect(renderReport(report)).toContain('  #9  topic -> main  ready  a change')
  })

  it('prints every set even when it is empty, so a set nobody looked at cannot hide', async () => {
    const report = await reportOf(['--milestone', '4'], mockWith([issue(130)]))
    const text = renderReport(report)

    expect(text).toContain('  next tier (0)')
    expect(text).toContain('  blocked (0)')
    expect(text).toContain('issues on no milestone')
    expect(text).toContain('  unblocked (0)')
  })
})

describe('a milestone read that knows more than the unfiltered one', () => {
  /** One connection page as gh prints it. */
  const graphqlPage = (field: string, nodes: readonly unknown[]): string =>
    JSON.stringify({
      data: {
        repository: {
          [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      },
    })

  /** A runner answering the unfiltered issue read with nothing and the
   *  milestone read with one issue, which is what a rate limit hitting one
   *  call of the four looks like from here. */
  const onlyInTheMilestoneRead =
    (): Runner =>
    async (_command, args = []) => {
      const query = args.find((word) => word.startsWith('query=')) ?? ''
      const filtered = args.some((word) => word.startsWith('milestone='))
      let stdout = graphqlPage('issues', [])
      if (args[0] === 'repo') stdout = '{"nameWithOwner":"acme/widgets"}'
      else if (query.includes('milestones(')) stdout = graphqlPage('milestones', [])
      else if (query.includes('pullRequests(')) stdout = graphqlPage('pullRequests', [])
      else if (filtered) {
        stdout = graphqlPage('issues', [
          {
            number: 130,
            title: 'feat(workstreams): sweep (primitive 1)',
            milestone: { number: 4, title: 'workstreams primitives' },
            labels: { nodes: [] },
            blockedBy: { nodes: [] },
            blocking: { nodes: [] },
            closedByPullRequestsReferences: { nodes: [] },
          },
        ])
      }
      return {
        status: 0,
        signal: null,
        stdout,
        stderr: '',
        combined: stdout,
        timedOut: false,
        elapsedMs: 0,
        startFailure: null,
        streamErrors: [],
      } satisfies RunResult
    }

  it('keeps an issue only the milestone read returned', async () => {
    // A milestone read that succeeded where the unfiltered one did not still
    // knows about its own issues, and dropping them would report an empty
    // milestone as an answer.
    const gh = createGhClient({ repository: 'acme/widgets', run: onlyInTheMilestoneRead() })

    const answer = await runSweep(['--milestone', '4', '--json'], { gh })
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as SweepReport

    expect(report.groups[0]?.unblocked.map((entry) => entry.number)).toEqual([130])
    expect(report.unassigned.unblocked).toEqual([])
  })
})
