// The rounds command (#376). Each example builds the plan comments of one
// repository through an in-process `gh` double, and asserts which rounds a
// scoped lookup returns. The first block is the issue's acceptance case: two
// rounds in flight on one repository, on two issue sets, with no milestone,
// and each lookup returns only its own round.
import { describe, expect, it } from 'vitest'

import { createGhMock, type GhClient, ghFails } from '#harness/gh.ts'
import type { IssueComments, PagedResult } from '#workstreams/lib/gh.ts'
import {
  place,
  type RoundsReport,
  renderRounds,
  roundsOf,
  runRounds,
} from '#workstreams/subcommands/rounds.ts'

/** A time on day `day` of October 2026. */
const at = (day: number, hour = 10): string =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`

/** An open issue with these first lines, one day apart, starting on day 1. */
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
 *  #12, #13 and the closed #11. Round 4 holds #20 and #21, and was planned a
 *  day later. */
const TWO_ROUNDS: readonly IssueComments[] = [
  issue(11, ['Sweep.', PLAN_A], { state: 'CLOSED' }),
  issue(12, ['Sweep.', PLAN_A]),
  issue(13, ['Sweep.', PLAN_A]),
  issue(20, ['Sweep.', 'Rulings.', PLAN_B]),
  issue(21, ['Sweep.', 'Rulings.', PLAN_B]),
]

/** A `gh` whose search answers `searched`, and whose direct read answers
 *  each number asked for from `direct`, or from `searched` when `direct` is
 *  not given. A number in neither is not read. */
const ghOver = (
  searched: readonly IssueComments[],
  options: { direct?: readonly IssueComments[]; searchShort?: string; directShort?: string } = {},
): GhClient => ({
  ...createGhMock(),
  listPlanIssues: async (query = {}): Promise<PagedResult<IssueComments>> => {
    if (query.numbers === undefined) {
      return { rows: searched, unavailable: options.searchShort ?? null }
    }
    const pool = options.direct ?? searched
    const wanted = query.numbers
    return {
      rows: pool.filter((row) => wanted.includes(row.number)),
      unavailable: options.directShort ?? null,
    }
  },
})

const reportOf = async (
  argv: readonly string[],
  gh: GhClient = ghOver(TWO_ROUNDS),
): Promise<RoundsReport> => {
  const envelope = await runRounds([...argv, '--json'], { gh })
  if (envelope.outcome !== 'ok') throw new Error(`expected ok, got ${envelope.error}`)
  return JSON.parse(envelope.value) as RoundsReport
}

const plans = (report: RoundsReport): string[] => report.rounds.map((round) => round.plan)

describe('two rounds on one repository', () => {
  it('returns only the round that holds the issues asked for', async () => {
    expect(plans(await reportOf(['--issues', '12']))).toEqual([PLAN_A])
    expect(plans(await reportOf(['--issues', '#21']))).toEqual([PLAN_B])
  })

  it('returns each round whole, with its open issues, from one issue of it', async () => {
    expect(await reportOf(['--issues', '13'])).toEqual({
      rounds: [
        {
          name: 'Round 3',
          plan: PLAN_A,
          plannedAt: at(2),
          issues: [
            { number: 12, state: 'OPEN', milestone: null },
            { number: 13, state: 'OPEN', milestone: null },
          ],
        },
      ],
      outside: [],
      unavailable: [],
    })
  })

  it('returns both rounds, newest plan first, when no scope is given', async () => {
    expect(plans(await reportOf([]))).toEqual([PLAN_B, PLAN_A])
  })

  it('returns both rounds for a scope that spans them, so the caller can stop', async () => {
    expect(plans(await reportOf(['--issues', '12,20']))).toEqual([PLAN_B, PLAN_A])
  })

  it('returns the round of an issue’s newest plan only, never an older one', async () => {
    // #14 was in round 3's plan, then round 4 planned it too. It is round
    // 4's now. Round 3 does not claim it, and a lookup by #14 does not
    // reach round 3.
    const rows = [...TWO_ROUNDS, issue(14, [PLAN_A, PLAN_B])]

    const report = await reportOf(['--issues', '14'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_B])
    expect(report.rounds[0]?.issues.map((entry) => entry.number)).toEqual([14, 20, 21])
  })

  it('keeps the newer round in flight when the older round ends', async () => {
    const rows = [
      issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.']),
      issue(14, [PLAN_A, PLAN_B, 'Round 3 end, 2026-10-04.']),
      issue(20, [PLAN_B]),
    ]

    const report = await reportOf([], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_B])
    expect(report.rounds[0]?.issues.map((entry) => entry.number)).toEqual([14, 20])
  })
})

describe('an issue scope', () => {
  it('names each open issue asked for that no round holds', async () => {
    const rows = [...TWO_ROUNDS, issue(30, ['Sweep.'])]

    const report = await reportOf(['--issues', '12,30'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.outside).toEqual([30])
  })

  it('does not name a closed issue asked for, or one it could not read', async () => {
    const report = await reportOf(['--issues', '11,12,99'])

    expect(report.outside).toEqual([])
    expect(plans(report)).toEqual([PLAN_A])
  })

  it('sees a plan the search has not indexed yet, by reading the issues directly', async () => {
    // The search still holds #30's sweep alone. The direct read sees the
    // plan made a moment ago.
    const gh = ghOver([issue(30, ['Sweep.'])], {
      direct: [issue(30, ['Sweep.', 'Round 5 plan, approved 2026-10-04.'])],
    })

    const report = await reportOf(['--issues', '30'], gh)

    expect(plans(report)).toEqual(['Round 5 plan, approved 2026-10-04.'])
    expect(report.outside).toEqual([])
  })

  it('carries the reason a direct read fell short', async () => {
    const report = await reportOf(
      ['--issues', '12,99'],
      ghOver(TWO_ROUNDS, { directShort: '#99 could not be read as an issue' }),
    )

    expect(report.unavailable).toEqual(['#99 could not be read as an issue'])
  })
})

describe('the end of a round', () => {
  it('leaves out a round with its end record on any one of its open issues', async () => {
    const rows = [
      issue(12, ['Sweep.', PLAN_A, 'Round 3 end, 2026-10-04.']),
      issue(13, ['Sweep.', PLAN_A]),
      ...TWO_ROUNDS.slice(3),
    ]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([PLAN_B])
  })

  it('leaves out a round with no open issue, as rounds from before #368 are', async () => {
    const rows = [issue(12, [PLAN_A], { state: 'CLOSED' }), issue(20, [PLAN_B])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([PLAN_B])
  })

  it('does not end a round on another round’s end record', async () => {
    const rows = [issue(12, [PLAN_A, 'Round 4 end, 2026-10-04.'])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([PLAN_A])
  })

  it('does not end a round on a line that only starts with its name and "end"', async () => {
    const rows = [issue(12, [PLAN_A, 'Round 3 endpoint audit.', 'Round 3 ended early?'])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([PLAN_A])
  })

  it('reads a new plan after an end record as a round in flight again', async () => {
    const again = 'Round 3 plan, approved 2026-10-05.'
    const rows = [issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.', again])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([again])
  })

  it('keeps two rounds of one name on two dates apart', async () => {
    const later = 'Round 3 plan, approved 2026-10-03.'
    const rows = [
      issue(12, [PLAN_A, 'Round 3 end, 2026-10-02.']),
      issue(13, ['Sweep.', 'Sweep again.', later]),
    ]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([later])
  })
})

describe('the milestone scope', () => {
  const rows = [
    issue(12, [PLAN_A], { milestone: 4 }),
    issue(13, [PLAN_A], { milestone: null }),
    issue(20, ['Sweep.', PLAN_B], { milestone: 5 }),
  ]

  it('returns the rounds with an open issue on one of the milestones', async () => {
    expect(plans(await reportOf(['--milestone', '4'], ghOver(rows)))).toEqual([PLAN_A])
    expect(plans(await reportOf(['--milestone', '5'], ghOver(rows)))).toEqual([PLAN_B])
    expect(plans(await reportOf(['--milestone', '4,5'], ghOver(rows)))).toEqual([PLAN_B, PLAN_A])
  })

  it('returns no round for a milestone none of them is on, and names nothing outside', async () => {
    expect(await reportOf(['--milestone', '6'], ghOver(rows))).toEqual({
      rounds: [],
      outside: [],
      unavailable: [],
    })
  })
})

describe('place and roundsOf', () => {
  it('reads a heading or a quote of a plan as a plan that did not parse', () => {
    expect(place(issue(12, ['## Round 3 plan, approved 2026-10-02.']))).toEqual({
      plan: null,
      ended: false,
      unparsed: true,
    })
  })

  it('reads a plan line with no final period as a plan that did not parse', () => {
    expect(place(issue(12, [PLAN_A, 'Round 5 plan, approved 2026-10-04'])).unparsed).toBe(true)
  })

  it('forgets an unparsed line once a plan line follows it', () => {
    expect(place(issue(12, ['Round 3 plan, approved', PLAN_A])).unparsed).toBe(false)
  })

  it('skips an issue whose comments hold no plan line', () => {
    expect(roundsOf([issue(12, ['Sweep.'])])).toEqual([])
  })

  it('takes the earliest copy of the plan as the round’s plannedAt', () => {
    const early = issue(12, [PLAN_A])
    const late = { ...issue(13, [PLAN_A]), comments: [{ createdAt: at(5), firstLine: PLAN_A }] }

    expect(roundsOf([late, early])[0]?.plannedAt).toBe(at(1))
    expect(roundsOf([early, late])[0]?.plannedAt).toBe(at(1))
  })

  it('orders two rounds planned at the same time as they came', () => {
    const rows = [issue(12, [PLAN_A]), issue(20, [PLAN_B])]

    expect(roundsOf(rows).map((round) => round.plan)).toEqual([PLAN_A, PLAN_B])
  })
})

describe('what the read could not see', () => {
  it('names an issue in scope with a plan line that did not parse', async () => {
    const rows = [issue(12, ['Round 3 plan, approved 2026-10-02'])]

    const report = await reportOf([], ghOver(rows))

    expect(report.rounds).toEqual([])
    expect(report.unavailable).toEqual(['#12 has a "plan, approved" line that is not a plan line'])
  })

  it('names an issue whose newest plan is older than the comments read', async () => {
    const rows = [issue(12, ['Comment.'], { truncated: true })]

    expect((await reportOf([], ghOver(rows))).unavailable).toEqual([
      '#12 has more comments than were read, and no plan among them',
    ])
  })

  it('says nothing about a long issue whose plan was read', async () => {
    const rows = [issue(12, [PLAN_A], { truncated: true })]

    const report = await reportOf([], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.unavailable).toEqual([])
  })

  it('says nothing about an issue outside the scope, or a closed one', async () => {
    const rows = [
      issue(12, [PLAN_A], { milestone: 4 }),
      issue(30, ['Comment.'], { milestone: 5, truncated: true }),
      issue(31, ['Round 9 plan, approved'], { state: 'CLOSED', milestone: 4 }),
    ]

    expect((await reportOf(['--milestone', '4'], ghOver(rows))).unavailable).toEqual([])
    expect((await reportOf(['--issues', '12'], ghOver(rows))).unavailable).toEqual([])
  })

  it('answers with the rows that arrived, and the reason the list is short', async () => {
    const report = await reportOf([], ghOver(TWO_ROUNDS, { searchShort: 'gh: rate limit' }))

    expect(report.rounds).toHaveLength(2)
    expect(report.unavailable).toEqual(['gh: rate limit'])
  })

  it('fails, exit 1, when nothing at all could be read', async () => {
    // The harness double, which answers every call from one registration.
    const envelope = await runRounds([], {
      gh: createGhMock({ listPlanIssues: { rows: [], unavailable: 'gh: rate limit' } }),
    })

    expect(envelope).toEqual({
      outcome: 'failed',
      error: 'the rounds read nothing: gh: rate limit',
    })
  })

  it('answers no rounds when the search found nothing and nothing failed', async () => {
    expect(await reportOf([], ghOver([]))).toEqual({ rounds: [], outside: [], unavailable: [] })
  })
})

describe('usage', () => {
  // A refusal must come before any read: the double fails every read.
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
    expect(plans(await reportOf(['--issues', '12,12']))).toEqual([PLAN_A])
  })
})

describe('the report for a person', () => {
  it('lists each round with its issues, and the issues in no round', async () => {
    const rows = [issue(12, [PLAN_A], { milestone: 4 }), issue(13, [PLAN_A]), issue(30, ['x'])]

    const envelope = await runRounds(['--issues', '12,30'], { gh: ghOver(rows) })

    expect(envelope).toEqual({
      outcome: 'ok',
      value: [
        'rounds in flight (1)',
        `  ${PLAN_A}`,
        '    #12  milestone 4',
        '    #13  no milestone',
        'in no round: #30',
      ].join('\n'),
    })
  })

  it('says first that the list is incomplete', () => {
    expect(renderRounds({ rounds: [], outside: [], unavailable: ['gh: rate limit'] })).toBe(
      [
        'INCOMPLETE: the rounds below are short of what was asked for.',
        '  gh: rate limit',
        '',
        'rounds in flight (0)',
      ].join('\n'),
    )
  })
})
