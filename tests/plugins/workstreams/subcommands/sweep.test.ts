// The sweep command. Two kinds of example here, and the difference
// matters.
//
// The acceptance case replays `fixtures/sweep-capture.json`. That file
// holds every child process the real client started while it answered
// the four reads against this repository, on 2026-09-21. The case drives
// the REAL `createGhClient`, over a runner that answers by argv. So it
// exercises the query text, the argv, the parsing in `lib/gh.ts`, and
// this command's own classification, together, against GitHub's own
// bytes. The sets it asserts are round 8's hand sweep of milestone 4.
// That is the issue's acceptance line ("the report matches a hand
// sweep"), held by a test, rather than by a memory of one.
//
// Everything else uses the in-process `gh` double, where a reply is
// written to reach one arm: the refusals, the partial reads, and the
// tiers a real tracker does not happen to contain.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createGhMock, ghFails } from '#harness/gh.ts'
import { createGhClient, type IssueSummary } from '#workstreams/lib/gh.ts'
import type { Runner, RunResult } from '#workstreams/lib/process.ts'
import {
  classify,
  renderReport,
  runSweep,
  type SweepReport,
} from '#workstreams/subcommands/sweep.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CAPTURE = path.join(HERE, '..', 'fixtures', 'sweep-capture.json')

interface Capture {
  readonly calls: ReadonlyArray<{
    readonly args: readonly string[]
    readonly status: number
    readonly stdout: string
  }>
}

/** A runner that answers only the calls the capture recorded, matched on
 *  the whole argv. An argv that was never recorded throws, and says so: a
 *  runner that answered an unrecorded call with an empty body would let a
 *  query this command changed pass as though the capture still covered
 *  it. */
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

/** A double that answers every read, with the issues given. */
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

/** One issue's blockedBy edges, read straight from a capture's own GraphQL
 *  reply, never through `classify()`. This is what lets the acceptance
 *  case check the command's answer against the tracker itself, rather
 *  than against another copy of the same rule. */
interface CapturedIssue {
  readonly number: number
  readonly milestone: number | null
  readonly openBlockers: readonly number[]
}

/** Every issue node any call in the capture answered with, deduped by
 *  number. First write wins, the way `runSweep` keeps the unfiltered
 *  read's row over a later, redundant one. */
const capturedIssues = (): readonly CapturedIssue[] => {
  const capture = JSON.parse(readFileSync(CAPTURE, 'utf8')) as Capture
  const seen = new Map<number, CapturedIssue>()
  for (const call of capture.calls) {
    let parsed: unknown
    try {
      parsed = JSON.parse(call.stdout)
    } catch {
      // A call whose stdout is not JSON at all carries no issue node
      // either way. It is skipped here, rather than read as one.
      continue
    }
    const record = parsed as { data?: { repository?: { issues?: { nodes?: unknown[] } } } }
    const nodes = record.data?.repository?.issues?.nodes
    if (!Array.isArray(nodes)) continue
    for (const node of nodes as Array<Record<string, unknown>>) {
      const number = node.number as number
      if (seen.has(number)) continue
      const blockedBy = (node.blockedBy as { nodes: Array<{ number: number; state: string }> })
        .nodes
      const milestone = node.milestone as { number: number } | null
      seen.set(number, {
        number,
        milestone: milestone === null ? null : milestone.number,
        openBlockers: blockedBy.filter((ref) => ref.state === 'OPEN').map((ref) => ref.number),
      })
    }
  }
  return [...seen.values()]
}

/** The unblocked set and each member's `unlocks`, for one milestone (or
 *  `null` for the issues on none), derived straight from the capture's own
 *  edges rather than from `classify()`. */
