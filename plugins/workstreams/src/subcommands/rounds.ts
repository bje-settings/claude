// The rounds in flight: which open issues each one holds, read from the plan
// and round-end comments on them (#376).
//
// A round's identity is its issue set. Each issue belongs to the round of
// its newest plan comment, and to no other. So a lookup by one round's
// issues cannot reach a round that holds other issues. A milestone can hold
// the issues of more than one round. A round is in flight while one of its
// issues is open, until a comment after its plan starts with `<round> end,`.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type { GhClient, IssueComments } from '../lib/gh.ts'
import { numberList, repeated } from '../number-list.ts'

export const HELP = `The rounds in flight, read from the plan comments on their open issues.

Usage:
  workstreams.ts rounds [--issues 12,13 | --milestone 4,5] [--json]

A plan comment's first line is "<round> plan, approved <date>.", and the
round's name starts with a letter or a digit. Each open issue belongs to the
round of its newest plan comment. A round is in flight while one of its
issues is open, until a comment after its plan, on any of its open issues,
starts with "<round> end,". For each round in flight, the report gives:

  name        the round's name, from the plan's first line
  plan        the plan's whole first line, which is the round's identity
  plannedAt   when the first copy of the plan was made
  issues      every open issue of the round, with its state and milestone

The plan comment names every issue of the round, the closed ones too.

--issues names the rounds that hold any of those issues, and reads those
issues directly, so a plan made a moment ago is seen. "outside" then names
each open issue asked for that no round in flight holds. --milestone names
the rounds that hold an open issue on one of those milestones. With neither,
every round in flight is named. The two are not given together: a round has
one scope. A leading # on a number is allowed.

The other plans come from a GitHub search, which can take a minute to see a
new comment.

"unavailable" names, in the scope, each issue with a "plan, approved" line
newer than its newest plan line that is not a plan line, and each issue
whose newest plan is older than the 100 comments read.

--json prints the report as one JSON object for a skill to read; without it
the same report is printed for a person.

Exits 2 on a usage error, and 1 only when nothing at all could be read. A
read that partly failed is still an answer, with every reason it is short
under "unavailable".`

