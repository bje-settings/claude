// The rounds command (#376). Each example builds the plan comments of one
// repository through an in-process `gh` double, and asserts which rounds a
// scoped lookup returns. The first block is the issue's acceptance case: two
// rounds in flight on one repository, on two issue sets, with no milestone,
// and each lookup returns only its own round.
import { describe, expect, it } from 'vitest'

import { createGhMock, type GhClient, type GhResults, ghFails } from '#harness/gh.ts'
import type { IssueComments } from '#workstreams/lib/gh.ts'
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

/** The login of the person who runs `rounds`. */
const ME = 'me'

/** An open issue with these first lines, one day apart, starting on day 1.
 *  {@link ME} made each comment, unless `author` names someone else. */
const issue = (
  number: number,
  lines: readonly string[],
  fields: Partial<IssueComments> = {},
  author: string | null = ME,
): IssueComments => ({
  number,
  state: 'OPEN',
  milestone: null,
  comments: lines.map((firstLine, index) => ({ createdAt: at(index + 1), firstLine, author })),
  truncated: false,
  ...fields,
})

const PLAN_A = 'Round 3 plan, approved 2026-10-02T10:00Z.'
const PLAN_B = 'Round 4 plan, approved 2026-10-03T10:00Z.'

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

/** What the search sees: the open issues with the plan words. A real search
 *  finds nothing else, and no closed issue. */
const searchable = (rows: readonly IssueComments[]): IssueComments[] =>
  rows.filter(
    (row) =>
      row.state === 'OPEN' &&
      row.comments.some((comment) => comment.firstLine.includes('plan, approved')),
  )

/** A `gh` whose search answers `searched`, and whose direct read answers each
 *  number asked for from `direct`. Each defaults to a real view of `rows`. */
const ghOver = (
  rows: readonly IssueComments[],
  options: {
    searched?: readonly IssueComments[]
    direct?: readonly IssueComments[]
    searchShort?: string
    directShort?: string
    viewer?: GhResults['viewerLogin']
  } = {},
): GhClient => ({
  ...createGhMock(),
  viewerLogin: async () => options.viewer ?? { login: ME, unavailable: null },
  searchPlanIssues: async () => ({
    rows: options.searched ?? searchable(rows),
    unavailable: options.searchShort ?? null,
  }),
  readPlanIssues: async (numbers) => ({
    rows: (options.direct ?? rows).filter((row) => numbers.includes(row.number)),
    unavailable: options.directShort ?? null,
  }),
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
          author: ME,
          issues: [
            { number: 12, milestone: null },
            { number: 13, milestone: null },
          ],
        },
      ],
      others: [],
      viewer: ME,
      outside: [],
      unended: [],
      unavailable: [],
    })
  })

  it('returns both rounds, newest plan first, when no scope is given', async () => {
    const report = await reportOf([])

    expect(plans(report)).toEqual([PLAN_B, PLAN_A])
    expect(report).toMatchObject({ outside: null, unended: null, unavailable: [] })
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

  it('keeps two rounds of one name on one day apart by their approval time (#379)', async () => {
    const morning = 'Round 5 plan, approved 2026-10-04T09:12Z.'
    const evening = 'Round 5 plan, approved 2026-10-04T18:40Z.'
    const rows = [
      issue(12, [morning]),
      issue(20, [evening]),
      issue(21, [evening, 'Round 5 end, 2026-10-05.']),
    ]

    // The evening round ended. The morning round, of the same name, did not.
    expect(plans(await reportOf(['--issues', '12'], ghOver(rows)))).toEqual([morning])
    expect(plans(await reportOf([], ghOver(rows)))).toEqual([morning])
  })

  it('still reads a plan line with a date and no time', async () => {
    const dated = 'Round 2 plan, approved 2026-10-01.'

    expect(plans(await reportOf([], ghOver([issue(12, [dated])])))).toEqual([dated])
  })
})

