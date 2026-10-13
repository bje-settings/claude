// The deterministic half of the review loop: one pull request's state,
// derived from the pull request and its checks on every call.
//
// **Nothing is remembered.** Round 8 ruling 8, and CLAUDE.md's "derive what
// a plugin needs each time it runs": there is no state file. Every fact
// here is read again each tick. The only facts the caller carries are the
// four it alone knows: how many review rounds it has completed, whether
// the first one was substantial, the head the first one reviewed, and
// whether the rot check is done. A file
// would be the copy that goes stale, and a loop resumed from one would
// review a head that had already moved.
//
// **Nothing is hard-coded about the repository either.** The required
// status-check contexts come from the rules for the base of the pull
// request's stack BOTTOM, read at run time (#398). GitHub takes the merge
// requirements of every pull request in a stack from the bottom pull
// request's base. A base that is the head of an open pull request moves the
// read down to that pull request's base, until a base is the head of none
// ({@link stackBottom}). A pull request in no stack reads its own base. On
// this repository, a pull request based on the default branch must pass
// nine contexts, and every layer of a stack above it must pass the same
// nine. A command that carried either list in its source would report the
// wrong answer for half the pull requests a stack is made of.
//
// **A bot's thread holds the loop too** (#383, round 15 ruling 7). This
// reverses the part of #219 that left bot threads out of `fixing`. #219's
// acceptance still holds through its second option: the report names each
// bot thread apart, and `skills/review` says what to do with it.
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
import type {
  CommitComparison,
  GhClient,
  IssueState,
  PullRequestDetail,
  WorkflowRun,
} from '../lib/gh.ts'
import {
  answeringChecks,
  namesOrHead,
  type ReportedContext,
  reportContexts,
  splitDraftSkipped,
  stackBottom,
} from '../required-contexts.ts'

// The derivation moved to `../required-contexts.ts` (round 10 ruling P6).
// These two types stay exported here too, so a caller of this command
// imports them from the command it reads.
export type { ContextVerdict, ReportedContext } from '../required-contexts.ts'

