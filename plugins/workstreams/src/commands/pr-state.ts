// The deterministic half of the review loop: one pull request's state,
// derived from the pull request and its checks on every call.
//
// **Nothing is remembered.** Round 8 ruling 8 and CLAUDE.md's "derive what a
// plugin needs each time it runs": there is no state file, so every fact here
// is read again each tick and the only things the caller carries are the two
// it alone knows, how many review rounds it has completed and whether the
// first one was substantial. A file would be the copy that goes stale, and a
// loop resumed from one would review a head that had already moved.
//
// **Nothing is hard-coded about the repository either.** The required
// status-check contexts come from the rules that apply to the pull request's
// OWN base branch, read at run time. On this repository a pull request based
// on the default branch is required to pass nine contexts and one based on a
// topic branch, which is what every layer of a stack is, is required to pass
// none; a command carrying either list in its source would report the wrong
// answer for half the pull requests a stack is made of.
//
// The judgement is in `skills/review`: this command says what is true and
// which state that adds up to, and says nothing about what to do next. The
// close-and-reopen remedy for a head with no workflow run, the waiting, the
// dispatching and the rot check are all the skill's.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { type ArgSpec, parseCommandLine } from '../lib/args.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import type { CheckContext, GhClient, PullRequestDetail, WorkflowRun } from '../lib/gh.ts'

export const HELP = `One pull request's review-loop state, derived from the pull request and its checks.

Usage:
  workstreams.ts pr-state <number> [--round 0|1|2] [--substantial] [--rot-checked] [--json]

Reads the status-check contexts the pull request's base branch requires, the
head commit and what has reported on it, whether a workflow run for the head
exists with event pull_request, the unresolved review threads, and how long
recent runs have taken, and reports the state the review loop is in.

--round is how many review rounds have COMPLETED, which is the one thing this
command cannot read; --substantial says round 1 changed something substantial,
and --rot-checked says the title and body have been checked against the final
diff. Together they are what separates review-2 from rot-check from done.

The verdict over the required contexts:

  green       every required context reported and none of them failed
  red         a required context concluded anything but success, skipped or
              neutral
  pending     a required context has not reported, or has not concluded
  no-run      no workflow run with event pull_request exists for the head
  unavailable something needed to answer could not be read

Nothing here throws. Every read that fell short is listed under "unavailable",
and a verdict of "unavailable" means the sets below it are not an answer.
Exits 2 on a usage error, and 1 only when nothing at all could be read.`