describe('the rounds of other people (#484)', () => {
  /** Round 3 is mine. Round 4 is a teammate's, on milestone 5. Round 6's
   *  plan author is a deleted account. Rounds 3 and 4 were planned on one
   *  day, so they keep the order they came in. */
  const PLAN_C = 'Round 6 plan, approved 2026-10-04T10:00Z.'
  const rows: readonly IssueComments[] = [
    issue(12, ['Sweep.', PLAN_A], { milestone: 4 }),
    issue(20, ['Sweep.', PLAN_B], { milestone: 5 }, 'mate'),
    issue(21, ['Sweep.', PLAN_B], { milestone: 5 }, 'mate'),
    issue(30, [PLAN_C], {}, null),
  ]
  const TEAMMATE = {
    plan: PLAN_B,
    author: 'mate',
    plannedAt: at(2),
    issues: [
      { number: 20, milestone: 5 },
      { number: 21, milestone: 5 },
    ],
  }
  const DELETED = {
    plan: PLAN_C,
    author: null,
    plannedAt: at(1),
    issues: [{ number: 30, milestone: null }],
  }

  it('keeps my round, with its author, and names the others apart', async () => {
    const report = await reportOf([], ghOver(rows))

    expect(report.rounds).toEqual([
      {
        name: 'Round 3',
        plan: PLAN_A,
        plannedAt: at(2),
        author: ME,
        issues: [{ number: 12, milestone: 4 }],
      },
    ])
    expect(report.others).toEqual([TEAMMATE, DELETED])
    expect(report.viewer).toBe(ME)
    expect(report.unavailable).toEqual([])
  })

  it('keeps every round with --all, and names no other', async () => {
    const report = await reportOf(['--all'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A, PLAN_B, PLAN_C])
    expect(report.rounds.map((round) => round.author)).toEqual([ME, 'mate', null])
    expect(report.others).toEqual([])
    expect(report.viewer).toBe(ME)
  })

  it('gives a scope that only another person’s round holds no round and no outside issue', async () => {
    expect(await reportOf(['--issues', '20'], ghOver(rows))).toEqual({
      rounds: [],
      others: [TEAMMATE],
      viewer: ME,
      outside: [],
      unended: [],
      unavailable: [],
    })
  })

  it('names a round with a null author as another person’s', async () => {
    const report = await reportOf(['--issues', '30'], ghOver(rows))

    expect(report.rounds).toEqual([])
    expect(report.others).toEqual([DELETED])
    expect(report.outside).toEqual([])
  })

  it('keeps another person’s round with --all and --issues', async () => {
    const report = await reportOf(['--all', '--issues', '20'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_B])
    expect(report.others).toEqual([])
    expect(report.outside).toEqual([])
  })

  it('keeps another person’s round with --all and --milestone', async () => {
    expect(plans(await reportOf(['--milestone', '5'], ghOver(rows)))).toEqual([])

    const report = await reportOf(['--all', '--milestone', '5'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_B])
    expect(report.others).toEqual([])
  })

  it('takes the author of the earliest copy of the plan', () => {
    const late = {
      ...issue(13, [PLAN_A], {}, 'mate'),
      comments: [{ createdAt: at(5), firstLine: PLAN_A, author: 'mate' }],
    }

    expect(roundsOf([late, issue(12, [PLAN_A])])[0]?.author).toBe(ME)
    expect(roundsOf([issue(12, [PLAN_A]), late])[0]?.author).toBe(ME)
  })

  it('names a user it could not read, and keeps none of the rounds as mine', async () => {
    // A null author must not match a null login.
    const gh = ghOver(rows, { viewer: { login: null, unavailable: 'gh: not logged in' } })

    const report = await reportOf([], gh)

    expect(report.rounds).toEqual([])
    expect(report.others.map((round) => round.plan)).toEqual([PLAN_A, PLAN_B, PLAN_C])
    expect(report.viewer).toBeNull()
    expect(report.unavailable).toEqual(['gh: not logged in'])
  })

  it('still keeps every round with --all when the user could not be read', async () => {
    const gh = ghOver(rows, { viewer: { login: null, unavailable: 'gh: not logged in' } })

    const report = await reportOf(['--all'], gh)

    expect(report.rounds).toHaveLength(3)
    expect(report.unavailable).toEqual(['gh: not logged in'])
  })

  it('answers an empty repository when the user could not be read, rather than fail', async () => {
    const gh = ghOver([], { viewer: { login: null, unavailable: 'gh: not logged in' } })

    expect(await reportOf([], gh)).toMatchObject({ rounds: [], unavailable: ['gh: not logged in'] })
  })

  it('names each left-out round and its author in the report for a person', async () => {
    const envelope = await runRounds(['--milestone', '4,5'], { gh: ghOver(rows) })

    expect(envelope).toEqual({
      outcome: 'ok',
      value: [
        'rounds in flight (1)',
        `  ${PLAN_A}`,
        '    #12  milestone 4',
        'rounds of other people, left out (1)',
        `  ${PLAN_B}  by mate`,
      ].join('\n'),
    })
    expect(renderRounds({ ...(await reportOf(['--issues', '30'], ghOver(rows))) })).toContain(
      `  ${PLAN_C}  by an unknown author`,
    )
  })
})

