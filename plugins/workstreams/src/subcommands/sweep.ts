// The sweep: primitive 1 of #111. It reads the issue tracker, the source of
// truth, and reports what a round could start on.
//
// The deterministic half of the sweep is here. The judgement is in
// `skills/sweep` (CLAUDE.md, "Plugin design"). This command answers which
// issues are unblocked, what each one unlocks, and how many issues are
// still blocked. It answers nothing about what any of them touches, or
// how they should be sequenced. Those come from readings of the issue
// bodies and of the tree. A script that guessed at them would guess
// where the skill can look instead.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { parseArguments } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type {
  GhClient,
  IssueRef,
  IssueSummary,
  MilestoneSummary,
  PullRequestSummary,
} from '../lib/gh.ts'

export const HELP = `What a round could start on, read from the issue tracker.

Usage:
  workstreams.ts sweep [--milestone 4,5] [--json]

Reports the repository's open milestones with their issue counts, every open
pull request including ones no round opened, and, for each milestone asked
for plus the issues on no milestone at all:

  unblocked   every blockedBy entry closed, or none at all. Carries
              unlocks: the open issues it is the only blocker of
  blocked     at least one open blockedBy entry. Reported as a count,
              number and title only: never read, mapped, sized, or
              commented on

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
  help: { type: 'boolean', short: 'h' },
} as const

/** Which of the two sets an issue falls in. Each value is also the key its
 *  set has on `combined`, so a caller that holds a tier can read the set
 *  without a lookup table between them. */
export type Tier = 'unblocked' | 'blocked'

const TIERS: readonly Tier[] = ['unblocked', 'blocked']

/** What each tier is called in the report a person reads. */
const TIER_LABELS: Record<Tier, string> = {
  unblocked: 'unblocked',
  blocked: 'blocked',
}

/** A relationship, as the report carries it. */
export interface ReportedRef {
  readonly number: number
  readonly state: string
}

/**
 * One issue, as the report carries it.
 *
 * `blockedBy` sits whole beside `openBlockers`, because "no blockers at
 * all" and "every blocker closed" are different facts about an unblocked
 * issue. A reader of the unblocked set acts on the difference. The first
 * case is work nothing blocked. The second case is work a round just
 * released.
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
  /** The open issues this one is the ONLY open blocker of (#195). Empty for
   *  a blocked issue: it has not been released yet, so it unlocks nothing
   *  itself. */
  readonly unlocks: readonly number[]
  readonly tier: Tier
}

/** A blocked issue, as the report carries it: existence only. #195 keeps
 *  the reason out, because the round does not read, map, size, or comment
 *  on a blocked issue. */
export interface BlockedIssue {
  readonly number: number
  readonly title: string
}

/** A milestone as a group's header. `title` and the counts are null for a
 *  milestone that was asked for but is not among the open ones. The sweep
 *  still swept it. Null here is not the same as a made-up title. */
export interface GroupHeader {
  readonly number: number
  readonly title: string | null
  readonly openIssues: number | null
  readonly closedIssues: number | null
}

/** One milestone's two sets, or the unassigned issues' when `milestone` is
 *  null. */
export interface Group {
  readonly milestone: GroupHeader | null
  readonly unblocked: readonly ReportedIssue[]
  readonly blocked: readonly BlockedIssue[]
}

export interface SweepReport {
  readonly milestones: readonly MilestoneSummary[]
  readonly pullRequests: readonly PullRequestSummary[]
  readonly groups: readonly Group[]
  readonly unassigned: Group
  /** The same two sets across every group above, as numbers. */
  readonly combined: Record<Tier, readonly number[]>
  /** Every reason this report is short of what was asked for. An empty list
   *  is the only value that means the sets are complete. */
  readonly unavailable: readonly string[]
}

/** Refs as the plain pairs the report is made of. */
const refs = (list: readonly IssueRef[]): ReportedRef[] =>
  list.map((ref) => ({ number: ref.number, state: ref.state }))

/**
 * Every issue's tier and `unlocks`, computed over the whole set that was
 * read, rather than once per milestone.
 *
 * `unlocks` is defined against the unblocked set. A blocker is frequently
 * on another milestone, or on none at all, so a per-milestone computation
 * would answer a different question for each group; the answer would
 * depend on where its blockers happened to live. The command reads the
 * unfiltered issue list once. That is what makes one answer possible.
 *
 * An issue whose single open blocker was not read at all cannot be in the
 * unblocked set, so it reports as blocked. That is the conservative
 * direction: a page that could not be read makes the sweep claim less,
 * never more.
 *
 * A blocker that is not OPEN does not block, whether it is CLOSED or
 * MERGED. A pull request recorded as a dependency is done once it has
 * merged.
 */
export const classify = (issues: readonly IssueSummary[]): ReportedIssue[] => {
  const entries = issues.map((issue) => ({
    issue,
    openBlockers: issue.blockedBy.filter((ref) => ref.state === 'OPEN').map((ref) => ref.number),
  }))
  const unblocked = new Set(
    entries.filter((entry) => entry.openBlockers.length === 0).map((entry) => entry.issue.number),
  )

  // Every issue with exactly one open blocker, and that blocker itself
  // unblocked, unlocks that blocker's own entry. A blocked issue is never
  // a key here. It has not been released yet. So nothing it lists as its
  // sole blocker counts against it.
  const unlocksOf = new Map<number, number[]>()
  for (const entry of entries) {
    if (entry.openBlockers.length !== 1) continue
    // The cast exists because `noUncheckedIndexedAccess` is exact about an
    // array of unknown length: the count was just checked, so index 0 is
    // there.
    const blocker = entry.openBlockers[0] as number
    if (!unblocked.has(blocker)) continue
    const list = unlocksOf.get(blocker)
    if (list === undefined) unlocksOf.set(blocker, [entry.issue.number])
    else list.push(entry.issue.number)
  }

  return entries.map(({ issue, openBlockers }) => ({
    number: issue.number,
    title: issue.title,
    milestone: issue.milestone === null ? null : issue.milestone.number,
    labels: [...issue.labels],
    blockedBy: refs(issue.blockedBy),
    openBlockers,
    blocking: refs(issue.blocking),
    pullRequests: refs(issue.pullRequests),
    unlocks: unlocksOf.get(issue.number) ?? [],
    tier: openBlockers.length === 0 ? 'unblocked' : 'blocked',
  }))
}

/** One group, from the classified issues that belong to its milestone. A
 *  blocked issue is stripped down to {@link BlockedIssue} here, the one
 *  place the round's "exists only" rule (#195) takes effect. */
const groupOf = (milestone: GroupHeader | null, issues: readonly ReportedIssue[]): Group => {
  const number = milestone === null ? null : milestone.number
  const mine = issues.filter((issue) => issue.milestone === number)
  return {
    milestone,
    unblocked: mine.filter((issue) => issue.tier === 'unblocked'),
    blocked: mine
      .filter((issue) => issue.tier === 'blocked')
      .map((issue) => ({ number: issue.number, title: issue.title })),
  }
}

/** The milestone numbers asked for, or a refusal that names what was wrong. */
export const requestedMilestones = (value: string): Envelope<number[]> => {
  if (value === '') return ok([])
  const numbers: number[] = []
  for (const word of value.split(',')) {
    const trimmed = word.trim()
    // The code asserts the shape before conversion, rather than infer it
    // from the result: `Number.parseInt` reads "4x" as 4 and "" as NaN. A
    // sweep that quietly swept milestone 4 for someone who typed "4x" would
    // answer a question nobody asked.
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
 * `lib/args.ts` declares no repeatable option. `parseArgs` answers a
 * repeated one with its LAST value, and no complaint. So `--milestone 4
 * --milestone 5` would sweep milestone 5, and say nothing about the 4 the
 * caller also asked for. This is scanned here, rather than solved in
 * `lib/args.ts`, because one command that wants a list is not yet an
 * argument for a repeatable option every other command would inherit
 * untested.
 */
export const repeatedMilestone = (argv: readonly string[]): boolean =>
  argv.filter((word) => word === '--milestone' || word.startsWith('--milestone=')).length > 1

/** One unblocked issue, for a person: why it needs no more work, and what
 *  it unlocks. `openBlockers` is always empty here. That is what defines
 *  the unblocked set. A blocked issue's "behind #N" case never applies to
 *  one of these. */
const issueLine = (issue: ReportedIssue): string => {
  const why =
    issue.blockedBy.length === 0
      ? 'no blockers'
      : `every blocker closed: ${issue.blockedBy.map((ref) => `#${ref.number}`).join(', ')}`
  const unlocks =
    issue.unlocks.length === 0
      ? ''
      : `\n        unlocks: ${issue.unlocks.map((number) => `#${number}`).join(', ')}`
  return `    #${issue.number}  ${issue.title}\n        ${why}${unlocks}`
}