export const HELP = `One pull request's review-loop state, derived from the pull request and its checks.

Usage:
  workstreams.ts pr-state <number> [--round 0|1|2] [--substantial]
    [--round-1-head <sha>] [--rot-checked] [--json]

Reads the status-check contexts that the base of the pull request's stack bottom
requires (its own base, when it is in no stack), the head commit and what has
reported on it, whether a workflow run for the head exists with event
pull_request, the unresolved review threads, and how long recent runs have
taken, and reports the state the review loop is in.

--round is how many review rounds have COMPLETED, which is the one thing this
command cannot read; --substantial says round 1 changed something substantial,
and --rot-checked says the title and body have been checked against the final
diff. Together they are what separates review-2 from rot-check from done. Both
flags describe a round that has finished, so neither is accepted with
--round 0.

--round-1-head is line 2 of the round 1 marker: the head that round 1
reviewed. It holds only with --round 1. Without --substantial, the command
reads the compare of that head to the current head. The state is review-2,
not rot-check or done, when one of these is true:

  the round 1 head is not an ancestor of the head, as after a rebase
  the compare lists GitHub's limit of changed files, so the list can be short
  a changed file is under src/, lib/, scripts/ or hooks/ at any depth
    (a test file, a file under a test directory and a Markdown file are
    not logic)

"sinceRound1" gives the reason. A compare that could not be read gives no
state at that step.

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

A check from a cancelled workflow run does not count when a newer run of the
same workflow exists on the head, also when that run has made no check yet and has not completed.
A name the newer run has not reported yet is pending, not failed. When no
ruleset covers the base, the head list also leaves out a name that contains
\${{, an unexpanded matrix job. It also leaves out a check that has not
concluded and has no workflow run, such as a pending commit status (#383).
Such a check does not answer for a name that a check with a run reports.

On a draft, a required context that no check on the head names is left out
of the verdict when a check on the head, from a check suite that concluded
SKIPPED, has a name with \${{ ... }} that matches it. Each \${{ ... }}
matches one or more characters that are not ( or ). Such a context runs
after ready for review. "draftSkipped" names each one, and is empty when the
pull request is not a draft. A draft whose only missing contexts are
draft-skipped is green.

With --round 0, a pull request with a workflow run for its head is
review-1 when the verdict is green, pending or red. The first review starts
while CI runs, and the round reads CI when its reviewers return. After a
round, CI that is not green gives fixing, and done needs green.

After a round, an unresolved review thread also gives fixing, from a
person or from a bot (#383). "botThreads" counts the bot threads apart
from "unresolvedThreads". This reverses part of #219. #219 still holds
by its second option: the report names each bot thread. The review skill
replies on and resolves each one that a round settled, and each mermaid
preview thread. It names each other bot thread for the person. A plain
comment never holds the loop.

State awaiting-pr means GitHub said this pull request number does not exist.
A read that failed for any other reason leaves state null instead. The
reason then appears under "unavailable".

State merged or closed means the pull request itself finished. This check
runs right after awaiting-pr, before every other rule. No CI result,
thread, or marker changes it.

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
  'round-1-head': { type: 'string', default: '' },
  'rot-checked': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

/** How many recent runs the wait hint is measured over. Large enough that one
 *  slow run does not move the median, small enough to be one page. */
const HINT_SAMPLE = 30

/** The whole pull request's verdict over its required contexts. */
export type Verdict = 'green' | 'red' | 'pending' | 'no-run' | 'unavailable'

/** Where the loop is. `null` is not a state: it means this command will
 *  not name one, from facts it could not read. */
export type LoopState =
  | 'awaiting-pr'
  | 'merged'
  | 'closed'
  | 'no-run'
  | 'review-1'
  | 'fixing'
  | 'review-2'
  | 'rot-check'
  | 'done'

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

/** Whether logic changed after the head that round 1 reviewed, and why.
 *  `logic` is also true when the compare cannot prove that no logic changed. */
export interface SinceRound1 {
  readonly logic: boolean
  readonly reason: string
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
  /** The branch whose rules `requiredContexts` came from: the base of the
   *  stack bottom (#398). It is `base` for a pull request in no stack. Null
   *  when no list was read. */
  readonly rulesBranch: string | null
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
  /** The contexts that are part of the verdict. On a draft, this leaves
   *  out each name in `draftSkipped`. */
  readonly contexts: readonly ReportedContext[]
  /** The required names that run only after the pull request is ready for
   *  review, sorted (#365). Not part of the verdict. Empty when the pull
   *  request is not a draft. */
  readonly draftSkipped: readonly string[]
  /** Whether a workflow run with event `pull_request` exists for the head.
   *  Read from `actions/runs?branch=`, never `?head_sha=`. */
  readonly hasPullRequestRun: boolean
  readonly runsForHead: readonly ReportedRun[]
  readonly verdict: Verdict
  /** Unresolved review threads from a PERSON. These hold the loop at
   *  `fixing`. A bot's own thread is named apart, under `botThreads`, and
   *  holds it too (#383). */
  readonly unresolvedThreads: number
  readonly unresolvedThreadAuthors: readonly string[]
  /** Unresolved review threads whose first comment came from a bot account.
   *  They hold the loop at `fixing` after a round, as a person's thread
   *  does (#383, which reverses part of #219). The review skill replies
   *  on and resolves each one that a round settled, and each mermaid
   *  preview thread. It names each other one for the person. */
  readonly botThreads: number
  readonly botThreadAuthors: readonly string[]
  readonly comments: number
  readonly commentAuthors: readonly string[]
  readonly waitHint: WaitHint | null
  readonly round: number
  readonly substantial: boolean
  /** The `--round-1-head` the caller named, or null for none. */
  readonly round1Head: string | null
  /** The compare of the round 1 head to the head. Null when the command did
   *  not read it, or could not (then `unavailable` says why). */
  readonly sinceRound1: SinceRound1 | null
  readonly rotChecked: boolean
  readonly state: LoopState | null
  /** Every reason this report is short. Empty is the only value that means
   *  every fact in it was read. */
  readonly unavailable: readonly string[]
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
 *
 * `draftSkipped` names the contexts a draft does not wait for (#365). A
 * list that only they emptied is not empty: the ruleset named them, and
 * the draft has nothing more to wait for.
 */
export const verdictOf = (
  contexts: readonly ReportedContext[],
  hasRun: boolean,
  namesFinal: boolean,
  draftSkipped: readonly string[],
): Verdict => {
  if (!hasRun) return 'no-run'
  if (contexts.some((context) => context.verdict === 'failed')) return 'red'
  if (contexts.some((context) => context.verdict === 'pending')) return 'pending'
  return namesFinal && contexts.length + draftSkipped.length > 0 ? 'green' : 'pending'
}

/**
 * Where the loop is, from the facts plus the three the caller carries.
 *
 * `null`, rather than a guess, when the verdict is `unavailable`. A state
 * is an instruction to the caller. To name one from facts that could not
 * be read would send a round to review a pull request whose checks
 * nobody has seen.
 *
 * At round 0, an open pull request with a run on its head gives
 * `review-1` whatever CI says (#384). CI that is `pending` or `red` does
 * not hold the first review. `done` still needs `green`, at every round.
 *
 * A merged or closed pull request gives `merged` or `closed` (#277). This
 * check runs right after `awaiting-pr`, before every other rule. CI,
 * threads and markers do not change it. A pull request that finished
 * stays final.
 *
 * An unresolved review THREAD keeps the loop in `fixing`, however green
 * CI is. A thread is work someone still waits on. The caller counts a
 * bot's own thread in `facts.unresolvedThreads` too (#383, round 15
 * ruling 7). That reverses part of #219, which left bot threads out
 * because nobody answered them. Now the review skill replies on and
 * resolves each one that a round settled, and each mermaid preview
 * thread. It names each other one for the person. A plain comment does not
 * hold the loop. The enterprise coverage bot posts one on every pull
 * request here, and nobody resolves a comment.
 */
export const deriveState = (facts: {
  /** True only when GitHub itself said this pull request number does not
   *  exist. A read that failed for any other reason gives `null`, not
   *  `awaiting-pr`. */
  readonly missing: boolean
  /** The pull request's own state, or `null` when this check could not
   *  read it. `null` here never means `OPEN`. It means this check answers
   *  nothing. Every rule below still applies. */
  readonly pullRequestState: IssueState | null
  readonly verdict: Verdict
  readonly unresolvedThreads: number
  readonly round: number
  readonly substantial: boolean
  /** True when logic landed after the head that round 1 reviewed. False
   *  when it did not, or when the caller named no such head. Null when
   *  the caller named one and the compare could not be read. */
  readonly logicSinceRound1: boolean | null
  readonly rotChecked: boolean
}): LoopState | null => {
  if (facts.missing) return 'awaiting-pr'
  if (facts.pullRequestState === 'MERGED') return 'merged'
  if (facts.pullRequestState === 'CLOSED') return 'closed'
  if (facts.verdict === 'unavailable') return null
  if (facts.verdict === 'no-run') return 'no-run'
  // #384: round 1 starts when the pull request opens, with a run on its
  // head. It does not wait for CI. The round reads CI once its reviewers
  // return, and fixes a failed check in the same pass.
  if (facts.round === 0) return 'review-1'
  // A round has already run, so CI that is not green holds the loop. The
  // round's own fixes, or a failure it did not fix, have not landed.
  if (facts.verdict !== 'green') return 'fixing'
  if (facts.unresolvedThreads > 0) return 'fixing'
  // The two-round ceiling. Round 2 never schedules a third. On nine of the
  // ten pull requests reviewed by hand in rounds 5 to 7 (#133's findings),
  // round 2 found round 1 wrong or incomplete. Round 12 ruling 3 (#295)
  // now reads "substantial" narrowly: a logic change under src/, lib/,
  // scripts/ or hooks/. Two rounds is still the limit.
  if (facts.round === 1 && facts.substantial) return 'review-2'
  // #356: a commit after the round 1 marker had no review. Logic in it
  // earns round 2, by the path part of the substantial rule. A compare
  // nobody could read names no state, because a guess here can skip a
  // review.
  if (facts.round === 1 && facts.logicSinceRound1 === null) return null
  if (facts.round === 1 && facts.logicSinceRound1) return 'review-2'
  return facts.rotChecked ? 'done' : 'rot-check'
}

/** The directories whose files hold logic, as the substantial rule in
 *  `skills/review/SKILL.md` names them. */
const LOGIC_DIRECTORIES: readonly string[] = ['src', 'lib', 'scripts', 'hooks']

/** Directories that hold tests. Tests are never substantial, so a file
 *  under one of them is not logic, even under `lib/` or `src/`. */
const TEST_DIRECTORIES: readonly string[] = ['tests', 'test', '__tests__']

/** Whether one changed path is logic: under a logic directory at any depth,
 *  under no test directory, and not a test or Markdown file. */
export const isLogicPath = (path: string): boolean => {
  const directories = path.split('/')
  const name = directories.pop() as string
  if (/\.(test|spec)\.[^.]+$/.test(name) || name.endsWith('.md')) return false
  if (directories.some((part) => TEST_DIRECTORIES.includes(part))) return false
  return directories.some((part) => LOGIC_DIRECTORIES.includes(part))
}

/**
 * Whether logic changed after the round 1 head, from the compare of that
 * head to the current head (#356, round 14 rulings 2 and 4).
 *
 * The rule compares commits, not times: a rebase moves commit dates. A
 * round 1 head that is not an ancestor of the head counts as logic, and so
 * does a file list at GitHub's limit. Neither can prove that no logic
 * changed, and the error to avoid is a skipped review.
 */
export const sinceRound1Of = (comparison: CommitComparison): SinceRound1 => {
  if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
    return {
      logic: true,
      reason: `the round 1 head is not an ancestor of the head (${comparison.status})`,
    }
  }
  if (comparison.filesAtLimit) {
    return { logic: true, reason: "the compare lists GitHub's limit of changed files" }
  }
  const logic = comparison.files.filter(isLogicPath)
  if (logic.length > 0) return { logic: true, reason: `logic changed: ${logic.join(', ')}` }
  return { logic: false, reason: 'no logic changed under src/, lib/, scripts/ or hooks/' }
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
  if (report.rulesBranch !== null && report.rulesBranch !== report.base) {
    lines.push(`  read from the rules of ${report.rulesBranch}, the base of the stack bottom`)
  }
  if (report.contextsFrom === 'head') {
    lines.push(
      `  no ruleset requires a status check of ${report.rulesBranch ?? report.base}, so the verdict below is over`,
      `  the ${report.contexts.length} context(s) that have reported on the head instead,`,
      '  and cannot see a check that has not been created yet',
    )
  }
  for (const context of report.contexts) {
    const said = context.reported ? (context.conclusion ?? 'running') : 'not reported'
    lines.push(`  ${context.verdict.padEnd(8)} ${context.name}  ${said}`)
  }
  for (const name of report.draftSkipped) {
    lines.push(`  skipped  ${name}  runs after ready for review`)
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
  // A bot's own thread holds the loop at `fixing` too (#383). The line
  // names it apart from a person's, so a reader knows who must answer.
  // It says nothing at all when there is none.
  if (report.botThreads > 0) {
    lines.push(
      `bot threads (waited on after a round): ${report.botThreads}` +
        authors(report.botThreadAuthors),
    )
  }
  if (report.sinceRound1 !== null) {
    lines.push(`since round 1: ${report.sinceRound1.reason}`)
  }
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

/** The unresolved threads, split into two lists: a person's and a bot's
 *  (#219). Both hold the loop (#383). A thread reads as a person's
 *  when its `bot` flag is not `true`. This is the safe side, the same one
 *  an unknown author takes in {@link PullRequestDetail}. */
const threadsOf = (
  detail: PullRequestDetail | null,
): { people: readonly string[]; bots: readonly string[] } => {
  if (detail === null) return { people: [], bots: [] }
  const people = detail.unresolvedThreads.filter((thread) => !thread.bot).map((t) => t.author)
  const bots = detail.unresolvedThreads.filter((thread) => thread.bot).map((t) => t.author)
  return { people, bots }
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
  | 'botThreads'
  | 'botThreadAuthors'
  | 'comments'
  | 'commentAuthors'
> => {
  const threads = threadsOf(detail)
  return detail === null
    ? {
        title: null,
        draft: null,
        base: null,
        head: null,
        headSha: null,
        mergeable: null,
        unresolvedThreads: threads.people.length,
        unresolvedThreadAuthors: threads.people,
        botThreads: threads.bots.length,
        botThreadAuthors: threads.bots,
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
        unresolvedThreads: threads.people.length,
        unresolvedThreadAuthors: threads.people,
        botThreads: threads.bots.length,
        botThreadAuthors: threads.bots,
        comments: detail.commentAuthors.length,
        commentAuthors: detail.commentAuthors,
      }
}

/** The rules of the stack bottom's base, and the branch they came from.
 *
 *  The chain comes from the open pull requests, one read. A short or failed
 *  read of that list gives no answer, because a missing pull request could
 *  hide a lower layer. A chain with no bottom gives no answer either
 *  ({@link stackBottom}). Both read as unavailable, never as "nothing
 *  required". The list is `listOpenPullRequestLinks`: it carries the fork
 *  flag and no checks, so another pull request's long check list cannot
 *  make this read short. A fork's branch name says nothing about a branch
 *  here, so a fork's pull request is not a link. A fork's pull request
 *  from its own `main` into `main` would otherwise make a loop at `main`,
 *  and every pull request on `main` would be unavailable. `intersect`
 *  skips forks in its stack walk for the same reason. */
const readStackRules = async (
  gh: GhClient,
  base: string,
): Promise<{ contexts: readonly string[]; unavailable: string | null; branch: string | null }> => {
  const open = await gh.listOpenPullRequestLinks()
  if (open.unavailable !== null)
    return { contexts: [], unavailable: open.unavailable, branch: null }
  const bottom = stackBottom(
    base,
    open.rows.filter((pull) => !pull.crossRepository),
  )
  if (bottom.branch === null) return { contexts: [], unavailable: bottom.unavailable, branch: null }
  const read = await gh.requiredContexts({ branch: bottom.branch })
  return { ...read, branch: read.unavailable === null ? bottom.branch : null }
}

/**
 * Read the pull request and answer with its state.
 *
 * Five reads. Each one answers, or says why it could not; none of them
 * throws. They cover the pull request itself, the open pull requests that
 * show its stack, the contexts its stack bottom's base requires, the
 * workflow runs on its head branch, and a sample of recent runs for the
 * wait hint. A read that failed costs its own fact
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
  const round1Head = parsed.value.options['round-1-head']
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
  // The round 1 head says what round 1 reviewed. With round 0 there is no
  // such head. With round 2, round 2 reviewed every commit after it.
  if (round1Head !== '' && round !== 1) {
    return refused(
      '--round-1-head names the head round 1 reviewed, so it holds only with --round 1',
    )
  }
  if (round1Head !== '' && !/^[0-9a-f]{7,40}$/.test(round1Head)) {
    return refused(`--round-1-head takes a commit sha, not "${round1Head}"`)
  }

  const unavailable: string[] = []
  const note = (reason: string | null): void => {
    if (reason !== null) unavailable.push(reason)
  }

  const viewed = await context.gh.viewPullRequestDetail({ pullRequest: requested.value })
  note(viewed.unavailable)
  const detail = viewed.pullRequest

  // The stack bottom's base rules apply: see the header. With no pull
  // request read, there is no base to ask about. To ask about a guess would
  // be worse than to ask nothing.
  const required =
    detail === null
      ? { contexts: [], unavailable: null, branch: null }
      : await readStackRules(context.gh, detail.base)
  note(required.unavailable)

  const runs =
    detail === null
      ? { rows: [], unavailable: null }
      : await context.gh.listWorkflowRuns({ branch: detail.head })
  note(runs.unavailable)

  // A substantial round 1 gives round 2 already, so the compare is not read.
  const compared =
    round1Head === '' || substantial || detail === null
      ? null
      : await context.gh.compareCommits({ base: round1Head, head: detail.headSha })
  note(compared === null ? null : compared.unavailable)
  const sinceRound1 =
    compared === null || compared.comparison === null ? null : sinceRound1Of(compared.comparison)

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
  const runsForHead =
    detail === null
      ? []
      : runs.rows.filter((run) => run.event === 'pull_request' && run.headSha === detail.headSha)
  // The head's runs also show a newer run that has made no check yet, which
  // supersedes a cancelled run (#370).
  const list = namesOrHead(required.contexts, checks, runsForHead)
  const fromRuleset = list.from === 'ruleset'
  // On a draft, a context that a skipped matrix check stands for is not
  // part of the verdict (#365, round 15 ruling 5).
  // With no ruleset, a pending check with no run does not answer for a
  // name that a check with a run also reports (#383, round 15 ruling 7).
  const answering = fromRuleset ? checks : answeringChecks(checks)
  const split = splitDraftSkipped(
    reportContexts(answering, list.names, runsForHead),
    checks,
    detail?.draft === true,
  )
  const contexts = split.counted

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
    : verdictOf(contexts, runsForHead.length > 0, namesFinal, split.draftSkipped)

  const report: PrStateReport = {
    pullRequest: requested.value,
    ...pullRequestFields(detail),
    requiredContexts: required.contexts,
    rulesBranch: required.branch,
    contextsFrom: detail === null ? 'unread' : list.from,
    contexts,
    draftSkipped: split.draftSkipped,
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
    round1Head: round1Head === '' ? null : round1Head,
    sinceRound1,
    rotChecked,
    state: deriveState({
      missing: viewed.missing,
      pullRequestState: detail === null ? null : detail.state,
      verdict,
      // A person's thread and a bot's both hold the loop (#383).
      unresolvedThreads: detail === null ? 0 : detail.unresolvedThreads.length,
      round,
      substantial,
      // When the command reads no compare, the fact is false and the state
      // ignores it.
      logicSinceRound1: compared === null ? false : (sinceRound1?.logic ?? null),
      rotChecked,
    }),
    unavailable,
  }

  return ok(parsed.value.options.json ? JSON.stringify(report) : renderReport(report))
}
