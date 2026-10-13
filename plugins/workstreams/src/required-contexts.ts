// The one derivation of the required status-check contexts. `pr-state` and
// `watch` both use it (round 10 ruling P6). So the two cannot disagree about
// the names a head must pass. They also cannot disagree about what
// satisfies one.
//
// A ruleset on a topic branch is rare. No ruleset covers the base of a stack
// layer above the first, so the list for that base is empty. So both callers
// read the rules of the stack BOTTOM's base instead ({@link stackBottom},
// #398). GitHub takes the merge requirements of every pull request in a
// stack from the base of the bottom pull request
// (https://docs.github.com/en/pull-requests/get-started/about-stacked-prs).
// A pull request in no chain has its own base as the bottom. The two
// callers want different fallbacks when that bottom has no ruleset:
//
//   - `pr-state` falls back to the names that reported on the head. It also
//     reads the workflow runs, so it can tell when that list is settled.
//   - `watch` falls back to the DEFAULT branch's list (ruling P9). It reads
//     the workflow runs of a head only when a cancelled check has no newer
//     check (#370). In round 5, the head-only rule concluded on seven
//     CodeQL checks and none of the required ones.
//
// Both callers read the checks through the same filter (#364). A check
// from a cancelled workflow run does not count when a newer run of the
// same workflow exists on the head (#370). Workflow concurrency cancels a
// run that way. The cancelled run's fan-in jobs then fail. A reader that
// kept them would report red while the newer run still works.
//
// Both callers also leave the same contexts out on a draft (#365): those
// that a skipped matrix check stands for ({@link splitDraftSkipped}).
//
// A status of the review loop itself, `workstreams/<name>`, is never a
// context ({@link isLoopStatus}, #377, mid-round ruling 14). It records a
// review round, not a check of the head.
//
// This file ships. It imports only a type from `lib/`.
import type { CheckContext } from './lib/gh.ts'

/**
 * What a required context adds up to.
 *
 * `success` covers the three conclusions that SATISFY a required check.
 * These are `SUCCESS`, and also `SKIPPED` and `NEUTRAL`, which GitHub's own
 * merge gate accepts. A loop that read a skipped required job as red would
 * never finish. That occurs on any repository whose workflow skips a job
 * by path filter. The report carries the raw conclusion beside the
 * verdict. So a caller can still see which of the three it was.
 */
export type ContextVerdict = 'success' | 'failed' | 'pending'

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

/** `startedAt` as a string that sorts oldest when null. An ISO timestamp
 *  never begins empty, so the empty string sorts before every real one. */
const startTime = (startedAt: string | null): string => startedAt ?? ''

/**
 * Which of two checks under one name is the later run.
 *
 * On a tie, the check that has not concluded wins. A `gh stack push` can
 * cancel a run and start a new one in the same second. The new one must
 * win even while it is still pending, or a stale success or failure would
 * answer for a run that has not finished yet.
 */
const isLater = (candidate: CheckContext, current: CheckContext): boolean => {
  const candidateTime = startTime(candidate.startedAt)
  const currentTime = startTime(current.startedAt)
  if (candidateTime !== currentTime) return candidateTime > currentTime
  return candidate.conclusion === null && current.conclusion !== null
}

/** What the newer-run compare reads of a run. A check's `CheckWorkflowRun`
 *  and a row of `actions/runs` (`WorkflowRun`) both carry it. */
export interface RunStamp {
  readonly id: number
  readonly workflowId: number
  readonly createdAt: string
  /** A row of `actions/runs` carries its `status`. A check's run does not. */
  readonly status?: string
}

/**
 * Which of two workflow runs is the newer one: the later `createdAt`, and
 * on a tie the larger run id. Two runs can start in the same second. The
 * newer run must also win after it concludes, or the cancelled run stays
 * the answer.
 */
const isNewerRun = (candidate: RunStamp, current: RunStamp): boolean =>
  candidate.createdAt === current.createdAt
    ? candidate.id > current.id
    : candidate.createdAt > current.createdAt

/** The run of each check that has one. */
const checkRuns = (checks: readonly CheckContext[]): RunStamp[] =>
  checks.flatMap((check) => (check.run === undefined ? [] : [check.run]))

/** Whether `run` was cancelled, and one of `runs` is a newer run of the same
 *  workflow. */
const isSuperseded = (run: CheckContext['run'], runs: readonly RunStamp[]): boolean =>
  run !== undefined &&
  run.conclusion === 'CANCELLED' &&
  runs.some((other) => other.workflowId === run.workflowId && isNewerRun(other, run))

