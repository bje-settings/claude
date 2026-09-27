// The deterministic half of the review loop: one pull request's state,
// derived from the pull request and its checks on every call.
//
// **Nothing is remembered.** Round 8 ruling 8, and CLAUDE.md's "derive what
// a plugin needs each time it runs": there is no state file. Every fact
// here is read again each tick. The only facts the caller carries are the
// three it alone knows: how many review rounds it has completed, whether
// the first one was substantial, and whether the rot check is done. A file
// would be the copy that goes stale, and a loop resumed from one would
// review a head that had already moved.
//
// **Nothing is hard-coded about the repository either.** The required
// status-check contexts come from the rules for the pull request's OWN
// base branch, read at run time. On this repository, a pull request based
// on the default branch must pass nine contexts, and one based on a topic
// branch, which is what every layer of a stack is, must pass none. A
// command that carried either list in its source would report the wrong
// answer for half the pull requests a stack is made of.
//
// The judgement is in `skills/review`. This command says what is true, and
// which state that adds up to. It says nothing about what to do next. The
// close-and-reopen remedy for a head with no workflow run, the wait, the
// dispatch, and the rot check are all the skill's.
//
// The command function is the seam (ADR 001): parsed arguments and an
// injected `GhClient` in, an envelope out, with nothing spawned.
import { parseCommandLine } from '../lib/args.ts'
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
diff. Together they are what separates review-2 from rot-check from done. Both
flags describe a round that has finished, so neither is accepted with
--round 0.

The verdict over the required contexts:

  green       every required context reported and none of them failed, and
              the list of contexts is settled
  red         a required context concluded anything but success, skipped or
              neutral
  pending     a required context has not reported, or has not concluded, or
              the base branch has no ruleset and a run on the head is still
              adding contexts to the list
  no-run      no workflow run with event pull_request exists for the head
  unavailable something needed to answer could not be read

State awaiting-pr means GitHub said this pull request number does not exist.
A read that failed for any other reason leaves state null instead. The
reason then appears under "unavailable".