describe('an issue scope', () => {
  it('names each open issue asked for that no round holds', async () => {
    const rows = [...TWO_ROUNDS, issue(30, ['Sweep.'])]

    const report = await reportOf(['--issues', '12,30'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.outside).toEqual([30])
  })

  it('names an open issue whose round ended as outside', async () => {
    const rows = [issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.'])]

    expect(await reportOf(['--issues', '12'], ghOver(rows))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: [12],
      unended: [],
      unavailable: [],
    })
  })

  it('does not name a closed issue asked for, or one it could not read, as outside', async () => {
    const report = await reportOf(['--issues', '11,12,99'])

    expect(report.outside).toEqual([])
    expect(plans(report)).toEqual([PLAN_A])
  })

  it('sees a plan the search has not indexed yet, by reading the issues directly', async () => {
    const fresh = 'Round 5 plan, approved 2026-10-04T18:22Z.'
    const gh = ghOver([issue(30, ['Sweep.', fresh])], { searched: [] })

    const report = await reportOf(['--issues', '30'], gh)

    expect(plans(report)).toEqual([fresh])
    expect(report.outside).toEqual([])
  })

  it('takes a closed state from the direct read over an open one from the search', async () => {
    const gh = ghOver(TWO_ROUNDS, {
      direct: [issue(13, ['Sweep.', PLAN_A], { state: 'CLOSED' })],
    })

    const report = await reportOf(['--issues', '13'], gh)

    expect(report.rounds).toEqual([])
    expect(report.outside).toEqual([])
    expect(report.unended).toEqual([{ number: 13, plan: PLAN_A }])
  })

  it('answers from the direct read when the search failed', async () => {
    const gh = ghOver(TWO_ROUNDS, { searched: [], searchShort: 'gh: rate limit' })

    const report = await reportOf(['--issues', '12'], gh)

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.unavailable).toEqual(['gh: rate limit'])
  })

  it('carries the reason a direct read fell short', async () => {
    const report = await reportOf(
      ['--issues', '12,99'],
      ghOver(TWO_ROUNDS, { directShort: '#99 could not be read as an issue' }),
    )

    expect(report.unavailable).toEqual(['#99 could not be read as an issue'])
  })
})

