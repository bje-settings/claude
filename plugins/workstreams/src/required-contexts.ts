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

/** The most recent conclusion reported under `name`, and whether anything
 *  reported under it at all.
 *
 *  The FIRST match wins, which is GitHub's newest. A re-run adds a second
 *  check with the same name, and the rollup lists the current one first. A
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

/** Each name once, in the order given, with what reported under it. */
export const reportContexts = (
  checks: readonly CheckContext[],
  names: readonly string[],
): ReportedContext[] => [...new Set(names)].map((name) => reportedAs(checks, name))

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
 */
export const namesOrHead = (
  required: readonly string[],
  checks: readonly CheckContext[],
): ContextNames<'ruleset' | 'head'> =>
  required.length > 0
    ? { names: required, from: 'ruleset' }
    : { names: checks.map((check) => check.name), from: 'head' }

/**
 * The base branch's list, or the default branch's list when the base has
 * none. This is `watch`'s rule (P9).
 *
 * An empty answer means that no ruleset requires anything of either branch.
 * A caller must not read that as "every required context passed".
 */
export const namesOrDefault = (
  required: readonly string[],
  defaultRequired: readonly string[],
): ContextNames<'ruleset' | 'default'> =>
  required.length > 0
    ? { names: required, from: 'ruleset' }
    : { names: defaultRequired, from: 'default' }
