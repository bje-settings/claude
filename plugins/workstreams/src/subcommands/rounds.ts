// The rounds in flight: which issues each one holds, read from the plan and
// round-end comments on them (#376).
//
// A round's identity is its issue set. Each issue belongs to the round of
// its newest plan comment, and to no other. So two rounds on one
// repository, on two issue sets, never read each other's state: a lookup
// scoped to one round's issues or milestone cannot reach the other round.
// A round is in flight until a comment after its plan starts with
// `<round> end`.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type { GhClient, IssueComments, IssueState } from '../lib/gh.ts'
import { numberList, repeated } from '../number-list.ts'

export const HELP = `The rounds in flight, read from the plan comments on their issues.

Usage:
  workstreams.ts rounds [--issues 12,13 | --milestone 4] [--json]

A plan comment's first line is "<round> plan, approved <date>." Each issue
belongs to the round of its newest plan comment. A round is in flight until
a comment after its plan, on any issue of the round, starts with
"<round> end". For each round in flight, the report gives:

  name        the round's name, from the plan's first line
  plan        the plan's whole first line
  plannedAt   when the first copy of the plan was made
  issues      every issue of the round, open or closed, with its milestone

--issues names the rounds that hold any of those issues. --milestone names
the rounds that hold any issue on that milestone. With neither, every round
in flight is named. The two are not given together: a round has one scope.

The plans come from a GitHub search, which can take a minute to see a new
comment.

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

/** A plan comment's first line: the round's name, and the date. */
const PLAN_LINE = /^(.+) plan, approved \S+\.$/

/** One issue of a round, as the report carries it. */
export interface RoundIssue {
  readonly number: number
  readonly state: IssueState
  readonly milestone: number | null
}

/** One round in flight. */
export interface Round {
  readonly name: string
  readonly plan: string
  readonly plannedAt: string
  readonly issues: readonly RoundIssue[]
}

/** The whole report. */
export interface RoundsReport {
  readonly rounds: readonly Round[]
  /** Every reason the answer is short. Empty is the only value that means
   *  the list is complete. */
  readonly unavailable: readonly string[]
}

/** Where one issue stands: the round of its newest plan, and whether that
 *  round has ended on this issue. */
interface Placed {
  readonly issue: IssueComments
  readonly name: string
  readonly plan: string
  readonly plannedAt: string
  readonly ended: boolean
}

/** The round of an issue's newest plan comment, or null for an issue that
 *  the search found but whose comments hold no plan line. */
const place = (issue: IssueComments): Placed | null => {
  let plan: { name: string; line: string; at: string } | null = null
  let ended = false
  for (const comment of issue.comments) {
    const match = PLAN_LINE.exec(comment.firstLine)
    if (match !== null) {
      plan = { name: match[1] as string, line: comment.firstLine, at: comment.createdAt }
      ended = false
    } else if (plan !== null && comment.firstLine.startsWith(`${plan.name} end`)) {
      ended = true
    }
  }
  if (plan === null) return null
  return { issue, name: plan.name, plan: plan.line, plannedAt: plan.at, ended }
}

/**
 * The rounds in flight, newest plan first.
 *
 * Issues group by the plan's whole first line, not by the name alone. The
 * line carries the date, so two rounds that took the same name on two days
 * stay apart. A round has ended when any of its issues carries the end
 * record, because the round end posts it on each issue, and one that did
 * not post on every issue has still ended.
 */
export const roundsOf = (issues: readonly IssueComments[]): Round[] => {
  const groups = new Map<string, Placed[]>()
  for (const issue of issues) {
    const placed = place(issue)
    if (placed === null) continue
    const group = groups.get(placed.plan)
    if (group === undefined) groups.set(placed.plan, [placed])
    else group.push(placed)
  }
  const rounds: Round[] = []
  for (const [plan, group] of groups) {
    if (group.some((entry) => entry.ended)) continue
    const first = group.reduce((earliest, entry) =>
      entry.plannedAt < earliest.plannedAt ? entry : earliest,
    )
    rounds.push({
      name: first.name,
      plan,
      plannedAt: first.plannedAt,
      issues: group
        .map(({ issue }) => ({
          number: issue.number,
          state: issue.state,
          milestone: issue.milestone,
        }))
        .sort((left, right) => left.number - right.number),
    })
  }
  return rounds.sort((left, right) => right.plannedAt.localeCompare(left.plannedAt))
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
      lines.push(`    #${issue.number}  ${issue.state.toLowerCase()}  ${milestone}`)
    }
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

  const answer = await context.gh.listPlanIssues()
  const unavailable = answer.unavailable === null ? [] : [answer.unavailable]
  if (answer.rows.length === 0 && unavailable.length > 0) {
    return failed(`the rounds read nothing: ${unavailable.join('; ')}`)
  }
  // An issue with more comments than the read asks for can hold an older
  // plan that is not here. The newest plan is the one that counts, so this
  // is short only when the plan is older than every comment read.
  for (const issue of answer.rows) {
    if (issue.truncated) {
      unavailable.push(
        `#${issue.number} has more comments than were read; an older plan is not seen`,
      )
    }
  }

  const holds = (round: Round): boolean =>
    round.issues.some(
      (issue) =>
        (issues.value.length === 0 || issues.value.includes(issue.number)) &&
        (milestones.value.length === 0 ||
          (issue.milestone !== null && milestones.value.includes(issue.milestone))),
    )
  const report: RoundsReport = { rounds: roundsOf(answer.rows).filter(holds), unavailable }
  return ok(parsed.value.json ? JSON.stringify(report) : renderRounds(report))
}