/** One blocked issue, for a person: it exists, and nothing else. The round
 *  does not read, map, size, or comment on it (#195). */
const blockedLine = (issue: BlockedIssue): string => `    #${issue.number}  ${issue.title}`

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
 *  heading: "blocked (0)" is an answer, and a missing heading reads as a
 *  set nobody looked at. */
const groupText = (group: Group): string[] => {
  const lines = ['', headingFor(group.milestone)]
  lines.push(`  ${TIER_LABELS.unblocked} (${group.unblocked.length})`)
  for (const issue of group.unblocked) lines.push(issueLine(issue))
  lines.push(`  ${TIER_LABELS.blocked} (${group.blocked.length})`)
  for (const issue of group.blocked) lines.push(blockedLine(issue))
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
 * only milestones the issues carry. A milestone can close with an open
 * issue still on it, and a failed milestone read leaves the list empty
 * while the issue read still answers. An issue whose milestone is in
 * neither the asked list nor `null` lands in no group at all: it would be
 * read, classified, and then invisible. The sweep also sweeps these, which
 * keeps every row that arrived in the report.
 *
 * Repeats and all: the caller unions this with the open milestones through
 * a `Set`, so a milestone that twenty issues name is swept once. A second
 * dedupe here would be a second guard on the same property, and no test
 * could tell which of the two does the work.
 */
const milestonesNamed = (issues: readonly IssueSummary[]): number[] => {
  const numbers: number[] = []
  for (const issue of issues) {
    if (issue.milestone !== null) numbers.push(issue.milestone.number)
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
 * One unfiltered `listIssues` call, plus one per milestone asked for. The
 * unfiltered call does two things: it finds the issues on no milestone (the
 * API's `milestoneNumber: "none"` filter matches nothing, rather than
 * match them), and it makes the unblocked set one set, rather than one per
 * group. The per-milestone calls answer for a milestone even when the
 * unfiltered read did not.
 *
 * With no `--milestone`, the groups are the open milestones and any other
 * milestone the issues themselves name, so a row that was read is never
 * left out of every set.
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

  // "Nothing at all could be read" covers all three reads, not the issues
  // alone. A failure envelope writes nothing to stdout (`lib/envelope.ts`).
  // To report one while the milestones or the open pull requests did
  // arrive would throw away an answer the caller asked for.
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