Nothing here throws. Every read that fell short is listed under "unavailable",
and a verdict of "unavailable" means the sets below it are not an answer.
Exits 2 on a usage error, and 1 only when nothing at all could be read.`

// `as const` alone, the way `plugins/mermaid/src/subcommands/url.ts` and
// `sweep.ts` write it, and the way `lib/README.md` asks for. A broken
// spec is refused either way. `parseCommandLine`'s own `ExactSpec` guard
// answers `never` at the call site. A test verified this: it removed
// `round`'s default and watched `tsc` refuse it, with and without a
// `satisfies` clause.
const SPEC = {
  round: { type: 'string', default: '0', choices: ['0', '1', '2'] },
  substantial: { type: 'boolean' },
  'rot-checked': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** How many recent runs the wait hint is measured over. Large enough that one
 *  slow run does not move the median, small enough to be one page. */
const HINT_SAMPLE = 30

/**
 * What a required context adds up to.
 *
 * `success` covers the three conclusions that SATISFY a required check:
 * `SUCCESS`, and `SKIPPED` and `NEUTRAL`, which GitHub's own merge gate
 * accepts. If this reported a skipped required job as red, a loop would
 * never finish, on any repository whose workflow skips a job by path
 * filter. The raw conclusion is carried beside the verdict, so a caller
 * can still see which of the three it was.
 */
export type ContextVerdict = 'success' | 'failed' | 'pending'

/** The whole pull request's verdict over its required contexts. */
export type Verdict = 'green' | 'red' | 'pending' | 'no-run' | 'unavailable'

/** Where the loop is. `null` is not a state: it means this command will
 *  not name one, from facts it could not read. */
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

/** How long to wait before the caller asks again. */
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
  /**
   * Where the names in `contexts` came from.
   *
   * `head` is the fallback for a base branch no ruleset covers. It is a
   * DESIGN fact, not a read that fell short, so it is a field of its own,
   * not a line in `unavailable`. A caller keys on `unavailable` to decide
   * whether the report is an answer at all. To put this there would make
   * every stacked pull request look unreadable.
   *
   * `unread` is neither: there was no pull request to find a base branch
   * on, so no list was asked for. To say `ruleset` there would claim an
   * empty answer from a question nobody put.
   */
  readonly contextsFrom: 'ruleset' | 'head' | 'unread'
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
 * A failure outranks a pending context. A round told "pending" would wait
 * for a run that has already lost, and the failure is the thing to act on
 * either way.
 *
 * `green` needs one more thing than "nothing failed and nothing is
 * pending": the names themselves must be the whole list. Under a ruleset
 * they are, and `namesFinal` is true. Under the head fallback they are
 * only what has reported so far. So a head whose checks have not appeared
 * yet would otherwise be green over NOTHING, and a head where one
 * workflow has finished while another has not yet added all its checks
 * would be green over a fraction. Both cases are `pending`: the answer is
 * not that the pull request passed, it is that nobody knows yet.
 */
export const verdictOf = (
  contexts: readonly ReportedContext[],
  hasRun: boolean,
  namesFinal: boolean,
): Verdict => {
  if (!hasRun) return 'no-run'
  if (contexts.some((context) => context.verdict === 'failed')) return 'red'
  if (contexts.some((context) => context.verdict === 'pending')) return 'pending'
  return namesFinal && contexts.length > 0 ? 'green' : 'pending'
}

/**
 * Where the loop is, from the facts plus the three the caller carries.
 *
 * `null`, rather than a guess, when the verdict is `unavailable`. A state
 * is an instruction to the caller. To name one from facts that could not
 * be read would send a round to review a pull request whose checks
 * nobody has seen.
 *
 * An unresolved review THREAD keeps the loop in `fixing`, however green
 * CI is, because a thread is work someone waits on. A comment does not:
 * the enterprise coverage bot posts one on every pull request here, and a
 * loop that counted it would never reach `done`.
 */
export const deriveState = (facts: {
  /** True only when GitHub itself said this pull request number does not
   *  exist. A read that failed for any other reason gives `null`, not
   *  `awaiting-pr`. */
  readonly missing: boolean
  readonly verdict: Verdict
  readonly unresolvedThreads: number
  readonly round: number
  readonly substantial: boolean
  readonly rotChecked: boolean
}): LoopState | null => {
  if (facts.missing) return 'awaiting-pr'
  if (facts.verdict === 'unavailable') return null
  if (facts.verdict === 'no-run') return 'no-run'
  if (facts.round === 0) {
    if (facts.verdict === 'red') return 'red'
    if (facts.verdict === 'pending') return 'ci-pending'
    return 'review-1'
  }
  // A round has already run, so CI that is not green means that round's
  // own fixes have not landed, not the stream's problem.
  if (facts.verdict !== 'green') return 'fixing'
  if (facts.unresolvedThreads > 0) return 'fixing'
  // The two-round ceiling. Round 2 never schedules a third. On nine of the
  // ten pull requests reviewed by hand in rounds 5 to 7 (#133's findings),
  // round 2 found round 1 wrong or incomplete. So the code reads
  // "substantial" generously. But two rounds is the limit.
  if (facts.round === 1 && facts.substantial) return 'review-2'
  return facts.rotChecked ? 'done' : 'rot-check'
}

/** The middle of a sorted list of durations, rounded to whole milliseconds. */
const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2)
  // The cast exists because `noUncheckedIndexedAccess` is exact about an
  // array of unknown length. The caller never passes an empty one.
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

/**
 * How long to wait before the caller asks again, from how long recent
 * runs took.
 *
 * Scoped to `workflows`, the names that ran on THIS head, because those
 * are the runs the loop waits for. Measured over every workflow in the
 * repository, the hint would be whichever unrelated workflow happens to
 * be slowest; on the first measurement here that was a `push` workflow
 * with one sample. An empty `workflows` means nothing has run on the head
 * yet, so the hint is then over everything, the best guess there is.
 *
 * Grouped by workflow, and answered for the SLOWEST group, because the
 * loop waits for the LAST required context to report. One median over
 * the runs mixed together would be dominated by whichever cheap workflow
 * ran most often. A hint shorter than the wait would make a caller poll a
 * hundred times.
 *
 * Only completed runs count, and only durations that make sense: a run
 * whose timestamps do not parse, or that reports it finished before it
 * started, is not a measurement.
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

/** The pull request number the caller named, or a refusal that says what
 *  was wrong with what it named instead. */
export const requestedPullRequest = (positionals: readonly string[]): Envelope<number> => {
  if (positionals.length === 0) return refused('pr-state takes a pull request number')
  if (positionals.length > 1) {
    return refused(`pr-state takes one pull request number, not ${positionals.length}`)
  }
  const word = positionals[0] as string
  // The code asserts this before conversion, rather than infer it from the
  // result: `Number.parseInt` reads "178x" as 178. To report on pull
  // request 178 for someone who typed "178x" would answer a question
  // nobody asked.
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
    // INCOMPLETE applies only when the shortfall cost the answer. A read
    // can fall short without that cost: the wait hint's sample is
    // deliberately left out of the verdict, so a report can name a state
    // and still carry a reason. To call that one INCOMPLETE would tell a
    // reader to distrust a verdict that is sound.
    lines.push(
      report.state === null
        ? 'INCOMPLETE: something needed to answer could not be read.'
        : 'The state below holds. Something beside it could not be read:',
    )
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
  if (report.contextsFrom === 'head') {
    lines.push(
      `  no ruleset requires a status check of ${report.base}, so the verdict below is over`,
      `  the ${report.contexts.length} context(s) that have reported on the head instead,`,
      '  and cannot see a check that has not been created yet',
    )
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
 * Four reads. Each one answers, or says why it could not; none of them
 * throws. They cover the pull request itself, the contexts its base
 * branch requires, the workflow runs on its head branch, and a sample of
 * recent runs for the wait hint. A read that failed costs its own fact
 * and nothing else. That is why a wait hint that could not be measured
 * does not stop the verdict.
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
  const round = Number(parsed.value.options.round)
  const substantial = parsed.value.options.substantial
  const rotChecked = parsed.value.options['rot-checked']
  // Both flags say something about a round that has finished, so at round
  // 0 neither can be true of anything. `deriveState` returns from its
  // round-0 arms before it reads either. Without this check, they would be
  // accepted and silently discarded, and a caller that miscounted its own
  // rounds would be told nothing. `--round 2` without `--substantial` is
  // NOT refused: substantial describes round 1, and no longer matters once
  // round 2 has run.
  if (round === 0 && (substantial || rotChecked)) {
    return refused(
      '--substantial and --rot-checked describe a completed round, so neither holds with --round 0',
    )
  }

  const unavailable: string[] = []
  const note = (reason: string | null): void => {
    if (reason !== null) unavailable.push(reason)
  }

  const viewed = await context.gh.viewPullRequestDetail({ pullRequest: requested.value })
  note(viewed.unavailable)
  const detail = viewed.pullRequest

  // The base branch's own rules apply, not the default branch's: see the
  // header. With no pull request read, there is no base to ask about. To
  // ask about a guess would be worse than to ask nothing.
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

  // Nothing at all could be read. With no pull request, there was no base
  // and no head to ask the other two about, so the run sample is the one
  // read left. A gh that could not answer that either is a gh that
  // answered nothing. A pull request GitHub itself named NOT_FOUND is a
  // different fact: gh gave a complete answer. Only `deriveState` below,
  // from `missing`, decides `awaiting-pr`. This guard is only for a read
  // that answered nothing at all.
  if (detail === null && !viewed.missing && sample.unavailable !== null) {
    return failed(`pr-state read nothing about #${requested.value}: ${unavailable.join('; ')}`)
  }

  const checks = detail === null ? [] : detail.checks
  // This is the ruleset's list, when it names one; otherwise it is the
  // names that have reported on this head. A base branch no ruleset
  // covers requires nothing. That fact is true, and useless on its own:
  // every layer of a stack is based on one, and a verdict over an empty
  // list would be green before a single check had run.
  const fromRuleset = required.contexts.length > 0
  const names = fromRuleset ? required.contexts : checks.map((check) => check.name)
  const contexts = [...new Set(names)].map((name) => reportedAs(checks, name))

  const runsForHead =
    detail === null
      ? []
      : runs.rows.filter((run) => run.event === 'pull_request' && run.headSha === detail.headSha)

  // `viewed.unavailable` counts as much as the other two. It is not only
  // "no pull request": it is also a reply whose check, thread, or comment
  // list ran longer than one page, and a GraphQL body that came back with
  // `errors` beside the data. A thread list cut short by truncation reads
  // as zero unresolved threads. That is how a report reaches `done` on a
  // pull request someone still waits on.
  const unreadable =
    detail === null ||
    viewed.unavailable !== null ||
    required.unavailable !== null ||
    runs.unavailable !== null
  // The ruleset's list is the whole list. The head's list is whatever has
  // reported so far. It is settled only once every run on the head has
  // finished, so nothing more can be added.
  const namesFinal = fromRuleset || runsForHead.every((run) => run.status === 'completed')
  const verdict: Verdict = unreadable
    ? 'unavailable'
    : verdictOf(contexts, runsForHead.length > 0, namesFinal)

  const report: PrStateReport = {
    pullRequest: requested.value,
    ...pullRequestFields(detail),
    requiredContexts: required.contexts,
    contextsFrom: detail === null ? 'unread' : fromRuleset ? 'ruleset' : 'head',
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
    substantial,
    rotChecked,
    state: deriveState({
      missing: viewed.missing,
      verdict,
      unresolvedThreads: detail === null ? 0 : detail.unresolvedThreadAuthors.length,
      round,
      substantial,
      rotChecked,
    }),
    unavailable,
  }

  return ok(parsed.value.options.json ? JSON.stringify(report) : renderReport(report))
}