const SPEC = {
  issues: { type: 'string', default: '' },
  milestone: { type: 'string', default: '' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** A plan comment's first line. The one group is the round's name, which
 *  starts with a letter or a digit, so a Markdown heading or a quote is not
 *  a plan line. */
const PLAN_LINE = /^([A-Za-z0-9].*?) plan, approved \S+\.$/

/** The words the search matches. A first line that holds them and is not a
 *  plan line is a plan that did not parse. */
const PLAN_WORDS = 'plan, approved'

/** One issue of a round, as the report carries it. */
export type RoundIssue = Pick<IssueComments, 'number' | 'state' | 'milestone'>

/** One round in flight. */
export interface Round {
  /** The round's name. It comes from {@link Round.plan}. */
  readonly name: string
  /** The plan's whole first line. It carries the date, and it is the
   *  round's identity: two rounds of one name on two days stay apart. */
  readonly plan: string
  readonly plannedAt: string
  readonly issues: readonly RoundIssue[]
}

/** The whole report. */
export interface RoundsReport {
  readonly rounds: readonly Round[]
  /** With `--issues`, each open issue asked for that no round in flight
   *  holds. Empty otherwise. */
  readonly outside: readonly number[]
  /** Every reason the answer is short. Empty is the only value that means
   *  the list is complete. */
  readonly unavailable: readonly string[]
}

/** Where one issue stands. */
interface Placed {
  /** The newest plan line, or null when no comment read holds one. */
  readonly plan: { readonly name: string; readonly line: string; readonly at: string } | null
  /** An end record for that plan's round follows it. */
  readonly ended: boolean
  /** A first line with the plan words, newer than the newest plan line,
   *  that is not a plan line. */
  readonly unparsed: boolean
}

/** The round of an issue's newest plan comment, and what else its comments
 *  say about it. */
export const place = (issue: IssueComments): Placed => {
  let plan: Placed['plan'] = null
  let ended = false
  let unparsed = false
  for (const comment of issue.comments) {
    const match = PLAN_LINE.exec(comment.firstLine)
    if (match !== null) {
      plan = { name: match[1] as string, line: comment.firstLine, at: comment.createdAt }
      ended = false
      unparsed = false
    } else if (comment.firstLine.includes(PLAN_WORDS)) {
      unparsed = true
    } else if (plan !== null && comment.firstLine.startsWith(`${plan.name} end,`)) {
      ended = true
    }
  }
  return { plan, ended, unparsed }
}

/**
 * The rounds in flight, newest plan first, over the open issues.
 *
 * Issues group by the plan's whole first line, not by the name alone. A
 * round has ended when any of its open issues carries the end record,
 * because the round end posts it on each issue.
 */
export const roundsOf = (issues: readonly IssueComments[]): Round[] => {
  const groups = new Map<
    string,
    { name: string; at: string; ended: boolean; issues: RoundIssue[] }
  >()
  for (const issue of issues) {
    if (issue.state !== 'OPEN') continue
    const { plan, ended } = place(issue)
    if (plan === null) continue
    const entry = { number: issue.number, state: issue.state, milestone: issue.milestone }
    const group = groups.get(plan.line)
    if (group === undefined) {
      groups.set(plan.line, { name: plan.name, at: plan.at, ended, issues: [entry] })
      continue
    }
    group.issues.push(entry)
    group.ended ||= ended
    if (plan.at < group.at) group.at = plan.at
  }
  const rounds: Round[] = []
  for (const [plan, group] of groups) {
    if (group.ended) continue
    rounds.push({
      name: group.name,
      plan,
      plannedAt: group.at,
      issues: group.issues.sort((left, right) => left.number - right.number),
    })
  }
  // Newest first, by plain string order: GitHub's times are fixed-width ISO
  // 8601 in UTC, so string order is time order.
  return rounds.sort(
    (left, right) =>
      Number(right.plannedAt > left.plannedAt) - Number(right.plannedAt < left.plannedAt),
  )
}

/** The report, for a person. */
export const renderRounds = (report: RoundsReport): string => {
  const lines: string[] = []
  if (report.unavailable.length > 0) {
    lines.push('INCOMPLETE: the rounds below are short of what was asked for.')
    for (const reason of report.unavailable) lines.push(`  ${reason}`)
    lines.push('')
  }
  lines.push(`rounds in flight (${report.rounds.length})`)
  for (const round of report.rounds) {
    lines.push(`  ${round.plan}`)
    for (const issue of round.issues) {
      const milestone = issue.milestone === null ? 'no milestone' : `milestone ${issue.milestone}`
      lines.push(`    #${issue.number}  ${milestone}`)
    }
  }
  if (report.outside.length > 0) {
    lines.push(`in no round: ${report.outside.map((number) => `#${number}`).join(', ')}`)
  }
  return lines.join('\n')
}

/** The edges this command reads: one `gh`, and nothing else. */
export interface RoundsContext {
  readonly gh: GhClient
}

/** Read the plans and answer with the rounds in flight, rendered. */
export const runRounds = async (
  argv: readonly string[],
  context: RoundsContext,
): Promise<Envelope<string>> => {
  const parsed = parseArguments(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.help) return ok(HELP)
  for (const flag of ['--issues', '--milestone']) {
    if (repeated(argv, flag))
      return refused(`${flag} is not repeatable; pass one comma-separated list`)
  }
  const issues = numberList(parsed.value.issues, '--issues', 'issue')
  if (issues.outcome !== 'ok') return issues
  const milestones = numberList(parsed.value.milestone, '--milestone', 'milestone')
  if (milestones.outcome !== 'ok') return milestones
  if (issues.value.length > 0 && milestones.value.length > 0) {
    return refused('--issues and --milestone are not given together; a round has one scope')
  }

  const unavailable: string[] = []
  const searched = await context.gh.listPlanIssues()
  if (searched.unavailable !== null) unavailable.push(searched.unavailable)
  // The issues asked for are read directly too, and that read wins: the
  // search index can lag a new plan by a minute.
  const rows = new Map(searched.rows.map((row) => [row.number, row]))
  if (issues.value.length > 0) {
    const direct = await context.gh.listPlanIssues({ numbers: issues.value })
    if (direct.unavailable !== null) unavailable.push(direct.unavailable)
    for (const row of direct.rows) rows.set(row.number, row)
  }
  if (rows.size === 0 && unavailable.length > 0) {
    return failed(`the rounds read nothing: ${unavailable.join('; ')}`)
  }

  const inScope = (issue: Pick<IssueComments, 'number' | 'milestone'>): boolean =>
    (issues.value.length === 0 || issues.value.includes(issue.number)) &&
    (milestones.value.length === 0 ||
      (issue.milestone !== null && milestones.value.includes(issue.milestone)))

  for (const issue of rows.values()) {
    if (issue.state !== 'OPEN' || !inScope(issue)) continue
    const { plan, unparsed } = place(issue)
    if (unparsed) {
      unavailable.push(`#${issue.number} has a "${PLAN_WORDS}" line that is not a plan line`)
    } else if (plan === null && issue.truncated) {
      unavailable.push(`#${issue.number} has more comments than were read, and no plan among them`)
    }
  }

  const rounds = roundsOf([...rows.values()]).filter((round) => round.issues.some(inScope))
  const held = new Set(rounds.flatMap((round) => round.issues.map((issue) => issue.number)))
  const outside = issues.value.filter(
    (number) => rows.get(number)?.state === 'OPEN' && !held.has(number),
  )
  const report: RoundsReport = { rounds, outside, unavailable }
  return ok(parsed.value.json ? JSON.stringify(report) : renderRounds(report))
}
