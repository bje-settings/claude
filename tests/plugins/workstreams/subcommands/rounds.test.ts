// The rounds command (#376). Each example builds the plan comments of one
// repository through the in-process `gh` double, and asserts which rounds a
// scoped lookup returns. The first block is the issue's acceptance case: two
// rounds in flight on one repository, on two issue sets, with no milestone,
// and each lookup returns only its own round.
import { describe, expect, it } from 'vitest'

import { createGhMock, ghFails } from '#harness/gh.ts'
import type { IssueComments } from '#workstreams/lib/gh.ts'
import {
  type RoundsReport,
  renderRounds,
  roundsOf,
  runRounds,
} from '#workstreams/subcommands/rounds.ts'

/** One comment line at a time of day on 2026-10-0<day>. */
const at = (day: number, hour = 10): string =>
  `2026-10-0${day}T${String(hour).padStart(2, '0')}:00:00Z`

/** An issue with these first lines, one day apart, starting on day 1. */
const issue = (
  number: number,
  lines: readonly string[],
  fields: Partial<IssueComments> = {},
): IssueComments => ({
  number,
  state: 'OPEN',
  milestone: null,
  comments: lines.map((firstLine, index) => ({ createdAt: at(index + 1), firstLine })),
  truncated: false,
  ...fields,
})

const PLAN_A = 'Round 3 plan, approved 2026-10-02.'
const PLAN_B = 'Round 4 plan, approved 2026-10-03.'

/** Two rounds in flight on one repository, with no milestone. Round 3 holds
 *  #12 and #13. Round 4 holds #20 and #21, and was planned a day later. */
const TWO_ROUNDS: readonly IssueComments[] = [
  issue(12, ['Sweep.', PLAN_A]),
  issue(13, ['Sweep.', PLAN_A], { state: 'CLOSED' }),
  issue(20, ['Sweep.', 'Rulings.', PLAN_B]),
  issue(21, ['Sweep.', 'Rulings.', PLAN_B]),
]

const run = async (argv: readonly string[], rows: readonly IssueComments[] = TWO_ROUNDS) =>
  runRounds([...argv, '--json'], {
    gh: createGhMock({ listPlanIssues: { rows, unavailable: null } }),
  })

const reportOf = (envelope: Awaited<ReturnType<typeof run>>): RoundsReport => {
  if (envelope.outcome !== 'ok') throw new Error(`expected ok, got ${envelope.outcome}`)
  return JSON.parse(envelope.value) as RoundsReport
}

const plans = (report: RoundsReport): string[] => report.rounds.map((round) => round.plan)

describe('two rounds on one repository', () => {
  it('returns only the round that holds the issues asked for', async () => {
    expect(plans(reportOf(await run(['--issues', '12'])))).toEqual([PLAN_A])
    expect(plans(reportOf(await run(['--issues', '#21'])))).toEqual([PLAN_B])
  })

  it('returns each round whole, with its closed issues, from one issue of it', async () => {
    const report = reportOf(await run(['--issues', '13']))

    expect(report.rounds).toEqual([
      {
        name: 'Round 3',
        plan: PLAN_A,
        plannedAt: at(2),
        issues: [
          { number: 12, state: 'OPEN', milestone: null },
          { number: 13, state: 'CLOSED', milestone: null },
        ],
      },
    ])
    expect(report.unavailable).toEqual([])
  })

  it('returns both rounds, newest plan first, when no scope is given', async () => {
    expect(plans(reportOf(await run([])))).toEqual([PLAN_B, PLAN_A])
  })

  it('returns no round for issues no round holds', async () => {
    expect(reportOf(await run(['--issues', '99'])).rounds).toEqual([])
  })

  it('returns the round of an issue’s newest plan only, never an older one', async () => {
    // #14 was in round 3's plan, then round 4 planned it too. It is round
    // 4's now. Round 3 does not claim it, and a lookup by #14 does not
    // reach round 3.
    const rows = [...TWO_ROUNDS, issue(14, [PLAN_A, PLAN_B])]

    const report = reportOf(await run(['--issues', '14'], rows))

    expect(plans(report)).toEqual([PLAN_B])
    expect(report.rounds[0]?.issues.map((entry) => entry.number)).toEqual([14, 20, 21])
  })
})

