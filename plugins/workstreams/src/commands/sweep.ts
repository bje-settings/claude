// The sweep: primitive 1 of #111. What a round could start on, read from the
// issue tracker, which is the source of truth.
//
// The deterministic half of the sweep is here and the judgement is in
// `skills/sweep` (CLAUDE.md, "Plugin design"): this command answers which
// issues are unblocked, which are one issue behind that, and which are
// further out, and it answers nothing about what any of them touches or how
// they should be sequenced. Those are readings of the issue bodies and of the
// tree, and a script that guessed at them would be guessing where the skill
// can look.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { type ArgSpec, parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type { GhClient, IssueRef, IssueSummary, MilestoneSummary } from '../lib/gh.ts'

export const HELP = `What a round could start on, read from the issue tracker.

Usage:
  workstreams.ts sweep [--milestone 4,5] [--json]

Reports the repository's open milestones with their issue counts, every open
pull request including ones no round opened, and, for each milestone asked
for plus the issues on no milestone at all:

  unblocked   every blockedBy entry closed, or none at all
  next tier   exactly one open blocker, and that blocker is itself unblocked
  blocked     everything else, with its open blockers named

--milestone takes one number or a comma-separated list, and scopes the report
to those milestones and the issues on none. Left out, every open milestone is
swept, and so is any other milestone the issues that were read name for
themselves, so that nothing read goes unreported. It is not repeatable: a
second --milestone would silently replace the first, so it is refused and the
comma list named instead.

--json prints the report as one JSON object for a skill to read; without it
the same report is printed for a person.

Exits 2 on a usage error, and 1 only when nothing at all could be read. A
read that partly failed is still an answer: the rows that arrived are
reported and every reason the answer is short is listed under "unavailable",
which a caller reads before acting on the sets.`

