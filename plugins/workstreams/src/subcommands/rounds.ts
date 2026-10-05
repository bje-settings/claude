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

A plan comment's first line is "<round> plan, approved <time>.", where the
time is the approval to the minute, in UTC. The round's name starts with a
letter or a digit. Each open issue belongs to the round of its newest plan
comment. A round is in flight while one of its issues is open, until a
comment after its plan, on any of its open issues, starts with
"<round> end,". For each round in flight, the report gives:

  name        the round's name, from the plan's first line
  plan        the plan's whole first line, which is the round's identity
  plannedAt   when the first copy of the plan on an open issue was made
  issues      every open issue of the round, with its milestone

The plan comment names every issue of the round, the closed ones too. A
round whose issues all closed before its round end is not in flight.

--issues names the rounds that hold any of those issues, and reads those
issues directly, so a plan made a moment ago is seen. With --issues:

  outside     each open issue asked for that no round in flight holds
  unended     each closed issue asked for whose newest plan has no end
              record after it, with that plan's first line

Both are null without --issues. --milestone names the rounds that hold an
open issue on one of those milestones. With neither, every round in flight
is named. The two are not given together: a round has one scope. A leading
# on a number is allowed.

The other plans come from a GitHub search, which can take a minute to see a
new comment.

"unavailable" also names each open issue in the scope, or in a round in the
scope, with a "plan, approved" line newer than its newest plan line that is
not a plan line. It also names each such issue that the search found with
no plan in its 100 newest comments.

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

/** One open issue of a round, as the report carries it. */
export type RoundIssue = Pick<IssueComments, 'number' | 'milestone'>

/** One round in flight. */
export interface Round {
  /** The round's name. It comes from {@link Round.plan}. */
  readonly name: string
  /** The plan's whole first line. It carries the approval time, and it is
   *  the round's identity: two rounds of one name stay apart. */
  readonly plan: string
  readonly plannedAt: string
  readonly issues: readonly RoundIssue[]
}

/** A closed issue asked for whose newest plan has no end record. */
export interface UnendedIssue {
  readonly number: number
  readonly plan: string
}

/** The whole report. */
export interface RoundsReport {
  readonly rounds: readonly Round[]
  /** With `--issues`, each open issue asked for that no round in flight
   *  holds. Null without `--issues`, because a search sees only the issues
   *  with a plan, so it cannot say which other issues a scope holds. */
  readonly outside: readonly number[] | null
  /** With `--issues`, each closed issue asked for whose round did not end.
   *  Null without `--issues`. */
  readonly unended: readonly UnendedIssue[] | null
  /** Every reason the answer is short. Empty is the only value that means
   *  the list is complete. */
  readonly unavailable: readonly string[]
}

/** Where one issue stands. */
interface Placed {
  /** The newest plan line, and whether an end record for its round
   *  follows it, or null when no comment read holds a plan line. */
  readonly plan: {
    readonly name: string
    readonly line: string
    readonly at: string
    readonly ended: boolean
  } | null
  /** A first line with the plan words, newer than the newest plan line,
   *  that is not a plan line. */
  readonly unparsed: boolean
}

/** The round of an issue's newest plan comment, and what else its comments
 *  say about it. */
export const place = (issue: IssueComments): Placed => {
  let newest: { name: string; line: string; at: string } | null = null
  let ended = false
  let unparsed = false
  for (const comment of issue.comments) {
    const match = PLAN_LINE.exec(comment.firstLine)
    if (match !== null) {
      newest = { name: match[1] as string, line: comment.firstLine, at: comment.createdAt }
      ended = false
      unparsed = false
    } else if (comment.firstLine.includes(PLAN_WORDS)) {
      unparsed = true
    } else if (newest !== null && comment.firstLine.startsWith(`${newest.name} end,`)) {
      ended = true
    }
  }
  return { plan: newest === null ? null : { ...newest, ended }, unparsed }
}