const SPEC = {
  round: { type: 'string', default: '0', choices: ['0', '1', '2'] },
  substantial: { type: 'boolean' },
  'rot-checked': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const satisfies ArgSpec

/** How many recent runs the wait hint is measured over. Large enough that one
 *  slow run does not move the median, small enough to be one page. */
const HINT_SAMPLE = 30

/**
 * What a required context adds up to.
 *
 * `success` covers the three conclusions that SATISFY a required check:
 * `SUCCESS`, and `SKIPPED` and `NEUTRAL`, which GitHub's own merge gate
 * accepts. Reporting a skipped required job red would leave a loop that never
 * finishes on any repository whose workflow skips a job by path filter, and
 * the raw conclusion is carried beside the verdict so a caller can still see
 * which of the three it was.
 */
export type ContextVerdict = 'success' | 'failed' | 'pending'

/** The whole pull request's verdict over its required contexts. */
export type Verdict = 'green' | 'red' | 'pending' | 'no-run' | 'unavailable'

/** Where the loop is. `null` is not a state: it is this command declining to
 *  name one from facts it could not read. */
export type LoopState =
  | 'awaiting-pr'
  | 'ci-pending'
  | 'no-run'
  | 'red'
  | 'review-1'
  | 'fixing'
  | 'review-2'
  | 'rot-check'
  | 'done'

/** The conclusions that satisfy a required check. */
const SATISFYING: Record<string, true> = { SUCCESS: true, SKIPPED: true, NEUTRAL: true }

/** One required context and what it has reported. */
export interface ReportedContext {
  readonly name: string
  /** Whether anything has reported under this name on the head at all. */
  readonly reported: boolean
  /** GitHub's own conclusion, or null when nothing has reported or the check
   *  has not concluded. The two are told apart by `reported`. */
  readonly conclusion: string | null
  readonly verdict: ContextVerdict
}

/** A workflow run on the head, as the report carries it. */
export interface ReportedRun {
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
}

/** How long to wait before asking again. */
export interface WaitHint {
  /** The workflow the hint is measured over: the slowest of those that ran
   *  recently, because the loop waits for the last context to report and not
   *  the first. */
  readonly workflow: string
  readonly medianMs: number
  readonly samples: number
}

export interface PrStateReport {
  readonly pullRequest: number
  readonly title: string | null
  readonly draft: boolean | null
  readonly base: string | null
  readonly head: string | null
  readonly headSha: string | null
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`, or null when unread. */
  readonly mergeable: string | null
  /** The contexts the base branch's rules require. Empty means no ruleset
   *  requires anything of that branch, which is the ordinary case for a
   *  stacked pull request based on a topic branch. */
  readonly requiredContexts: readonly string[]
  readonly contexts: readonly ReportedContext[]
  /** Whether a workflow run with event `pull_request` exists for the head.
   *  Read from `actions/runs?branch=`, never `?head_sha=`. */
  readonly hasPullRequestRun: boolean
  readonly runsForHead: readonly ReportedRun[]
  readonly verdict: Verdict
  readonly unresolvedThreads: number
  readonly unresolvedThreadAuthors: readonly string[]
  readonly comments: number
  readonly commentAuthors: readonly string[]
  readonly waitHint: WaitHint | null
  readonly round: number
  readonly substantial: boolean
  readonly rotChecked: boolean
  readonly state: LoopState | null
  /** Every reason this report is short. Empty is the only value that means
   *  every fact in it was read. */
  readonly unavailable: readonly string[]
}

/** The most recent conclusion reported under `name`, and whether anything
 *  reported under it at all.
 *
 *  The FIRST match wins, which is GitHub's newest: a re-run adds a second
 *  check with the same name and the rollup lists the current one first. A
 *  reader that took the last would report a superseded failure as the answer.
 */
const reportedAs = (checks: readonly CheckContext[], name: string): ReportedContext => {
  const check = checks.find((candidate) => candidate.name === name)
  if (check === undefined) return { name, reported: false, conclusion: null, verdict: 'pending' }
  if (check.conclusion === null) {
    return { name, reported: true, conclusion: null, verdict: 'pending' }
  }
  return {
    name,
    reported: true,
    conclusion: check.conclusion,
    verdict: Object.hasOwn(SATISFYING, check.conclusion) ? 'success' : 'failed',
  }
}

/**
 * The verdict over the required contexts.
 *
 * A failure outranks a pending context: a round told "pending" would wait for
 * a run that has already lost, and the failure is the thing to act on either
 * way.
 */
export const verdictOf = (contexts: readonly ReportedContext[], hasRun: boolean): Verdict => {
  if (!hasRun) return 'no-run'
  if (contexts.some((context) => context.verdict === 'failed')) return 'red'
  if (contexts.some((context) => context.verdict === 'pending')) return 'pending'
  return 'green'
}

/**
 * Where the loop is, from the facts plus the three the caller carries.
 *
 * `null` rather than a guess when the verdict is `unavailable`: a state is an
 * instruction to the caller, and naming one from facts that could not be read
 * would send a round to review a pull request whose checks nobody has seen.
 *
 * An unresolved review THREAD keeps the loop in `fixing` however green CI is,
 * because a thread is work someone is waiting on. A comment does not: the
 * enterprise coverage bot posts one on every pull request here, and a loop
 * that counted it would never reach `done`.
 */
export const deriveState = (facts: {
  readonly hasPullRequest: boolean
  readonly verdict: Verdict
  readonly unresolvedThreads: number
  readonly round: number
  readonly substantial: boolean
  readonly rotChecked: boolean
}): LoopState | null => {
  if (!facts.hasPullRequest) return 'awaiting-pr'
  if (facts.verdict === 'unavailable') return null
  if (facts.verdict === 'no-run') return 'no-run'
  if (facts.round === 0) {
    if (facts.verdict === 'red') return 'red'
    if (facts.verdict === 'pending') return 'ci-pending'
    return 'review-1'
  }
  // A round has already run, so CI that is not green is that round's own
  // fixes landing rather than the stream's problem.
  if (facts.verdict !== 'green') return 'fixing'
  if (facts.unresolvedThreads > 0) return 'fixing'
  // The two-round ceiling. Round 2 never schedules a third: in eight of the
  // nine hand-run rounds behind this command, round 2 found round 1 wrong or
  // incomplete, so "substantial" is read generously, but two is the limit.
  if (facts.round === 1 && facts.substantial) return 'review-2'
  return facts.rotChecked ? 'done' : 'rot-check'
}

/** The middle of a sorted list of durations, rounded to whole milliseconds. */
const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2)
  // The cast is `noUncheckedIndexedAccess` being exact about an array of
  // unknown length; the caller never passes an empty one.
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

/**
 * How long to wait before asking again, from how long recent runs took.
 *
 * Scoped to `workflows`, the names that ran on THIS head, because those are
 * the runs the loop is waiting for: measured over every workflow in the
 * repository, the hint is whichever unrelated workflow happens to be slowest,
 * and on the first measurement here that was a `push` workflow with one
 * sample. An empty `workflows` means nothing has run on the head yet, and the
 * hint is then over everything, which is the best guess there is.
 *
 * Grouped by workflow and answered for the SLOWEST group, because the loop
 * waits for the LAST required context to report: one median over the runs
 * mixed together is dominated by whichever cheap workflow ran most often, and
 * a hint shorter than the wait is a caller polling a hundred times.
 *
 * Only completed runs, and only durations that make sense: a run whose
 * timestamps do not parse, or that reports finishing before it started, is
 * not a measurement.
 */
export const waitHintFrom = (
  runs: readonly WorkflowRun[],
  workflows: readonly string[],
): WaitHint | null => {
  const wanted = new Set(workflows)
  const byWorkflow = new Map<string, number[]>()
  for (const run of runs) {
    if (run.conclusion === null) continue
    if (wanted.size > 0 && !wanted.has(run.name)) continue
    const elapsed = Date.parse(run.updatedAt) - Date.parse(run.startedAt)
    if (!Number.isFinite(elapsed) || elapsed < 0) continue
    const seen = byWorkflow.get(run.name)
    if (seen === undefined) byWorkflow.set(run.name, [elapsed])
    else seen.push(elapsed)
  }
  let hint: WaitHint | null = null
  for (const [workflow, durations] of byWorkflow) {
    const medianMs = median([...durations].sort((left, right) => left - right))
    if (hint === null || medianMs > hint.medianMs) {
      hint = { workflow, medianMs, samples: durations.length }
    }
  }
  return hint
}

/** The pull request number the caller named, or a refusal saying what was
 *  wrong with what it named instead. */
export const requestedPullRequest = (positionals: readonly string[]): Envelope<number> => {
  if (positionals.length === 0) return refused('pr-state takes a pull request number')
  if (positionals.length > 1) {
    return refused(`pr-state takes one pull request number, not ${positionals.length}`)
  }
  const word = positionals[0] as string
  // Asserted before the conversion rather than inferred from it:
  // `Number.parseInt` reads "178x" as 178, and reporting on pull request 178
  // for someone who typed "178x" is answering a question nobody asked.
  if (!/^[1-9][0-9]*$/.test(word)) {
    return refused(`pr-state takes a pull request number, not "${word}"`)
  }
  return ok(Number(word))
}

/** One duration for a person, in the unit that reads. */
const asDuration = (ms: number): string =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 6_000) / 10}m`

/** The whole report, for a person. */
export const renderReport = (report: PrStateReport): string => {
  const lines: string[] = []
  if (report.unavailable.length > 0) {
    lines.push('INCOMPLETE: something needed to answer could not be read.')
    for (const reason of report.unavailable) lines.push(`  ${reason}`)
    lines.push('')
  }

  const state = report.state === null ? 'not derivable from what could be read' : report.state
  lines.push(`#${report.pullRequest}  ${report.title === null ? '(unread)' : report.title}`)
  lines.push(`  state    ${state}`)
  lines.push(`  verdict  ${report.verdict}`)
  if (report.head !== null) {
    const draft = report.draft === true ? 'draft' : 'ready'
    lines.push(`  head     ${report.head} at ${report.headSha} (${draft}, ${report.mergeable})`)
    lines.push(`  base     ${report.base}`)
  }

  lines.push('', `required contexts (${report.requiredContexts.length})`)
  if (report.requiredContexts.length === 0) {
    lines.push('  none: no ruleset requires anything of this base branch')
  }
  for (const context of report.contexts) {
    const said = context.reported ? (context.conclusion ?? 'running') : 'not reported'
    lines.push(`  ${context.verdict.padEnd(8)} ${context.name}  ${said}`)
  }

  lines.push('', `runs for this head with event pull_request (${report.runsForHead.length})`)
  for (const run of report.runsForHead) {
    lines.push(`  ${run.name}  ${run.status}  ${run.conclusion ?? 'no conclusion yet'}`)
  }

  const authors = (list: readonly string[]): string =>
    list.length === 0 ? '' : ` (${[...new Set(list)].join(', ')})`
  lines.push(
    '',
    `unresolved review threads: ${report.unresolvedThreads}` +
      authors(report.unresolvedThreadAuthors),
    `comments: ${report.comments}${authors(report.commentAuthors)}`,
  )
  if (report.waitHint !== null) {
    const { workflow, medianMs, samples } = report.waitHint
    lines.push(
      `wait hint: ${workflow} takes about ${asDuration(medianMs)} ` +
        `(${samples} recent run${samples === 1 ? '' : 's'})`,
    )
  }
  return lines.join('\n')
}

/** The edges this command reads: one `gh`, and nothing else. */
export interface PrStateContext {
  readonly gh: GhClient
}

/** The report's pull request half, filled in or left unread. */
const pullRequestFields = (
  detail: PullRequestDetail | null,
): Pick<
  PrStateReport,
  | 'title'
  | 'draft'
  | 'base'
  | 'head'
  | 'headSha'
  | 'mergeable'
  | 'unresolvedThreads'
  | 'unresolvedThreadAuthors'
  | 'comments'
  | 'commentAuthors'
> =>
  detail === null
    ? {
        title: null,
        draft: null,
        base: null,
        head: null,
        headSha: null,
        mergeable: null,
        unresolvedThreads: 0,
        unresolvedThreadAuthors: [],
        comments: 0,
        commentAuthors: [],
      }
    : {
        title: detail.title,
        draft: detail.draft,
        base: detail.base,
        head: detail.head,
        headSha: detail.headSha,
        mergeable: detail.mergeable,
        unresolvedThreads: detail.unresolvedThreadAuthors.length,
        unresolvedThreadAuthors: detail.unresolvedThreadAuthors,
        comments: detail.commentAuthors.length,
        commentAuthors: detail.commentAuthors,
      }

/**
 * Read the pull request and answer with its state.
 *
 * Four reads, each of which answers or says why it could not, and none of
 * which throws: the pull request itself, the contexts its base branch
 * requires, the workflow runs on its head branch, and a sample of recent runs
 * for the wait hint. A read that failed costs its own fact and nothing else,
 * which is why a wait hint that could not be measured does not stop the
 * verdict.
 */
export const runPrState = async (
  argv: readonly string[],
  context: PrStateContext,
): Promise<Envelope<string>> => {
  const parsed = parseCommandLine(argv, SPEC)
  if (parsed.outcome !== 'ok') return parsed
  if (parsed.value.options.help) return ok(HELP)
  const requested = requestedPullRequest(parsed.value.positionals)
  if (requested.outcome !== 'ok') return requested

  const unavailable: string[] = []
  const note = (reason: string | null): void => {
    if (reason !== null) unavailable.push(reason)
  }

  const viewed = await context.gh.viewPullRequestDetail({ pullRequest: requested.value })
  note(viewed.unavailable)
  const detail = viewed.pullRequest

  // The base branch's own rules, not the default branch's: see the header.
  // With no pull request read there is no base to ask about, and asking about
  // a guess would be worse than not asking.
  const required =
    detail === null
      ? { contexts: [], unavailable: null }
      : await context.gh.requiredContexts({ branch: detail.base })
  note(required.unavailable)

  const runs =
    detail === null
      ? { rows: [], unavailable: null }
      : await context.gh.listWorkflowRuns({ branch: detail.head })
  note(runs.unavailable)

  const sample = await context.gh.listWorkflowRuns({ perPage: HINT_SAMPLE })
  note(sample.unavailable)

  // Nothing at all could be read. With no pull request there was no base and
  // no head to ask the other two about, so the run sample is the one read
  // left, and a gh that could not answer either is a gh that answered
  // nothing. A pull request that could not be read while the sample WAS read
  // is a different fact and a reportable one: gh works and there is no such
  // pull request yet, which is `awaiting-pr`.
  if (detail === null && sample.unavailable !== null) {
    return failed(`pr-state read nothing about #${requested.value}: ${unavailable.join('; ')}`)
  }

  const checks = detail === null ? [] : detail.checks
  // The ruleset's list when it names one; otherwise the names that have
  // reported on this head. A base branch no ruleset covers requires nothing,
  // which is true and useless on its own: every layer of a stack is based on
  // one, and a verdict over an empty list would be green before a single
  // check had run.
  const fromRuleset = required.contexts.length > 0
  const names = fromRuleset ? required.contexts : checks.map((check) => check.name)
  const contexts = [...new Set(names)].map((name) => reportedAs(checks, name))

  const runsForHead =
    detail === null
      ? []
      : runs.rows.filter((run) => run.event === 'pull_request' && run.headSha === detail.headSha)

  const unreadable = detail === null || required.unavailable !== null || runs.unavailable !== null
  const verdict: Verdict = unreadable ? 'unavailable' : verdictOf(contexts, runsForHead.length > 0)

  if (!fromRuleset && detail !== null && required.unavailable === null) {
    unavailable.push(
      `no ruleset requires a status check of ${detail.base}, so the verdict is over the ` +
        `${contexts.length} context(s) that have reported on the head instead`,
    )
  }

  const round = Number(parsed.value.options.round)
  const report: PrStateReport = {
    pullRequest: requested.value,
    ...pullRequestFields(detail),
    requiredContexts: required.contexts,
    contexts,
    hasPullRequestRun: runsForHead.length > 0,
    runsForHead: runsForHead.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
    })),
    verdict,
    waitHint: waitHintFrom(
      sample.rows,
      runsForHead.map((run) => run.name),
    ),
    round,
    substantial: parsed.value.options.substantial,
    rotChecked: parsed.value.options['rot-checked'],
    state: deriveState({
      hasPullRequest: detail !== null,
      verdict,
      unresolvedThreads: detail === null ? 0 : detail.unresolvedThreadAuthors.length,
      round,
      substantial: parsed.value.options.substantial,
      rotChecked: parsed.value.options['rot-checked'],
    }),
    unavailable,
  }

  return ok(parsed.value.options.json ? JSON.stringify(report) : renderReport(report))
}
