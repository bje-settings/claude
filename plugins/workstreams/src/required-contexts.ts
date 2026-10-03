// The one derivation of the required status-check contexts. `pr-state` and
// `watch` both use it (round 10 ruling P6). So the two cannot disagree about
// the names a head must pass. They also cannot disagree about what
// satisfies one.
//
// A ruleset on a topic branch is rare. No ruleset covers the base of a stack
// layer above the first, so the list for that base is empty. The two callers
// want different fallbacks for that case:
//
//   - `pr-state` falls back to the names that reported on the head. It also
//     reads the workflow runs, so it can tell when that list is settled.
//   - `watch` falls back to the DEFAULT branch's list (ruling P9). It reads
//     no runs. In round 5, the head-only rule concluded on seven CodeQL
//     checks and none of the required ones.
//
// Both callers read the checks through the same filter (#364). A check
// from a cancelled workflow run does not count when a newer run of the
// same workflow has a check on the head. Workflow concurrency cancels a
// run that way. The cancelled run's fan-in jobs then fail. A reader that
// kept them would report red while the newer run still works.
//
// This file ships. It imports only a type from `lib/`.
import type { CheckContext, CheckWorkflowRun } from './lib/gh.ts'

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

/**
 * Which of two workflow runs is the newer one: the later `createdAt`, and
 * on a tie the larger run id. Two runs can start in the same second. The
 * newer one must win also after it concluded, or the cancelled run stays
 * the answer.
 */
const isNewerRun = (candidate: CheckWorkflowRun, current: CheckWorkflowRun): boolean =>
  candidate.createdAt === current.createdAt
    ? candidate.id > current.id
    : candidate.createdAt > current.createdAt

/**
 * The checks that still count: every check, less those from a superseded
 * cancelled run (#364).
 *
 * A run is superseded when it was cancelled, and a newer run of the same
 * workflow has a check on the same head. A check with no run, such as a
 * commit status, always counts. A check from a cancelled run that no newer
 * run follows also counts. That run is still the answer, and it is red.
 *
 * The newer run is visible only through its own checks. Before it makes
 * its first check, the cancelled run's checks still count. After that, a
 * name it has not made yet has no check that counts. That name reads as
 * not reported, so it is pending, not failed.
 */
export const currentChecks = (checks: readonly CheckContext[]): CheckContext[] => {
  const runs = checks.flatMap((check) => (check.run === undefined ? [] : [check.run]))
  const superseded = (run: CheckWorkflowRun): boolean =>
    run.conclusion === 'CANCELLED' &&
    runs.some((other) => other.workflowId === run.workflowId && isNewerRun(other, run))
  return checks.filter((check) => check.run === undefined || !superseded(check.run))
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

/** Each name once, in the order given, with what reported under it. Only
 *  the checks that still count answer ({@link currentChecks}). */
export const reportContexts = (
  checks: readonly CheckContext[],
  names: readonly string[],
): ReportedContext[] => {
  const current = currentChecks(checks)
  return [...new Set(names)].map((name) => reportedAs(current, name))
}

/** What an unexpanded matrix job's name holds: a GitHub expression that
 *  never ran. A template literal, so the `$` is not read as a mistake. */
const MATRIX_PLACEHOLDER = `\${{`

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
 * The head list leaves out two kinds of name (#364). One is a name that
 * only a superseded cancelled run reported ({@link currentChecks}). The
 * other is a name that contains `${{`. That is a matrix job whose run
 * stopped before the matrix expanded, so no run reports it again.
 */
export const namesOrHead = (
  required: readonly string[],
  checks: readonly CheckContext[],
): ContextNames<'ruleset' | 'head'> =>
  required.length > 0
    ? { names: required, from: 'ruleset' }
    : {
        names: currentChecks(checks)
          .map((check) => check.name)
          .filter((name) => !name.includes(MATRIX_PLACEHOLDER)),
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