/**
 * The checks that still count: every check, less those from a superseded
 * cancelled run (#364, #370).
 *
 * A run is superseded when it was cancelled, and a newer run of the same
 * workflow exists on the head. A check with no run, such as a commit
 * status, is never superseded. (With no ruleset, `pr-state` also leaves
 * out a pending one: {@link isPendingWithoutRun}.) A check from a
 * cancelled run that no newer run follows also counts. That run is
 * still the answer, and it is red.
 *
 * The newer run is visible in two ways. Its own checks show it. When it
 * has made no check yet, only the head's workflow runs show it. The caller
 * passes those as `headRuns`. A head run that has completed counts only
 * through its checks, since it will make no more. Without `headRuns`, the cancelled run's checks
 * still count until the newer run makes a first check. After that, a name
 * the newer run has not made yet has no check that counts. That name reads
 * as not reported, so it is pending, not failed.
 *
 * A run is cancelled only when its check suite says so. While its
 * `always()` jobs still run, the suite has no conclusion, so its checks
 * still count, also those that already failed.
 */
export const currentChecks = (
  checks: readonly CheckContext[],
  headRuns: readonly RunStamp[] = [],
): CheckContext[] => {
  // A head run that has completed and made no check never will. It ended
  // before any job ran, as `startup_failure` or a cancel does. It must not
  // hide the cancelled run's red checks.
  const runs = [...checkRuns(checks), ...headRuns.filter((run) => run.status !== 'completed')]
  return checks.filter((check) => !isSuperseded(check.run, runs))
}

/** Whether a cancelled check has no newer check on the head. Only then can
 *  a newer run with no check yet change the answer ({@link currentChecks}),
 *  so only then does a caller need to read the head's workflow runs. */
export const needsHeadRuns = (checks: readonly CheckContext[]): boolean => {
  const runs = checkRuns(checks)
  return checks.some(
    (check) => check.run?.conclusion === 'CANCELLED' && !isSuperseded(check.run, runs),
  )
}

/** The most recent conclusion reported under `name`, and whether anything
 *  reported under it at all.
 *
 *  A re-run adds a second check with the same name. A `gh stack push` can
 *  cancel the first run, so the newest run, not the first one listed, is
 *  the one that must answer. {@link isLater} picks it, so the input order
 *  does not matter.
 */