const SPEC = {
  milestone: { type: 'string', default: '' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const satisfies ArgSpec

/** Which of the three sets an issue falls in. Each value is also the key its
 *  set has on a {@link Group}, so a caller holding a tier can read the set
 *  without a lookup table between them. */
export type Tier = 'unblocked' | 'next' | 'blocked'

const TIERS: readonly Tier[] = ['unblocked', 'next', 'blocked']

/** What each tier is called in the report a person reads. */
const TIER_LABELS: Record<Tier, string> = {
  unblocked: 'unblocked',
  next: 'next tier',
  blocked: 'blocked',
}

/** A relationship, as the report carries it. */
export interface ReportedRef {
  readonly number: number
  readonly state: string
}

/**
 * One issue as the report carries it.
 *
 * `blockedBy` is kept whole beside `openBlockers` because "no blockers at
 * all" and "every blocker closed" are different facts about an unblocked
 * issue, and a reader of the unblocked set acts on the difference: the first
 * is work nothing was waiting for, the second is work a round just released.
 */
export interface ReportedIssue {
  readonly number: number
  readonly title: string
  /** The milestone's number, or null for an issue on none. */
  readonly milestone: number | null
  readonly labels: readonly string[]
  readonly blockedBy: readonly ReportedRef[]
  readonly openBlockers: readonly number[]
  readonly blocking: readonly ReportedRef[]
  /** The pull requests that would close this issue, including closed ones. */
  readonly pullRequests: readonly ReportedRef[]
  readonly tier: Tier
}

/** A milestone as a group's header. `title` and the counts are null for a
 *  milestone that was asked for and is not among the open ones: it was still
 *  swept, and saying so is not the same as inventing a title for it. */
export interface GroupHeader {
  readonly number: number
  readonly title: string | null
  readonly openIssues: number | null
  readonly closedIssues: number | null
}

/** One milestone's three sets, or the unassigned issues' when `milestone` is
 *  null. */
export interface Group {
  readonly milestone: GroupHeader | null
  readonly unblocked: readonly ReportedIssue[]
  readonly next: readonly ReportedIssue[]
  readonly blocked: readonly ReportedIssue[]
}

export interface SweepReport {
  readonly milestones: readonly MilestoneSummary[]
  readonly pullRequests: ReadonlyArray<{
    readonly number: number
    readonly title: string
    readonly head: string
    readonly base: string
    readonly draft: boolean
  }>
  readonly groups: readonly Group[]
  readonly unassigned: Group
  /** The same three sets across every group above, as numbers. */
  readonly combined: Record<Tier, readonly number[]>
  /** Every reason this report is short of what was asked for. An empty list
   *  is the only value that means the sets are complete. */
  readonly unavailable: readonly string[]
}

/** Refs as the plain pairs the report is made of. */
const refs = (list: readonly IssueRef[]): ReportedRef[] =>
  list.map((ref) => ({ number: ref.number, state: ref.state }))

/**
 * Every issue's tier, computed over the whole set that was read rather than
 * once per milestone.
 *
 * The next tier is defined against the unblocked set, and a blocker is
 * frequently on another milestone or on none at all, so a per-milestone
 * computation would answer a different question for each group depending on
 * where its blockers happened to live. Reading the unfiltered issue list once
 * is what makes one answer possible.
 *
 * An issue whose single open blocker was not read at all cannot be in the
 * unblocked set, so it reports as blocked. That is the conservative
 * direction: a page that could not be read makes the sweep claim less, never
 * more.
 *
 * A blocker that is not OPEN does not block, whether it is CLOSED or MERGED:
 * a pull request recorded as a dependency is done when it has merged.
 */
export const classify = (issues: readonly IssueSummary[]): ReportedIssue[] => {
  const entries = issues.map((issue) => ({
    issue,
    openBlockers: issue.blockedBy.filter((ref) => ref.state === 'OPEN').map((ref) => ref.number),
  }))
  const unblocked = new Set(
    entries.filter((entry) => entry.openBlockers.length === 0).map((entry) => entry.issue.number),
  )

  return entries.map(({ issue, openBlockers }) => {
    let tier: Tier = 'blocked'
    if (openBlockers.length === 0) tier = 'unblocked'
    // The cast is `noUncheckedIndexedAccess` being exact about an array of
    // unknown length: the count was just checked, so index 0 is there. Worth
    // saying, because a weakened count check would not fail here, it would
    // make `has(undefined)` quietly false and misfile the issue.
    else if (openBlockers.length === 1 && unblocked.has(openBlockers[0] as number)) tier = 'next'
    return {
      number: issue.number,
      title: issue.title,
      milestone: issue.milestone === null ? null : issue.milestone.number,
      labels: [...issue.labels],
      blockedBy: refs(issue.blockedBy),
      openBlockers,
      blocking: refs(issue.blocking),
      pullRequests: refs(issue.pullRequests),
      tier,
    }
  })
}

/** One group, from the classified issues that belong to its milestone. */
const groupOf = (milestone: GroupHeader | null, issues: readonly ReportedIssue[]): Group => {
  const number = milestone === null ? null : milestone.number
  const mine = issues.filter((issue) => issue.milestone === number)
  const taken = (tier: Tier): ReportedIssue[] => mine.filter((issue) => issue.tier === tier)
  return {
    milestone,
    unblocked: taken('unblocked'),
    next: taken('next'),
    blocked: taken('blocked'),
  }
}

/** The milestone numbers asked for, or a refusal naming what was wrong. */
export const requestedMilestones = (value: string): Envelope<number[]> => {
  if (value === '') return ok([])
  const numbers: number[] = []
  for (const word of value.split(',')) {
    const trimmed = word.trim()
    // The shape is asserted before the conversion rather than inferred from
    // it: `Number.parseInt` reads "4x" as 4 and "" as NaN, and a sweep that
    // quietly swept milestone 4 for someone who typed "4x" would be answering
    // a question nobody asked.
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      return refused(`--milestone takes milestone numbers, not "${trimmed}"`)
    }
    const number = Number(trimmed)
    if (!numbers.includes(number)) numbers.push(number)
  }
  return ok(numbers)
}

/**
 * Whether the command line names `--milestone` more than once.
 *
 * `lib/args.ts` declares no repeatable option, and `parseArgs` answers a
 * repeated one with its LAST value and no complaint, so `--milestone 4
 * --milestone 5` would sweep milestone 5 and say nothing about the 4 the
 * caller also asked for. Scanned here rather than solved in `lib/args.ts`,
 * because one command wanting a list is not yet an argument for a repeatable
 * option every other command would inherit untested.
 */
export const repeatedMilestone = (argv: readonly string[]): boolean =>
  argv.filter((word) => word === '--milestone' || word.startsWith('--milestone=')).length > 1

/** One issue, for a person, with the reason it sits in the set it does. */
const issueLine = (issue: ReportedIssue): string => {
  let why = 'no blockers'
  if (issue.openBlockers.length > 0) {
    why = `behind ${issue.openBlockers.map((number) => `#${number}`).join(', ')}`
  } else if (issue.blockedBy.length > 0) {
    why = `every blocker closed: ${issue.blockedBy.map((ref) => `#${ref.number}`).join(', ')}`
  }
  return `    #${issue.number}  ${issue.title}\n        ${why}`
}

/** A group's heading, which is also the one place a group says whether it is
 *  a milestone at all. */
const headingFor = (milestone: GroupHeader | null): string => {
  if (milestone === null) return 'issues on no milestone'
  if (milestone.title === null) return `milestone ${milestone.number} (not an open milestone)`
  return (
    `milestone ${milestone.number}: ${milestone.title} ` +
    `(${milestone.openIssues} open, ${milestone.closedIssues} closed)`
  )
}

/** One group, for a person. A set with nothing in it still prints its
 *  heading: "next tier (0)" is an answer, and a heading silently missing
 *  reads as a set nobody looked at. */
const groupText = (group: Group): string[] => {
  const lines = ['', headingFor(group.milestone)]
  for (const tier of TIERS) {
    lines.push(`  ${TIER_LABELS[tier]} (${group[tier].length})`)
    for (const issue of group[tier]) lines.push(issueLine(issue))
  }
  return lines
}

/** The whole report, for a person. */
export const renderReport = (report: SweepReport): string => {
  const lines: string[] = []
  if (report.unavailable.length > 0) {
    lines.push('INCOMPLETE: the sets below are short of what was asked for.')
    for (const reason of report.unavailable) lines.push(`  ${reason}`)
    lines.push('')
  }

  lines.push(`open milestones (${report.milestones.length})`)
  for (const milestone of report.milestones) {
    lines.push(
      `  ${milestone.number}  ${milestone.title}  ` +
        `${milestone.openIssues} open, ${milestone.closedIssues} closed`,
    )
  }

  lines.push('', `open pull requests (${report.pullRequests.length})`)
  for (const pull of report.pullRequests) {
    lines.push(
      `  #${pull.number}  ${pull.head} -> ${pull.base}  ` +
        `${pull.draft ? 'draft' : 'ready'}  ${pull.title}`,
    )
  }

  for (const group of report.groups) lines.push(...groupText(group))
  lines.push(...groupText(report.unassigned))

  const set = (numbers: readonly number[]): string =>
    numbers.length === 0 ? 'none' : numbers.map((number) => `#${number}`).join(', ')
  lines.push('', 'across everything swept')
  for (const tier of TIERS) lines.push(`  ${TIER_LABELS[tier]}: ${set(report.combined[tier])}`)
  return lines.join('\n')
}

/** The edges this command reads: one `gh`, and nothing else. */
export interface SweepContext {
  readonly gh: GhClient
}

/**
 * Every milestone number the issues that were read name for themselves.
 *
 * The open milestones are what a sweep is asked about, but they are not the
 * only milestones the issues carry: a milestone can close with an open issue
 * still on it, and a failed milestone read leaves the list empty while the
 * issue read still answers. An issue whose milestone is in neither the asked
 * list nor `null` lands in no group at all, so it would be read, classified,
 * and then invisible. Sweeping these too is what keeps every row that arrived
 * in the report.
 */
const milestonesNamed = (issues: readonly IssueSummary[]): number[] => {
  const numbers: number[] = []
  for (const issue of issues) {
    if (issue.milestone === null) continue
    if (!numbers.includes(issue.milestone.number)) numbers.push(issue.milestone.number)
  }
  return numbers
}

/** A milestone header for a number, from the open milestones that were read. */
const headerFor = (number: number, milestones: readonly MilestoneSummary[]): GroupHeader => {
  const found = milestones.find((milestone) => milestone.number === number)
  if (found === undefined) return { number, title: null, openIssues: null, closedIssues: null }
  return {
    number,
    title: found.title,
    openIssues: found.openIssues,
    closedIssues: found.closedIssues,
  }
}

/**
 * Sweep the tracker and answer with the report, rendered.
 *
 * One unfiltered `listIssues` call plus one per milestone asked for. The
 * unfiltered one is both how the issues on no milestone are found (the API's
 * `milestoneNumber: "none"` filter matches nothing rather than matching them)
 * and what makes the unblocked set one set rather than one per group; the
 * per-milestone ones are what a milestone read still answers when the
 * unfiltered read did not.
 *
 * With no `--milestone`, the groups are the open milestones and any other
 * milestone the issues themselves name, so a row that was read is never left
 * out of every set.
 */
export const runSweep = async (
  argv: readonly string[],
  context: SweepContext,
): Promise<Envelope<string>> => {
  const parsed = parseArguments(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.help) return ok(HELP)
  if (repeatedMilestone(argv)) {
    return refused('--milestone is not repeatable; pass one comma-separated list')
  }
  const requested = requestedMilestones(parsed.value.milestone)
  if (requested.outcome !== 'ok') return requested

  const unavailable: string[] = []
  const note = (reason: string | null): void => {
    if (reason !== null) unavailable.push(reason)
  }

  const milestones = await context.gh.listMilestones()
  note(milestones.unavailable)
  const pulls = await context.gh.listOpenPullRequests()
  note(pulls.unavailable)
  const everything = await context.gh.listIssues()
  note(everything.unavailable)

  // Asked for a milestone, the report is scoped to it and to the issues on no
  // milestone, which is the documented contract. Asked for none, the scope is
  // every open milestone plus every milestone the issues themselves name, so
  // that nothing that was read goes unreported.
  const numbers =
    requested.value.length > 0
      ? requested.value
      : [
          ...new Set([
            ...milestones.rows.map((milestone) => milestone.number),
            ...milestonesNamed(everything.rows),
          ]),
        ].sort((left, right) => left - right)

  const read: IssueSummary[] = [...everything.rows]
  const seen = new Set(read.map((issue) => issue.number))
  for (const number of numbers) {
    const answer = await context.gh.listIssues({ milestone: String(number) })
    note(answer.unavailable)
    for (const issue of answer.rows) {
      if (seen.has(issue.number)) continue
      seen.add(issue.number)
      read.push(issue)
    }
  }

  // "Nothing at all could be read" is about all three reads, not the issues
  // alone. A failure envelope writes nothing to stdout (`lib/envelope.ts`), so
  // reporting one while the milestones or the open pull requests did arrive
  // would throw away an answer the caller asked for.
  const nothingRead = read.length === 0 && milestones.rows.length === 0 && pulls.rows.length === 0
  if (nothingRead && unavailable.length > 0) {
    return failed(`the sweep read nothing: ${unavailable.join('; ')}`)
  }

  const classified = classify(read)
  const groups = numbers.map((number) => groupOf(headerFor(number, milestones.rows), classified))
  const unassigned = groupOf(null, classified)

  const reported = [...groups, unassigned]
  const combined = {
    unblocked: reported.flatMap((group) => group.unblocked.map((issue) => issue.number)),
    next: reported.flatMap((group) => group.next.map((issue) => issue.number)),
    blocked: reported.flatMap((group) => group.blocked.map((issue) => issue.number)),
  }

  const report: SweepReport = {
    milestones: milestones.rows,
    pullRequests: pulls.rows,
    groups,
    unassigned,
    combined,
    unavailable,
  }

  return ok(parsed.value.json ? JSON.stringify(report) : renderReport(report))
}