const expectedFromCapture = (
  milestone: number | null,
): { unblocked: readonly number[]; blocked: readonly number[]; unlocks: Map<number, number[]> } => {
  const issues = capturedIssues()
  const unblockedNumbers = new Set(
    issues.filter((issue) => issue.openBlockers.length === 0).map((issue) => issue.number),
  )
  const unlocks = new Map<number, number[]>()
  for (const issue of issues) {
    if (issue.openBlockers.length !== 1) continue
    const blocker = issue.openBlockers[0] as number
    if (!unblockedNumbers.has(blocker)) continue
    const list = unlocks.get(blocker)
    if (list === undefined) unlocks.set(blocker, [issue.number])
    else list.push(issue.number)
  }
  const mine = issues.filter((issue) => issue.milestone === milestone)
  const sorted = (numbers: readonly number[]) => [...numbers].sort((left, right) => left - right)
  return {
    unblocked: sorted(
      mine.filter((issue) => unblockedNumbers.has(issue.number)).map((issue) => issue.number),
    ),
    blocked: sorted(
      mine.filter((issue) => !unblockedNumbers.has(issue.number)).map((issue) => issue.number),
    ),
    unlocks,
  }
}

describe('the round 8 hand sweep, replayed against the captured tracker', () => {
  it('reproduces the unblocked set and the blocked set for milestone 4', async () => {
    const answer = await runSweep(['--milestone', '4', '--json'], { gh: captured() })

    expect(answer.outcome).toBe('ok')
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as SweepReport
    expect(report.unavailable).toEqual([])

    const group = report.groups[0]
    const expected = expectedFromCapture(4)
    expect(group?.milestone).toEqual({
      number: 4,
      title: 'workstreams primitives',
      openIssues: 13,
      closedIssues: 1,
    })
    // Derived straight from the capture's own blockedBy edges (#195), not
    // from a copy of the sets a past hand sweep found.
    expect(
      [...(group?.unblocked.map((entry) => entry.number) ?? [])].sort((a, b) => a - b),
    ).toEqual(expected.unblocked)
    expect([...(group?.blocked.map((entry) => entry.number) ?? [])].sort((a, b) => a - b)).toEqual(
      expected.blocked,
    )
    // #111 is in the unblocked set with no blockers at all, which is a
    // different fact from #130's and #133's "every blocker closed", and
    // the report carries both.
    expect(group?.unblocked.find((entry) => entry.number === 111)?.blockedBy).toEqual([])
    expect(group?.unblocked.find((entry) => entry.number === 130)?.blockedBy).toEqual([
      { number: 127, state: 'CLOSED' },
      { number: 129, state: 'CLOSED' },
    ])
    // #130 and #133 each unlock the issues whose only open blocker they
    // are, read from the same capture, never from a hand-picked literal.
    expect(
      [...(group?.unblocked.find((entry) => entry.number === 130)?.unlocks ?? [])].sort(
        (a, b) => a - b,
      ),
    ).toEqual([...(expected.unlocks.get(130) ?? [])].sort((a, b) => a - b))
    expect(
      [...(group?.unblocked.find((entry) => entry.number === 133)?.unlocks ?? [])].sort(
        (a, b) => a - b,
      ),
    ).toEqual([...(expected.unlocks.get(133) ?? [])].sort((a, b) => a - b))
  })

  it('reads #98 as blocked, not unblocked, because its one open blocker is not itself unblocked', async () => {
    // The case #195's acceptance line turns on: #98 is behind #132 alone,
    // and #132 is itself behind #130. Both are blocked, so the report
    // leaves both out of the swept, unblocked set.
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport

    expect(parsed.groups[0]?.blocked.map((entry) => entry.number)).toContain(98)
    expect(parsed.groups[0]?.unblocked.map((entry) => entry.number)).not.toContain(98)
  })

  it('carries only a number and a title for a blocked issue, never its blockers', async () => {
    // #195: the report says a blocked issue exists, and nothing about why.
    // The skill reads, maps, sizes, and comments on the unblocked set alone.
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport
    const ninetyEight = parsed.groups[0]?.blocked.find((entry) => entry.number === 98)

    expect(ninetyEight).toEqual({ number: 98, title: expect.any(String) })
  })

  it('finds the issues on no milestone, which the milestone filter cannot', async () => {
    const report = await runSweep(['--milestone', '4', '--json'], { gh: captured() })
    const parsed = JSON.parse(report.outcome === 'ok' ? report.value : '{}') as SweepReport
    const expected = expectedFromCapture(null)

    expect(parsed.unassigned.milestone).toBeNull()
    expect(parsed.unassigned.unblocked.map((entry) => entry.number)).toEqual(expected.unblocked)
    // #37 is behind #133 and #132 both, so neither open blocker's release
    // puts it in the unblocked set.
    expect(parsed.unassigned.blocked.map((entry) => entry.number)).toEqual(expected.blocked)
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
    expect(text).toContain('  #177  wktr-171-audit-split -> main  draft  ')
    // A blocked issue's line names it and nothing else: no blocker, no
    // reason. The skill reads none of that (#195).
    expect(text).toContain('  blocked (10)')
    // Whole lines, not substrings: a set that grew an entry on the end still
    // contains the shorter string, so `toContain` would read an issue promoted
    // into the wrong tier as a pass.
    const lines = text.split('\n')
    expect(lines).toContain('  unblocked: #111, #130, #133, #1, #5, #15, #22, #106')
    expect(lines).toContain(
      '  blocked: #18, #96, #98, #100, #101, #102, #131, #132, #134, #135, #37',
    )
    expect(text).not.toContain('INCOMPLETE')
    expect(text).not.toContain('next tier')
  })

  it('names what an unblocked issue unlocks, and says nothing when it unlocks nothing', async () => {
    const answer = await runSweep(['--milestone', '4'], { gh: captured() })
    const text = answer.outcome === 'ok' ? answer.value : ''
    const lines = text.split('\n')

    const at = (marker: string) => lines.findIndex((line) => line.includes(marker))
    // #130 is the sole open blocker of #18, #96, #131 and #132; the line
    // sits right after its own reason.
    expect(lines[at('#130') + 2]).toBe('        unlocks: #18, #96, #131, #132')
    // #111 unlocks nothing, so its entry is two lines: the title and the
    // reason, with no third line naming anything it unlocks.
    const oneEleven = at('#111')
    expect(lines[oneEleven + 1]).toBe('        no blockers')
    expect(lines[oneEleven + 2]).not.toContain('unlocks')
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

  it('accepts -h as the short form of --help', async () => {
    const answer = await runSweep(['-h'], { gh: createGhMock() })

    expect(answer.outcome).toBe('ok')
    expect(answer.outcome === 'ok' ? answer.value : '').toMatch(/^What a round could start on/)
  })

  it('refuses an undeclared short flag', async () => {
    const answer = await runSweep(['-x'], { gh: createGhMock() })

    expect(answer.outcome).toBe('refused')
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

describe('the issue scope (#376)', () => {
  // #130 is on milestone 4, #140 on no milestone, #150 on milestone 4 and
  // blocked by #130 alone, so #130 unlocks it.
  const issues = [
    issue(130),
    issue(140, { milestone: null }),
    issue(150, { blockedBy: [{ number: 130, state: 'OPEN' }] }),
  ]

  it('reports only the issues named, under the milestones they are on', async () => {
    const report = await reportOf(['--issues', '130'], mockWith(issues))

    expect(report.groups.map((group) => group.milestone?.number)).toEqual([4])
    expect(report.groups[0]?.unblocked.map((entry) => entry.number)).toEqual([130])
    expect(report.groups[0]?.blocked).toEqual([])
    expect(report.unassigned.unblocked).toEqual([])
    expect(report.combined).toEqual({ unblocked: [130], blocked: [] })
    expect(report.unavailable).toEqual([])
  })

  it('still reads what an issue in scope unlocks from every open issue', async () => {
    const report = await reportOf(['--issues', '130'], mockWith(issues))

    expect(report.groups[0]?.unblocked[0]?.unlocks).toEqual([150])
  })

  it('reports an issue on no milestone in the unassigned set, with no milestone group', async () => {
    const report = await reportOf(['--issues', '#140'], mockWith(issues))

    expect(report.groups).toEqual([])
    expect(report.unassigned.unblocked.map((entry) => entry.number)).toEqual([140])
  })

  it('names an issue it was asked for and did not read as an open issue', async () => {
    const report = await reportOf(['--issues', '130,999'], mockWith(issues))

    expect(report.unavailable).toEqual(['#999 was not among the open issues read'])
  })

  it('refuses --issues beside --milestone, a repeated --issues, and a bad number', async () => {
    const cases: Array<[string[], string]> = [
      [
        ['--milestone', '4', '--issues', '130'],
        '--milestone and --issues are not given together; a round has one scope',
      ],
      [
        ['--issues', '1', '--issues', '2'],
        '--issues is not repeatable; pass one comma-separated list',
      ],
      [['--issues', 'x'], '--issues takes issue numbers, not "x"'],
    ]
    for (const [argv, error] of cases) {
      expect(await runSweep(argv, { gh: createGhMock() })).toEqual({ outcome: 'refused', error })
    }
  })
})

describe('what the sweep does with a read it could not complete', () => {
  it('reports the reason, marks the report incomplete, and still answers', async () => {
    // A partial answer is an answer, and a caller is told to read
    // `unavailable` before it acts on the sets. To lose the rows that did
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

  it('still groups the issues it read when the milestone read was the one that failed', async () => {
    // The milestone list is how the groups are named, not how the issues are
    // found. Without this the issues that did arrive are classified and then
    // reported in no group at all, which is a row read and then lost.
    const report = await reportOf(
      [],
      createGhMock({
        listMilestones: { rows: [], unavailable: 'gh: API rate limit exceeded' },
        listOpenPullRequests: { rows: [], unavailable: null },
        listIssues: { rows: [issue(130)], unavailable: null },
      }),
    )

    expect(report.groups.map((group) => group.milestone?.number)).toEqual([4])
    expect(report.groups[0]?.unblocked.map((entry) => entry.number)).toEqual([130])
    expect(report.combined.unblocked).toEqual([130])
    expect(renderReport(report)).toContain('milestone 4 (not an open milestone)')
  })

  it('sweeps a milestone that has closed with an open issue still on it', async () => {
    // `listMilestones` asks for the OPEN milestones and the issue query filters
    // on the issue's own state, so an open issue on a closed milestone is read
    // and belongs to no open milestone and to no "on no milestone" set either.
    const report = await reportOf(
      [],
      createGhMock({
        listMilestones: {
          rows: [{ number: 6, title: 'audit plugin', openIssues: 7, closedIssues: 0 }],
          unavailable: null,
        },
        listOpenPullRequests: { rows: [], unavailable: null },
        listIssues: {
          rows: [
            issue(130, { milestone: { number: 3, title: 'closed milestone' } }),
            // A second issue on that same closed milestone: the milestone is
            // swept once, not once per issue that names it.
            issue(133, { milestone: { number: 3, title: 'closed milestone' } }),
            issue(170, { milestone: { number: 6, title: 'audit plugin' } }),
          ],
          unavailable: null,
        },
      }),
    )

    expect(report.groups.map((group) => group.milestone?.number)).toEqual([3, 6])
    expect(report.combined.unblocked).toEqual([130, 133, 170])
  })

  it('reports the pull requests it read rather than failing because the issues were empty', async () => {
    // A failure writes nothing to stdout, so answering one here would destroy
    // the open pull request list that did arrive.
    const report = await reportOf(
      [],
      createGhMock({
        listMilestones: { rows: [], unavailable: 'gh: API rate limit exceeded' },
        listOpenPullRequests: {
          rows: [{ number: 9, title: 'a change', head: 'topic', base: 'main', draft: false }],
          unavailable: null,
        },
        listIssues: { rows: [], unavailable: 'gh: API rate limit exceeded' },
      }),
    )

    expect(report.pullRequests.map((pull) => pull.number)).toEqual([9])
    expect(renderReport(report)).toContain('INCOMPLETE: the sets below are short')
  })

  it('reports the milestones it read when the issues and the pull requests were the reads that failed', async () => {
    // The other half of the same rule: the milestone list is an answer too, and
    // a failure writes nothing to stdout, so it must not be thrown away because
    // the two reads beside it came back empty.
    const report = await reportOf(
      [],
      createGhMock({
        listMilestones: {
          rows: [{ number: 4, title: 'workstreams primitives', openIssues: 13, closedIssues: 1 }],
          unavailable: null,
        },
        listOpenPullRequests: { rows: [], unavailable: 'gh: API rate limit exceeded' },
        listIssues: { rows: [], unavailable: 'gh: API rate limit exceeded' },
      }),
    )

    expect(report.milestones.map((milestone) => milestone.number)).toEqual([4])
    expect(renderReport(report)).toContain('INCOMPLETE: the sets below are short')
  })

  it('answers with empty sets for a repository that simply has no open issues', async () => {
    // Nothing read and nothing wrong is a different answer from nothing read
    // because a read failed. To report the first as a failure would make a
    // quiet repository look broken.
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

  it('reads an issue whose only open blocker was never read as blocked, never as unblocked', async () => {
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

  it('carries unlocks: the open issues whose only open blocker is this one', async () => {
    const classified = classify([
      issue(130, {}),
      issue(18, { blockedBy: [{ number: 130, state: 'OPEN' }] }),
      issue(96, { blockedBy: [{ number: 130, state: 'OPEN' }] }),
    ])

    expect(classified.find((entry) => entry.number === 130)?.unlocks).toEqual([18, 96])
  })

  it('carries no unlocks for an issue nothing names as its only open blocker', async () => {
    const classified = classify([issue(111, {})])

    expect(classified[0]?.unlocks).toEqual([])
  })

  it('does not unlock an issue behind two open blockers', async () => {
    // #37's case: behind #133 and #132 both, so releasing either one alone
    // does not unlock it.
    const classified = classify([
      issue(133, {}),
      issue(132, {}),
      issue(37, {
        blockedBy: [
          { number: 133, state: 'OPEN' },
          { number: 132, state: 'OPEN' },
        ],
      }),
    ])

    expect(classified.find((entry) => entry.number === 133)?.unlocks).toEqual([])
    expect(classified.find((entry) => entry.number === 132)?.unlocks).toEqual([])
  })

  it('does not let a blocked issue unlock anything, even one it is the sole open blocker of', async () => {
    // The chain #130 (unblocked) <- #132 (blocked, behind #130 alone) <-
    // #98 (blocked, behind #132 alone). #132 has not been released yet, so
    // it must not carry #98 in its own `unlocks`: only an UNBLOCKED issue
    // unlocks anything.
    const classified = classify([
      issue(130, {}),
      issue(132, { blockedBy: [{ number: 130, state: 'OPEN' }] }),
      issue(98, { blockedBy: [{ number: 132, state: 'OPEN' }] }),
    ])

    expect(classified.find((entry) => entry.number === 130)?.unlocks).toEqual([132])
    expect(classified.find((entry) => entry.number === 132)?.unlocks).toEqual([])
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

  /** A runner that answers the unfiltered issue read with nothing, and the
   *  milestone read with one issue. This is what a rate limit that hits
   *  one call of the four looks like from here. */
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
    // A milestone read that succeeded where the unfiltered one did not
    // still knows about its own issues. To drop them would report an
    // empty milestone as an answer.
    const gh = createGhClient({ repository: 'acme/widgets', run: onlyInTheMilestoneRead() })

    const answer = await runSweep(['--milestone', '4', '--json'], { gh })
    const report = JSON.parse(answer.outcome === 'ok' ? answer.value : '{}') as SweepReport

    expect(report.groups[0]?.unblocked.map((entry) => entry.number)).toEqual([130])
    expect(report.unassigned.unblocked).toEqual([])
  })
})