const reportedAs = (checks: readonly CheckContext[], name: string): ReportedContext => {
  let check: CheckContext | undefined
  for (const candidate of checks) {
    if (candidate.name !== name) continue
    if (check === undefined || isLater(candidate, check)) check = candidate
  }
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

/** The context prefix of the statuses that `workstreams mark` writes. */
export const LOOP_STATUS_PREFIX = 'workstreams/'

/** Whether a name is a status of the review loop, which `mark` writes
 *  (#377). Such a status records a round. It is not a check, so it is never
 *  a context of the verdict, also when a ruleset names it. Then it cannot
 *  hold `pending` before a round, or give `green` after one. */
export const isLoopStatus = (name: string): boolean => name.startsWith(LOOP_STATUS_PREFIX)

/** Each name once, in the order given, with what reported under it. Only
 *  the checks that still count answer ({@link currentChecks}). A name of
 *  the review loop is left out ({@link isLoopStatus}). */
export const reportContexts = (
  checks: readonly CheckContext[],
  names: readonly string[],
  headRuns: readonly RunStamp[] = [],
): ReportedContext[] => {
  const current = currentChecks(checks, headRuns)
  return [...new Set(names)]
    .filter((name) => !isLoopStatus(name))
    .map((name) => reportedAs(current, name))
}

/** What an unexpanded matrix job's name holds: a GitHub expression that
 *  never ran. A template literal, so the `$` is not read as a mistake. */
const MATRIX_PLACEHOLDER = `\${{`

/** One `${{ ... }}` span in a check name, up to the first `}}`. */
const EXPRESSION = /\$\{\{.*?\}\}/

/** What one expression span matches: one or more characters, none of them
 *  `(` or `)`. A matrix value fills the span, and GitHub puts the values of
 *  a matrix job between parentheses. So a span never crosses the closing
 *  parenthesis into the next part of the name. */
const EXPRESSION_VALUE = '[^()]+'

/** A literal part of a check name, with each regular expression character
 *  escaped. Node 22 has no `RegExp.escape`. */
const literal = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The pattern that a skipped check's name gives.
 *
 * Each `${{ ... }}` span matches one or more characters that are not `(` or
 * `)`. The rest of the name matches literally. The pattern is anchored at
 * both ends, so no prefix or suffix of a name matches. A name with no span
 * matches only itself. That name has reported, so it is never left out.
 */
const wildcardOf = (name: string): RegExp =>
  new RegExp(`^${name.split(EXPRESSION).map(literal).join(EXPRESSION_VALUE)}$`)

/** The verdict list on a draft, and the names that it leaves out. */
export interface DraftSplit {
  /** The contexts that are part of the verdict, in the order given. */
  readonly counted: readonly ReportedContext[]
  /** The required names that run only after the pull request is ready
   *  for review, sorted. Empty when the pull request is not a draft. */
  readonly draftSkipped: readonly string[]
}

/**
 * The required contexts that a draft does not wait for (#365, round 15
 * ruling 5).
 *
 * A workflow can skip a job on a draft. GitHub skips a matrix job before
 * it expands the matrix. So the check keeps the expression in its name,
 * such as `Analyze (${{ matrix.language }})`, and the required names, such
 * as `Analyze (actions)`, never report on the draft head. A plain-named
 * skipped job reports `SKIPPED` under its own name, which satisfies.
 *
 * On a draft, a required context is draft-skipped when all of these are
 * true:
 *
 *   - No check on the head has its name, also not a check from a
 *     superseded cancelled run. A name that reported keeps its own
 *     verdict, also when it failed or still runs.
 *   - A check on the head came from a check suite that concluded
 *     `SKIPPED`. A suite that has not concluded, or that concluded in any
 *     other way, does not count.
 *   - That check's name has a `${{ ... }}` span, and matches the required
 *     name with each span read as a wildcard ({@link wildcardOf}).
 *
 * This is a heuristic. An unrelated skipped matrix job with a broad name
 * can match. No workflow file is read.
 */
export const splitDraftSkipped = (
  contexts: readonly ReportedContext[],
  checks: readonly CheckContext[],
  draft: boolean,
): DraftSplit => {
  if (!draft) return { counted: contexts, draftSkipped: [] }
  const patterns = checks
    .filter((check) => check.run?.conclusion === 'SKIPPED')
    .map((check) => wildcardOf(check.name))
  // Every check on the head, also one from a superseded cancelled run.
  // Such a name reads as not reported while its newer run works, and a
  // draft must still wait for it.
  const anyCheck = new Set(checks.map((check) => check.name))
  const skipped = new Set(
    contexts
      .filter(
        (context) =>
          !anyCheck.has(context.name) && patterns.some((pattern) => pattern.test(context.name)),
      )
      .map((context) => context.name),
  )
  return {
    counted: contexts.filter((context) => !skipped.has(context.name)),
    draftSkipped: [...skipped].sort(),
  }
}

/**
 * Whether a check has not concluded, and no workflow run made it.
 *
 * `lib/gh.ts` reads both kinds of check with no `run`. A commit status
 * has no run. Its `PENDING` and `EXPECTED` states read as a null
 * `conclusion`. A check run that no workflow made, such as one from an
 * app, also has no run. Each `CheckStatusState` other than `COMPLETED`
 * (`REQUESTED`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `PENDING`) has a
 * null `conclusion` too. So a null `conclusion` and an absent `run` are
 * the whole test. A check of either kind that has concluded is not
 * pending, and is never left out by this rule.
 *
 * `lib/gh.ts` also reads a workflow run that lacks a field as no run. So
 * this rule also leaves out a pending Actions check whose run came back
 * short. The verdict still waits for that run when its event is
 * `pull_request`. `pr-state` reads those runs of the head. Its head list
 * is not final until each one has completed.
 */
const isPendingWithoutRun = (check: CheckContext): boolean =>
  check.run === undefined && check.conclusion === null

/**
 * The checks that answer for the names of the head list: all of them,
 * less each pending check with no run whose name a check with a run also
 * reports (#383, round 15 ruling 7).
 *
 * The check with a run then answers for the name. A pending check with
 * no run is kept when no check with a run has its name. When an older
 * check of that name with no run has concluded, the pending one is the
 * newer report, such as a re-run of an app's check. It answers, so a
 * stale conclusion does not.
 */
export const answeringChecks = (checks: readonly CheckContext[]): CheckContext[] => {
  const withRun = new Set(
    checks.filter((check) => check.run !== undefined).map((check) => check.name),
  )
  return checks.filter((check) => !(isPendingWithoutRun(check) && withRun.has(check.name)))
}

/** The names a head must pass, and where they came from. */
export interface ContextNames<From extends string> {
  readonly names: readonly string[]
  readonly from: From
}

/**
 * The base branch's list, or the names that reported on the head when the
 * base has none. This is `pr-state`'s rule.
 *
 * The head list is only what has reported so far. A caller that uses it
 * must know when it is settled. `pr-state` reads that from the workflow
 * runs on the head.
 *
 * The head list leaves out three kinds of name. One is a name that only a
 * superseded cancelled run reported ({@link currentChecks}, #364). One is
 * a name that contains `${{`. That is a matrix job whose run stopped
 * before the matrix expanded, so no run reports it again (#364).
 *
 * The third is a pending check with no workflow run behind it (#383,
 * round 15 ruling 7): see {@link isPendingWithoutRun}. No workflow run on
 * the head waits for it, so `pr-state` cannot know if it will conclude.
 * One such check, from an app that never concluded it, held a stacked
 * pull request at `pending`. When it concludes, its name counts again,
 * with its conclusion. A check with a run is not changed by this rule.
 * When a check with a run has the same name, that check answers for it.
 * `pr-state` gives {@link reportContexts} the {@link answeringChecks}.
 * Under a ruleset, nothing is left out here: a required name always counts.
 *
 * The head list also leaves out each status of the review loop
 * ({@link isLoopStatus}). Without that, a `workstreams/review-1` status
 * would join the list of a stacked pull request once a round ends.
 */
export const namesOrHead = (
  required: readonly string[],
  checks: readonly CheckContext[],
  headRuns: readonly RunStamp[] = [],
): ContextNames<'ruleset' | 'head'> =>
  required.length > 0
    ? { names: required, from: 'ruleset' }
    : {
        names: currentChecks(checks, headRuns)
          .filter((check) => !isPendingWithoutRun(check))
          .map((check) => check.name)
          .filter((name) => !name.includes(MATRIX_PLACEHOLDER) && !isLoopStatus(name)),
        from: 'head',
      }

/**
 * The base branch's list, or the default branch's list when the base has
 * none. This is `watch`'s rule (P9).
 *
 * An empty list means that no ruleset requires anything of that branch.
 * `null` means the opposite fact: the list could not be read at all. The
 * two answer different questions, and a caller must not read the second as
 * the first (ruling 6, #298). `defaultRequired` is `null` exactly when the
 * default branch's own read failed this poll. The caller passes its list
 * only once that read has succeeded.
 *
 * A caller reads `from: 'unread'` the way it reads a failed read of the
 * base branch itself. This pull request is left as it was. It is read
 * again once the default branch reads.
 */
export const namesOrDefault = (
  required: readonly string[],
  defaultRequired: readonly string[] | null,
): ContextNames<'ruleset' | 'default' | 'unread'> => {
  if (required.length > 0) return { names: required, from: 'ruleset' }
  if (defaultRequired === null) return { names: [], from: 'unread' }
  return { names: defaultRequired, from: 'default' }
}

/** The most hops {@link stackBottom} follows. A stack is a few layers deep.
 *  A chain this long is more likely a loop that the cycle check missed, or a
 *  mistake, than a stack. */
export const MAX_STACK_DEPTH = 50

/** The part of an open pull request that the walk reads. */
export interface StackLink {
  readonly head: string
  readonly base: string
}

/** The branch whose rules a pull request answers to, or why none is known. */
export type StackBottom =
  | { readonly branch: string; readonly unavailable: null }
  | { readonly branch: null; readonly unavailable: string }

/**
 * The base of the stack bottom, found from the chain of bases (round 16
 * ruling 7, #398).
 *
 * From `base`, a base that is the head of an open pull request moves on to
 * that pull request's base. The walk stops at the first base that is the
 * head of no open pull request. That branch is the answer, and it is
 * `base` itself for a pull request in no chain. A chain that a person made
 * by hand, and not with `gh stack`, gets the same answer. Merges go down
 * that chain too, so its bottom's rules are the right ones.
 *
 * The answer depends on `base` alone, so a caller that holds many pull
 * requests asks once for each distinct base.
 *
 * Three cases have no bottom, and each gives a reason and no branch. A
 * caller reads that as an unreadable list, not as "nothing required":
 *
 *   - The chain loops back to a branch it has passed.
 *   - The chain is longer than {@link MAX_STACK_DEPTH}.
 *   - Two open pull requests have the same head, so the next hop is not
 *     one branch.
 *
 * `open` holds only pull requests whose head is a branch of this
 * repository. A fork's branch name says nothing about a branch here.
 */
export const stackBottom = (base: string, open: readonly StackLink[]): StackBottom => {
  const passed = new Set([base])
  let branch = base
  for (let hops = 0; hops <= MAX_STACK_DEPTH; hops++) {
    const below = open.filter((pull) => pull.head === branch)
    const next = below[0]
    if (next === undefined) return { branch, unavailable: null }
    if (below.length > 1) {
      return {
        branch: null,
        unavailable: `more than one open pull request has the head ${branch}, so the stack under ${base} has no one bottom`,
      }
    }
    if (passed.has(next.base)) {
      return {
        branch: null,
        unavailable: `the chain of bases under ${base} loops back to ${next.base}`,
      }
    }
    passed.add(next.base)
    branch = next.base
  }
  return {
    branch: null,
    unavailable: `the chain of bases under ${base} is longer than ${MAX_STACK_DEPTH} pull requests`,
  }
}