describe('a round whose issues all closed before its round end', () => {
  it('is not in flight, and its closed issues asked for are named as unended', async () => {
    const rows = [
      issue(12, [PLAN_A], { state: 'CLOSED' }),
      issue(13, [PLAN_A], { state: 'CLOSED' }),
    ]

    expect(await reportOf(['--issues', '12,13'], ghOver(rows))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: [],
      unended: [
        { number: 12, plan: PLAN_A },
        { number: 13, plan: PLAN_A },
      ],
      unavailable: [],
    })
  })

  it('names no closed issue whose round ended, or that never had a plan', async () => {
    const rows = [
      issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.'], { state: 'CLOSED' }),
      issue(13, ['Sweep.'], { state: 'CLOSED' }),
    ]

    expect((await reportOf(['--issues', '12,13'], ghOver(rows))).unended).toEqual([])
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

  it('does not end a round on an end record from before its plan', async () => {
    const rows = [issue(12, ['Round 3 end, x.', PLAN_A])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([PLAN_A])
  })

  describe('in the older heading form (#405)', () => {
    const TRIAGE = 'Triage pass plan, approved 2026-10-01T09:00Z.'

    it('ends the round on a "## Round end: <round>" heading after its plan', async () => {
      const rows = [issue(28, [TRIAGE, '## Round end: Triage pass'])]

      expect(plans(await reportOf(['--issues', '28'], ghOver(rows)))).toEqual([])
      expect(place(rows[0] as IssueComments).plan?.ended).toBe(true)
    })

    it('ends the round when the name differs only in case', async () => {
      const rows = [issue(28, [TRIAGE, '## Round end: triage PASS'])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([])
    })

    it('ends the round when the heading words differ in case, or a space is added', async () => {
      const cased = [issue(28, [TRIAGE, '## round END: Triage pass'])]
      const spaced = [issue(28, [TRIAGE, '## Round end:  Triage pass'])]

      expect(plans(await reportOf([], ghOver(cased)))).toEqual([])
      expect(plans(await reportOf([], ghOver(spaced)))).toEqual([])
    })

    it('still ends the round on the current "<round> end," form', async () => {
      const rows = [issue(28, [TRIAGE, 'Triage pass end, 2026-10-03.'])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([])
    })

    it('does not end the round on a heading for another round', async () => {
      const rows = [issue(28, [TRIAGE, '## Round end: Docs refresh'])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([TRIAGE])
    })

    it('does not end the round on a heading for a longer name', async () => {
      const rows = [issue(28, [TRIAGE, '## Round end: Triage pass two'])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([TRIAGE])
    })

    it('does not end the round on a heading that does not start the line', async () => {
      const rows = [issue(28, [TRIAGE, 'Note: ## Round end: Triage pass'])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([TRIAGE])
    })

    it('does not end the round on a heading from before its plan', async () => {
      const rows = [issue(28, ['## Round end: Triage pass', TRIAGE])]

      expect(plans(await reportOf([], ghOver(rows)))).toEqual([TRIAGE])
    })
  })

  it('reads a new plan after an end record as a round in flight again', async () => {
    const again = 'Round 3 plan, approved 2026-10-05T10:00Z.'
    const rows = [issue(12, [PLAN_A, 'Round 3 end, 2026-10-04.', again])]

    expect(plans(await reportOf([], ghOver(rows)))).toEqual([again])
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

  it('gives null outside and unended: a search cannot see the milestone’s other issues', async () => {
    expect(await reportOf(['--milestone', '6'], ghOver(rows))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: null,
      unended: null,
      unavailable: [],
    })
  })
})

describe('place and roundsOf', () => {
  it('reads a heading or a quote of a plan as a plan that did not parse', () => {
    expect(place(issue(12, ['## Round 3 plan, approved 2026-10-02.']))).toEqual({
      plan: null,
      unparsed: true,
    })
  })

  it('reads a plan line with no final period as a plan that did not parse', () => {
    expect(place(issue(12, [PLAN_A, 'Round 5 plan, approved 2026-10-04'])).unparsed).toBe(true)
  })

  it('forgets an unparsed line once a plan line follows it', () => {
    expect(place(issue(12, ['Round 3 plan, approved', PLAN_A]))).toEqual({
      plan: { name: 'Round 3', line: PLAN_A, at: at(2), author: ME, ended: false },
      unparsed: false,
    })
  })

  it('keeps an ended plan ended when an unparsed line follows the end record', () => {
    expect(place(issue(12, [PLAN_A, 'Round 3 end, x.', 'Round 9 plan, approved']))).toEqual({
      plan: { name: 'Round 3', line: PLAN_A, at: at(1), author: ME, ended: true },
      unparsed: true,
    })
  })

  it('skips an issue whose comments hold no plan line', () => {
    expect(roundsOf([issue(12, ['Sweep.'])])).toEqual([])
  })

  it('takes the earliest copy of the plan as the round’s plannedAt', () => {
    const early = issue(12, [PLAN_A])
    const late = {
      ...issue(13, [PLAN_A]),
      comments: [{ createdAt: at(5), firstLine: PLAN_A, author: ME }],
    }

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

  it('names an issue of a round in scope with a newer plan that did not parse', async () => {
    // #13 is outside the scope, but it sits in #12's round under its older
    // plan, so the grouping cannot be trusted without a word.
    const rows = [issue(12, [PLAN_A]), issue(13, [PLAN_A, 'Round 9 plan, approved'])]

    const report = await reportOf(['--issues', '12'], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.unavailable).toEqual(['#13 has a "plan, approved" line that is not a plan line'])
  })

  it('names an issue the search found with no plan in the comments read', async () => {
    const long = issue(12, ['Comment.'], { truncated: true })

    expect((await reportOf([], ghOver([long], { searched: [long] }))).unavailable).toEqual([
      '#12 has more comments than were read, and no plan among them',
    ])
  })

  it('names an issue in both outside and unavailable when both hold', async () => {
    const long = issue(30, ['Comment.'], { truncated: true })

    expect(await reportOf(['--issues', '30'], ghOver([long], { searched: [long] }))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: [30],
      unended: [],
      unavailable: ['#30 has more comments than were read, and no plan among them'],
    })
  })

  it('says nothing about a long issue read directly that the search did not find', async () => {
    // A long-running issue that never had a plan: it can still be planned.
    const rows = [issue(412, ['Comment.'], { truncated: true })]

    expect(await reportOf(['--issues', '412'], ghOver(rows))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: [412],
      unended: [],
      unavailable: [],
    })
  })

  it('says nothing about a long issue whose plan was read', async () => {
    const rows = [issue(12, [PLAN_A], { truncated: true })]

    const report = await reportOf([], ghOver(rows))

    expect(plans(report)).toEqual([PLAN_A])
    expect(report.unavailable).toEqual([])
  })

  it('says nothing about an issue outside the scope and its rounds, or a closed one', async () => {
    const rows = [
      issue(12, [PLAN_A], { milestone: 4 }),
      issue(30, ['Round 9 plan, approved'], { milestone: 5 }),
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
      gh: createGhMock({ searchPlanIssues: { rows: [], unavailable: 'gh: rate limit' } }),
    })

    expect(envelope).toEqual({
      outcome: 'failed',
      error: 'the rounds read nothing: gh: rate limit',
    })
  })

  it('fails, exit 1, when neither the search nor the direct read read anything', async () => {
    const envelope = await runRounds(['--issues', '12'], {
      gh: createGhMock({
        searchPlanIssues: { rows: [], unavailable: 'gh: rate limit' },
        readPlanIssues: { rows: [], unavailable: 'gh: timeout' },
      }),
    })

    expect(envelope).toEqual({
      outcome: 'failed',
      error: 'the rounds read nothing: gh: rate limit; gh: timeout',
    })
  })

  it('answers no rounds when the search found nothing and nothing failed', async () => {
    expect(await reportOf([], ghOver([]))).toEqual({
      rounds: [],
      others: [],
      viewer: ME,
      outside: null,
      unended: null,
      unavailable: [],
    })
  })
})

describe('usage', () => {
  // A refusal must come before any read: the double fails every read.
  const refusing = {
    gh: createGhMock({
      searchPlanIssues: ghFails('must not be read'),
      readPlanIssues: ghFails('must not be read'),
    }),
  }

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
  it('lists each round with its issues, the issues in no round, and the unended ones', async () => {
    const rows = [
      issue(12, [PLAN_A], { milestone: 4 }),
      issue(13, [PLAN_A]),
      issue(30, ['x']),
      issue(40, [PLAN_B], { state: 'CLOSED' }),
    ]

    const envelope = await runRounds(['--issues', '12,30,40'], { gh: ghOver(rows) })

    expect(envelope).toEqual({
      outcome: 'ok',
      value: [
        'rounds in flight (1)',
        `  ${PLAN_A}`,
        '    #12  milestone 4',
        '    #13  no milestone',
        'in no round: #30',
        `closed with no round end: #40  ${PLAN_B}`,
      ].join('\n'),
    })
  })

  it('says first that the list is incomplete', () => {
    expect(
      renderRounds({
        rounds: [],
        others: [],
        viewer: null,
        outside: null,
        unended: null,
        unavailable: ['gh: rate limit'],
      }),
    ).toBe(
      [
        'INCOMPLETE: the rounds below are short of what was asked for.',
        '  gh: rate limit',
        '',
        'rounds in flight (0)',
      ].join('\n'),
    )
  })
})