/**
 * The rounds in flight, newest plan first, over the open issues.
 *
 * Issues group by the plan's whole first line, not by the name alone. A
 * round has ended when any of its open issues carries the end record,
 * because the round end posts it on each issue. An issue with a newer plan
 * that did not parse stays under its last plan line here. `runRounds`
 * names it under `unavailable`, so a caller does not trust that grouping.
 */
export const roundsOf = (issues: readonly IssueComments[]): Round[] => {
  const groups = new Map<
    string,
    { name: string; at: string; ended: boolean; issues: RoundIssue[] }
  >()
  for (const issue of issues) {
    if (issue.state !== 'OPEN') continue
    const { plan } = place(issue)
    if (plan === null) continue
    const entry = { number: issue.number, milestone: issue.milestone }
    const group = groups.get(plan.line)
    if (group === undefined) {
      groups.set(plan.line, { name: plan.name, at: plan.at, ended: plan.ended, issues: [entry] })
      continue
    }
    group.issues.push(entry)
    group.ended ||= plan.ended
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
  if (report.outside !== null && report.outside.length > 0) {
    lines.push(`in no round: ${report.outside.map((number) => `#${number}`).join(', ')}`)
  }
  for (const issue of report.unended ?? []) {
    lines.push(`closed with no round end: #${issue.number}  ${issue.plan}`)
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
  const byIssues = issues.value.length > 0

  const unavailable: string[] = []
  const searched = await context.gh.searchPlanIssues()
  if (searched.unavailable !== null) unavailable.push(searched.unavailable)
  // Only an issue the search found is known to carry a plan comment. A
  // long issue read directly with no plan in view may never have had one.
  const found = new Set(searched.rows.map((row) => row.number))
  // The issues asked for are read directly too, and that read wins: the
  // search index can lag a new plan by a minute.
  const rows = new Map(searched.rows.map((row) => [row.number, row]))
  if (byIssues) {
    const direct = await context.gh.readPlanIssues(issues.value)
    if (direct.unavailable !== null) unavailable.push(direct.unavailable)
    for (const row of direct.rows) rows.set(row.number, row)
  }
  if (rows.size === 0 && unavailable.length > 0) {
    return failed(`the rounds read nothing: ${unavailable.join('; ')}`)
  }

  const inScope = (issue: RoundIssue): boolean =>
    (!byIssues || issues.value.includes(issue.number)) &&
    (milestones.value.length === 0 ||
      (issue.milestone !== null && milestones.value.includes(issue.milestone)))

  const rounds = roundsOf([...rows.values()]).filter((round) => round.issues.some(inScope))
  const held = new Set(rounds.flatMap((round) => round.issues.map((issue) => issue.number)))

  for (const issue of rows.values()) {
    if (issue.state !== 'OPEN' || !(inScope(issue) || held.has(issue.number))) continue
    const { plan, unparsed } = place(issue)
    if (unparsed) {
      unavailable.push(`#${issue.number} has a "${PLAN_WORDS}" line that is not a plan line`)
    } else if (plan === null && issue.truncated && found.has(issue.number)) {
      unavailable.push(`#${issue.number} has more comments than were read, and no plan among them`)
    }
  }

  const asked = issues.value.flatMap((number) => {
    const row = rows.get(number)
    return row === undefined ? [] : [row]
  })
  const outside = byIssues
    ? asked.filter((row) => row.state === 'OPEN' && !held.has(row.number)).map((row) => row.number)
    : null
  const unended = byIssues
    ? asked.flatMap((row) => {
        if (row.state === 'OPEN') return []
        const { plan } = place(row)
        return plan === null || plan.ended ? [] : [{ number: row.number, plan: plan.line }]
      })
    : null
  const report: RoundsReport = { rounds, outside, unended, unavailable }
  return ok(parsed.value.json ? JSON.stringify(report) : renderRounds(report))
}