describe('the end of a round', () => {
  it('leaves out a round with its end record on any one of its issues', async () => {
    const rows = [
      issue(12, ['Sweep.', PLAN_A, 'Round 3 end, 2026-10-04.']),
      issue(13, ['Sweep.', PLAN_A]),
      ...TWO_ROUNDS.slice(2),
    ]

    expect(plans(reportOf(await run([], rows)))).toEqual([PLAN_B])
  })

  it('does not end a round on another round’s end record', async () => {
    const rows = [issue(12, [PLAN_A, 'Round 4 end, 2026-10-04.'])]

    expect(plans(reportOf(await run([], rows)))).toEqual([PLAN_A])
  })

  it('reads a new plan after an end record as a round in flight again', async () => {
    const again = 'Round 3 plan, approved 2026-10-05.'
    const rows = [issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.', again])]

    expect(plans(reportOf(await run([], rows)))).toEqual([again])
  })

  it('keeps two rounds of one name on two dates apart', async () => {
    const later = 'Round 3 plan, approved 2026-10-03.'
    const rows = [
      issue(12, [PLAN_A, 'Round 3 end, 2026-10-02.']),
      issue(13, ['Sweep.', 'Sweep again.', later]),
    ]

    expect(plans(reportOf(await run([], rows)))).toEqual([later])
  })
})

describe('the milestone scope', () => {
  const rows = [
    issue(12, [PLAN_A], { milestone: 4 }),
    issue(13, [PLAN_A], { milestone: null }),
    issue(20, [PLAN_B], { milestone: 5 }),
  ]

  it('returns the rounds with an issue on the milestone', async () => {
    expect(plans(reportOf(await run(['--milestone', '4'], rows)))).toEqual([PLAN_A])
    expect(plans(reportOf(await run(['--milestone', '5'], rows)))).toEqual([PLAN_B])
  })

  it('returns no round for a milestone none of them is on', async () => {
    expect(reportOf(await run(['--milestone', '6'], rows)).rounds).toEqual([])
  })
})

describe('roundsOf', () => {
  it('skips an issue the search found with no plan line in its comments', () => {
    // The search matches the words anywhere in a comment, as in a quote.
    expect(roundsOf([issue(12, ['See the "plan, approved" line on #10.'])])).toEqual([])
  })

  it('takes the earliest copy of the plan as the round’s plannedAt', () => {
    const early = issue(12, [PLAN_A])
    const late = { ...issue(13, [PLAN_A]), comments: [{ createdAt: at(5), firstLine: PLAN_A }] }

    expect(roundsOf([late, early])[0]?.plannedAt).toBe(at(1))
    expect(roundsOf([early, late])[0]?.plannedAt).toBe(at(1))
  })
})

describe('what the read could not see', () => {
  it('names an issue with more comments than were read', async () => {
    const rows = [issue(12, [PLAN_A], { truncated: true })]

    const report = reportOf(await run([], rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.unavailable).toEqual([
      '#12 has more comments than were read; an older plan is not seen',
    ])
  })

  it('answers with the rows that arrived, and the reason the list is short', async () => {
    const envelope = await runRounds(['--json'], {
      gh: createGhMock({ listPlanIssues: { rows: TWO_ROUNDS, unavailable: 'gh: rate limit' } }),
    })

    const report = reportOf(envelope)
    expect(report.rounds).toHaveLength(2)
    expect(report.unavailable).toEqual(['gh: rate limit'])
  })

  it('fails, exit 1, when nothing at all could be read', async () => {
    const envelope = await runRounds([], {
      gh: createGhMock({ listPlanIssues: { rows: [], unavailable: 'gh: rate limit' } }),
    })

    expect(envelope).toEqual({
      outcome: 'failed',
      error: 'the rounds read nothing: gh: rate limit',
    })
  })

  it('answers no rounds when the search found nothing and nothing failed', async () => {
    expect(reportOf(await run([], []))).toEqual({ rounds: [], unavailable: [] })
  })
})

describe('usage', () => {
  // `ghFails` stands in for every endpoint: a refusal must come before any read.
  const refusing = { gh: createGhMock({ listPlanIssues: ghFails('must not be read') }) }

  it('prints its own usage for --help', async () => {
    const envelope = await runRounds(['--help'], refusing)

    expect(envelope.outcome).toBe('ok')
    expect(envelope.outcome === 'ok' && envelope.value).toMatch(/^The rounds in flight/)
  })

  it.each([
    [['--issues', 'x'], '--issues takes issue numbers, not "x"'],
    [['--milestone', '4x'], '--milestone takes milestone numbers, not "4x"'],
    [
      ['--issues', '1', '--issues', '2'],
      '--issues is not repeatable; pass one comma-separated list',
    ],
    [
      ['--milestone', '1', '--milestone=2'],
      '--milestone is not repeatable; pass one comma-separated list',
    ],
    [
      ['--issues', '1', '--milestone', '2'],
      '--issues and --milestone are not given together; a round has one scope',
    ],
  ])('refuses %j before it reads anything', async (argv, error) => {
    expect(await runRounds(argv, refusing)).toEqual({ outcome: 'refused', error })
  })

  it('refuses an unknown flag', async () => {
    expect((await runRounds(['--nope'], refusing)).outcome).toBe('refused')
  })

  it('reads one issue named twice as one', async () => {
    expect(plans(reportOf(await run(['--issues', '12,12'])))).toEqual([PLAN_A])
  })
})

describe('the report for a person', () => {
  it('lists each round with its issues and their milestones', async () => {
    const rows = [issue(12, [PLAN_A], { milestone: 4 }), issue(13, [PLAN_A], { state: 'CLOSED' })]

    const envelope = await runRounds([], {
      gh: createGhMock({ listPlanIssues: { rows, unavailable: null } }),
    })

    expect(envelope).toEqual({
      outcome: 'ok',
      value: [
        'rounds in flight (1)',
        `  ${PLAN_A}`,
        '    #12  open  milestone 4',
        '    #13  closed  no milestone',
      ].join('\n'),
    })
  })

  it('says first that the list is incomplete', () => {
    expect(renderRounds({ rounds: [], unavailable: ['gh: rate limit'] })).toBe(
      [
        'INCOMPLETE: the rounds below are short of what was asked for.',
        '  gh: rate limit',
        '',
        'rounds in flight (0)',
      ].join('\n'),
    )
  })
})
