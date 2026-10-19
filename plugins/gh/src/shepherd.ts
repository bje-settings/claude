// Both shepherd commands share this reading and shaping code. It is the
// port of `plugins/gh/scripts/lib/shepherd.py`.
//
// The shell library and the three jq programs beside it held four things
// between them: the fold that turns a `statusCheckRollup` into one word,
// the pull request summary the loop reads, the merge-risk ordering, and
// the median CI duration. The `--json` field list is the one part that did
// NOT come here. It moved into `lib/gh.ts` at #158, next to the endpoint
// that asks for it.
//
// Every decision is a plain function with a named test per arm.
// `.claude/rules/type-py.md` line 36 gives the reason, and the Python's own
// suite used the same design. Under kcov, each jq version was one line no
// matter how many outcomes it decided between. Three mutations of the
// check-state fold still left a suite of 219 examples green.
//
// Nothing here runs `gh`. The callers hand in parsed JSON and get back the
// object to print. The one exception is `directoryRefusal`, which touches
// the filesystem. It is the preflight check both commands make on the path
// they were given. It lives here for the same reason as the folds: it is
// the same decision in both commands, and a copy in each command would
// drift apart.
//
// **Everything gh answers is `unknown` here.** These functions exist
// because gh's answer may lack a field, or carry a null where an object
// was asked for. A declared pull-request type would be a promise. This
// module is written not to trust that promise.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from
// the tree. The file and line references below point at what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.

import { accessSync, constants, statSync } from 'node:fs'
import type { GhClient, RequiredReviews } from './lib/gh.ts'
import type { Output } from './lib/streams.ts'

/**
 * Everything a shepherd command is given: the process's edges, as arguments.
 *
 * This is the counterpart of `CommandContext` in `subcommands/sync-repo.ts`.
 * It is a type of its own for three reasons that command does not share.
 * `createGh` takes a repository as well as a directory, because six of
 * the eight `gh` calls these commands make name the repository with `--repo`
 * (`gh-shepherd-pr.py:399` and on), while the first call resolves the
 * repository from the checkout. `now` and `sleep` are here because
 * `rebase`, `wait` and `settle` each poll until a bound. A
 * test that passed a real timer would have to wait out a real bound
 * instead. The answer is an exit status, not an `Envelope<string>`, because
 * these commands have a fourth status: 3, an internal error. `lib/envelope.ts`
 * deliberately does not know this status (`gh-shepherd-pr.py:1071`).
 */
export interface ShepherdContext {
  /** The directory the caller started in, which is the default target. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  /** A `gh` scoped to a checkout, a repository, or both. Nothing here
   *  changes directory, so every call names the checkout. */
  readonly createGh: (target: { cwd?: string; repository?: string }) => GhClient
  /** A monotonic clock, in milliseconds. `settle` measures rather than
   *  accumulates ("the reads between two sleeps take time of their own",
   *  `gh-shepherd-pr.py:838`), so it needs a clock and not a counter. */
  readonly now: () => number
  /** Wait this many milliseconds. Injected, so a poll that waits 90 seconds
   *  of GitHub's time waits none of a test's. */
  readonly sleep: (milliseconds: number) => Promise<void>
}

/**
 * What a shepherd command answers with.
 *
 * This is `gh-shepherd-pr.py`'s documented set. 0 means the action ran and
 * reported (`ok: false` refusals included, because a refusal IS the
 * report). 2 is a usage error. 1 means gh could not answer at all. 3 is an
 * internal error. Status 3 sits outside the documented set on purpose, so
 * a caller that parses the JSON on stdout cannot read a crash as an
 * answer.
 */
export type ShepherdExit = 0 | 1 | 2 | 3

/** A CheckRun conclusion that does not block a merge. NEUTRAL and SKIPPED
 *  are not successes, but neither blocks one, so the fold counts them with
 *  SUCCESS. Everything else with status COMPLETED is a failure (FAILURE,
 *  CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, and a COMPLETED
 *  run whose conclusion is still null). Reading any of these as pending is
 *  the mistake that polls a cancelled build forever. */
const PASSING_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

/** The older commit-status API's two "not finished yet" states. */
const PENDING_STATES = ['PENDING', 'EXPECTED']

/** What the shepherd loop falls back to when a repository has no usable
 *  run history. This covers a repo without Actions, and one whose runs
 *  all measured non-positive. */
export const DEFAULT_CI_SECONDS = 300

/** The logins Dependabot appears under. `gh pr view --json author` prefixes
 *  an app with `app/`; the GraphQL and REST answers use the `[bot]` suffix. */
export const DEPENDABOT_LOGINS = [
  'dependabot',
  'app/dependabot',
  'dependabot[bot]',
  'app/dependabot[bot]',
]

/** gh-security's bands, in the order the loop should take them. An
 *  unlabelled pull request sits between low and medium: nobody has
 *  assessed it. That is not a reason to go last, and not a reason to go
 *  first. */
export const RISK_ORDER = ['merge-risk:low', '', 'merge-risk:medium', 'merge-risk:high']

/**
 * Python's truth test. The script this ports is written in Python.
 *
 * `x or y`, `if not x` and `and x` over a gh answer are truthiness checks,
 * not null checks, and the difference decides real cases. `reviewDecision`
 * is `""` on a repository that requires no review. `labels` is `[]` on a
 * pull request that carries none. `headRefOid` being `""` means gh answered
 * nothing, not that gh answered a SHA. Translating any of these to `??` or
 * to `!== null` reads an empty answer as an answer. That is the defect
 * nine guards in layer 2 shipped with. 100% branch coverage could not
 * find it.
 *
 * The last line covers string, number and boolean together. The three are
 * each a real gh value: `0`, `""` and `false`. A bigint, a symbol or a
 * function cannot come out of `JSON.parse`. Each would answer `true` here,
 * which is Python's answer for them too.
 */
export const isTruthy = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return value !== 0 && value !== '' && value !== false
}

/** The value as an object, or `null` for anything that is not one. A list
 *  is not one: `missing_field` states this directly, and every `.get` call
 *  in the Python would have raised an error on a list. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * One field of a value that may or may not be an object: the port of
 * `.get(name)`.
 *
 * Python raises `AttributeError` when the value is not a dict, and the
 * caller turns that error into exit 3. This function answers `undefined`
 * instead, so it reads a garbled row as a row with nothing in it, rather
 * than crashing the whole action. Nothing gh can answer with reaches this
 * difference, and both ends refuse to report on such a row.
 */
const field = (value: unknown, name: string): unknown => asRecord(value)?.[name]

/** `undefined` stands in for the `null` Python's `.get` answers with. A
 *  field gh did not send is then reported as a field with no value, rather
 *  than dropped from the document by `JSON.stringify`. */
const answered = (value: unknown): unknown => value ?? null

/** The value as a string, or `""`. This is what `x or ""` left the Python
 *  with, for every value it then called a string method on. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

export type CheckState = 'passed' | 'pending' | 'failed'

/**
 * One `statusCheckRollup` row as passed, pending, or failed.
 *
 * The rollup mixes two shapes. A CheckRun (GitHub Actions and most apps)
 * has `status` (QUEUED, IN_PROGRESS, COMPLETED) and `conclusion` (SUCCESS,
 * FAILURE, NEUTRAL, SKIPPED, ...). A StatusContext (the older commit-status
 * API) has a single `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED). It
 * names itself with `context`, not `name`. It links with `targetUrl`, not
 * `detailsUrl`. It carries no `conclusion` key at all.
 *
 * So this function dispatches on `__typename`, never on a field falling
 * through to another. A `conclusion ?? state` chain would read the wrong
 * row shape in silence, calling a pending StatusContext a failure because
 * it has no conclusion.
 *
 * A row that is not an object at all (a null element in the rollup, which
 * GraphQL can answer with) is pending. This matches what the jq did:
 * `null != "COMPLETED"` took the unfinished arm. Reading it as failed
 * would report a green pull request as broken.
 */
export const checkState = (row: unknown): CheckState => {
  const record = asRecord(row)
  if (record === null) return 'pending'
  if (record.__typename === 'StatusContext') {
    const state = record.state
    if (state === 'SUCCESS') return 'passed'
    if (PENDING_STATES.includes(asText(state))) return 'pending'
    return 'failed'
  }
  if (record.status !== 'COMPLETED') return 'pending'
  if (PASSING_CONCLUSIONS.includes(asText(record.conclusion))) return 'passed'
  return 'failed'
}

/** What a check is called: a CheckRun's name, a StatusContext's context. */
export const checkName = (row: unknown): unknown => {
  const name = field(row, 'name')
  // `is None`, not truthiness: a check named `""` has a name. Falling
  // through to `context` for it would report the other shape's field.
  return name === null || name === undefined ? answered(field(row, 'context')) : name
}

/** Where a check reports: a CheckRun's detailsUrl, a StatusContext's
 *  targetUrl. */
export const checkLink = (row: unknown): unknown => {
  const link = field(row, 'detailsUrl')
  return link === null || link === undefined ? answered(field(row, 'targetUrl')) : link
}

export interface FailingCheck {
  readonly name: unknown
  readonly link: unknown
}

export interface ChecksSummary {
  readonly state: CheckState | 'none'
  readonly failing: readonly FailingCheck[]
}

/**
 * The whole rollup as `{state, failing}`.
 *
 * `state` is one of none, failed, pending, passed. A failure wins over a
 * pending row on purpose: the loop should classify a known failure now,
 * rather than wait out the rest of the run. `none` is not `passed` to the
 * reader either (the caller reports it with its own detail). It is the
 * state of a pull request whose workflows have not queued yet.
 *
 * A rollup that is present but is not a list at all is read as no rows.
 * The Python iterated it, which for a string meant one pending row per
 * character. Neither GraphQL nor the endpoint's own parse can produce
 * that, so the alternative here would be to invent a state for it.
 */
export const checks = (pull: unknown): ChecksSummary => {
  const raw = field(pull, 'statusCheckRollup')
  const rollup: unknown[] = Array.isArray(raw) ? raw : []
  const results = rollup.map(checkState)
  const state = results.includes('failed')
    ? 'failed'
    : results.includes('pending')
      ? 'pending'
      : results.length === 0
        ? 'none'
        : 'passed'
  return {
    state,
    failing: rollup
      .filter((_row, index) => results[index] === 'failed')
      .map((row) => ({ name: checkName(row), link: checkLink(row) })),
  }
}

/**
 * The first required field gh did not answer with, or `""` when every
 * field is there.
 *
 * `summary` shapes whatever it is given, so an empty object comes back as
 * a pull request whose state is null and whose rollup is empty. `wait`
 * then reads an empty rollup as "nothing to watch, passed". The caller
 * checks this field first, and fails closed instead.
 *
 * This function checks `statusCheckRollup` for presence, not for content:
 * an empty rollup is a real answer about a pull request whose workflows
 * have not queued yet. It checks `reviewDecision` the same way, because
 * null is a real answer about a repository that requires no review, and
 * `settle` decides `blocked` from this field. It checks `labels` for
 * being a list, which is what gh answers with when a pull request
 * carries none.
 */
export const missingField = (pull: unknown): string => {
  const record = asRecord(pull)
  if (record === null) return 'a pull request object'
  // The fields the loop decides on. The checks differ per field, so this
  // list stays here, rather than in a constant nothing else reads.
  // `wait` and `state` compare the head with `baseRefName` (#460).
  for (const name of ['state', 'headRefOid', 'baseRefName']) {
    if (!isTruthy(record[name])) return name
  }
  if (!('statusCheckRollup' in record)) return 'statusCheckRollup'
  if (!('reviewDecision' in record)) return 'reviewDecision'
  if (!Array.isArray(record.labels)) return 'labels'
  return ''
}

/** The author's login, or `""`: the port of `(pull.get("author") or
 *  {}).get("login") or ""`. */
const authorLogin = (pull: unknown): string => asText(field(field(pull, 'author'), 'login'))

/**
 * Whether Dependabot itself authored this pull request.
 *
 * This check is deliberately a login match, not the general bot flag.
 * renovate and github-actions are bots too, and the report tells them
 * apart from Dependabot. No action branches on it.
 */
export const isDependabot = (pull: unknown): boolean =>
  DEPENDABOT_LOGINS.includes(authorLogin(pull))

/**
 * Whether any bot authored this pull request.
 *
 * gh reports `author.is_bot`, but this function checks the login too. A
 * GraphQL answer that omits the flag still names the actor. An app appears
 * as `app/<name>` from `gh pr view`, and as `<name>[bot]` elsewhere. This
 * is the flag the report carries.
 */
export const isBot = (pull: unknown): boolean => {
  // `is True`, an identity check in the Python. A truthy value that is
  // not the boolean means gh answered something this function does not
  // understand.
  if (field(field(pull, 'author'), 'is_bot') === true) return true
  const login = authorLogin(pull)
  return login.endsWith('[bot]') || login.startsWith('app/') || isDependabot(pull)
}

/** Review decisions that GitHub gives only when a review is required. */
const DECIDED_REVIEWS = ['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']

/** Review states that stand until the same author reviews again. A
 *  COMMENTED review does not take back an approval. */
const STANDING_REVIEWS = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']

/** Whether the approvals a pull request has meet what its base requires. */
export type Approval = 'met' | 'missing' | 'not_required'

/** Whether the review threads meet what its base requires. */
export type Threads = 'resolved' | 'unresolved' | 'not_required'

/**
 * Each author's standing review, oldest author first: the newest review of
 * that author whose state is in {@link STANDING_REVIEWS}.
 *
 * gh lists `reviews` oldest first. This is the list that GitHub's own
 * decision reads. It is not `latestReviews`, whose `commit.oid` gh leaves
 * empty, and which can keep a COMMENTED review in place of an approval.
 */
const standingReviews = (pull: unknown): { state: string; commit: string }[] => {
  const listed = field(pull, 'reviews')
  const byAuthor = new Map<string, { state: string; commit: string }>()
  for (const review of Array.isArray(listed) ? listed : []) {
    const state = asText(field(review, 'state'))
    if (!STANDING_REVIEWS.includes(state)) continue
    byAuthor.set(asText(field(field(review, 'author'), 'login')), {
      state,
      commit: asText(field(field(review, 'commit'), 'oid')),
    })
  }
  return [...byAuthor.values()]
}

/**
 * The approval verdict, from `reviewDecision`, `reviews` and the rules of
 * the base (rulings 1, 2, 5 and 10 on #465).
 *
 * An approval is required when the rules ask for a count above 0 or for a
 * code owner, or when `reviewDecision` names a decision. A ruleset can leave
 * `reviewDecision` empty, so the rules decide too.
 *
 * A required approval is met by `reviewDecision` APPROVED, or by enough
 * standing APPROVED reviews. A code owner rule takes at least one. This
 * does not prove that the approver is a code owner: that needs CODEOWNERS
 * and team membership. GitHub then still blocks the merge, and the worker
 * skips the pull request on BLOCKED. A last-push rule counts only an
 * approval of the current head. A requested change is never met.
 * REVIEW_REQUIRED is GitHub's own word that the reviews are not enough, so
 * a count does not override it.
 *
 * `rules` is `null` when they were not read. Then only `reviewDecision`
 * can make an approval missing, and a failed read never leaves a pull
 * request out.
 */
export const approvalOf = (pull: unknown, rules: RequiredReviews | null): Approval | null => {
  const decision = asText(field(pull, 'reviewDecision'))
  const need = Math.max(rules?.approvals ?? 0, rules?.codeOwner === true ? 1 : 0)
  if (need === 0 && !DECIDED_REVIEWS.includes(decision)) {
    return rules === null ? null : 'not_required'
  }
  const reviews = standingReviews(pull)
  if (decision === 'CHANGES_REQUESTED') return 'missing'
  if (reviews.some((review) => review.state === 'CHANGES_REQUESTED')) return 'missing'
  if (decision === 'APPROVED') return 'met'
  if (decision === 'REVIEW_REQUIRED') return 'missing'
  // Here the rules alone require it, so `need` is at least 1, and `rules`
  // were read.
  const head = asText(field(pull, 'headRefOid'))
  const approved = reviews.filter(
    (review) => review.state === 'APPROVED' && (rules?.lastPush !== true || review.commit === head),
  )
  return approved.length >= need ? 'met' : 'missing'
}

/**
 * The review-thread verdict (ruling 10 on #465).
 *
 * `unresolved` is the count of unresolved threads, or `null` when they were
 * not read. Only a rule that asks for resolved threads makes the count
 * matter. A read that failed is `null`, and never leaves a pull request
 * out.
 */
export const threadsOf = (
  rules: RequiredReviews | null,
  unresolved: number | null,
): Threads | null => {
  if (rules === null) return null
  if (!rules.threadResolution) return 'not_required'
  if (unresolved === null) return null
  return unresolved > 0 ? 'unresolved' : 'resolved'
}

/**
 * The number of unresolved review threads on a pull request, or `null` when
 * the read failed. stderr then says why.
 *
 * Both commands make this read, so it lives here, beside
 * {@link directoryRefusal}. A count that is zero, from a read that also
 * reports a short page, is `null`: more threads can be past the page.
 */
export const readUnresolvedThreads = async (
  gh: GhClient,
  pullRequest: number,
  err: Output['err'],
): Promise<number | null> => {
  const answer = await gh.viewPullRequestDetail({ pullRequest })
  const count = answer.pullRequest?.unresolvedThreads.length ?? 0
  if (count > 0) return count
  if (answer.unavailable === null) return 0
  err.write(
    `the review threads of #${pullRequest} are unavailable: ${answer.unavailable}; threads is null\n`,
  )
  return null
}

/**
 * The review rules of `base`, or `null` when they could not be read. stderr
 * then says why, and the verdicts rest on `reviewDecision` alone (ruling 5
 * on #465). Both commands make this read.
 */
export const readReviewRules = async (
  gh: GhClient,
  base: string,
  err: Output['err'],
): Promise<RequiredReviews | null> => {
  const answer = await gh.requiredReviews({ branch: base })
  if (answer.reviews === null) {
    err.write(
      `the review rules of ${base} are unavailable: ${answer.unavailable}; approval rests on ` +
        'reviewDecision\n',
    )
  }
  return answer.reviews
}

/** The pull request as every action reports it. The key order is the
 *  contract; see {@link summary}. */
export interface PullSummary {
  readonly number: unknown
  readonly title: unknown
  readonly author: unknown
  readonly is_bot: boolean
  readonly state: unknown
  readonly mergeStateStatus: unknown
  readonly mergeable: unknown
  readonly headRefOid: unknown
  readonly autoMerge: boolean
  readonly mergeCommit: unknown
  readonly labels: readonly unknown[]
  readonly createdAt: unknown
  readonly checks: ChecksSummary
  readonly is_dependabot: boolean
  readonly reviewDecision: unknown
  /** The branch the pull request merges into. `shepherd-pr` compares the
   *  head with it (#460). */
  readonly baseRefName: unknown
  /** The verdict of {@link approvalOf} (#465). */
  readonly approval: Approval | null
  /** The verdict of {@link threadsOf} (#465). */
  readonly threads: Threads | null
}

/** Whether a human has marked this pull request for auto-merge. `is not
 *  None`, not truthiness: the field is an object or it is absent. */
const hasAutoMerge = (pull: unknown): boolean => {
  const request = field(pull, 'autoMergeRequest')
  return request !== null && request !== undefined
}

/**
 * The pull request as every action reports it.
 *
 * Key order is the contract. The agent reads fields by name, but a human
 * also reads the JSON in a transcript, and the shell version printed the
 * fields in this order. A field added since goes on the end, so the order
 * of the fields already there still holds. The order here is the order
 * `JSON.stringify` writes, because a string key keeps its insertion
 * position.
 *
 * Nothing here validates the pull request. {@link missingField} does that,
 * and the callers run it before they call this function. `reviews` is not
 * in that check: a list that is absent is no reviews, and the verdict then
 * rests on `reviewDecision` and the rules.
 *
 * `rules` are the review rules of the base, and `unresolved` the count of
 * unresolved review threads. Each is `null` when the caller did not read
 * it. Only `state` and `shepherd-status` read them.
 */
export const summary = (
  pull: unknown,
  rules: RequiredReviews | null = null,
  unresolved: number | null = null,
): PullSummary => {
  const labels = field(pull, 'labels')
  return {
    number: answered(field(pull, 'number')),
    title: answered(field(pull, 'title')),
    author: answered(field(field(pull, 'author'), 'login')),
    is_bot: isBot(pull),
    state: answered(field(pull, 'state')),
    mergeStateStatus: answered(field(pull, 'mergeStateStatus')),
    mergeable: answered(field(pull, 'mergeable')),
    headRefOid: answered(field(pull, 'headRefOid')),
    autoMerge: hasAutoMerge(pull),
    mergeCommit: answered(field(field(pull, 'mergeCommit'), 'oid')),
    labels: (Array.isArray(labels) ? labels : []).map((label) => answered(field(label, 'name'))),
    createdAt: answered(field(pull, 'createdAt')),
    checks: checks(pull),
    is_dependabot: isDependabot(pull),
    // `""` covers a repository that requires no review. This is the
    // common case, and a real answer, so `missingField` does not require
    // this field. `settle` reads REVIEW_REQUIRED and CHANGES_REQUESTED as
    // proof that auto-merge cannot fire. It does not guess at branch
    // protection.
    reviewDecision: isTruthy(field(pull, 'reviewDecision')) ? field(pull, 'reviewDecision') : '',
    baseRefName: answered(field(pull, 'baseRefName')),
    approval: approvalOf(pull, rules),
    threads: threadsOf(rules, unresolved),
  }
}

/**
 * The merge-risk band as a sort key: low, unlabelled, medium, high.
 *
 * The first `merge-risk:` label wins, as jq's `first` did. This function
 * sorts a band nobody recognises after all four, rather than read it as
 * one of them.
 */
export const rank = (pull: unknown): number => {
  const labels = field(pull, 'labels')
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = asText(field(label, 'name'))
    if (name.startsWith('merge-risk:')) {
      const known = RISK_ORDER.indexOf(name)
      return known === -1 ? RISK_ORDER.length : known
    }
  }
  return RISK_ORDER.indexOf('')
}

/**
 * An ISO 8601 stamp in seconds, or `null` for anything that is not one.
 *
 * This is the port of `_epoch`. `_epoch` raised `ValueError` on anything
 * `strptime` could not read, and `TypeError` on a stamp that was not text.
 * {@link ciSeconds} catches both cases with a fallback, so `null` here
 * means the same thing. The pattern is stricter than `strptime` in one way
 * that no real answer reaches: `strptime` accepts a one-digit month, where
 * gh always writes two digits.
 */
const epochSeconds = (stamp: unknown): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(asText(stamp))) return null
  const milliseconds = Date.parse(asText(stamp))
  // A well-formed stamp that names a day or a month that does not exist.
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000
}

/**
 * The median wall time of the given workflow runs, or 300 when none are
 * usable.
 *
 * A run's wall time is `updatedAt - createdAt`. `startedAt` can be null
 * for a run that was queued and never started, so this function does not
 * use it. Failures stay in the count: a failing run took as long as it
 * took, and the loop sizes a wait, not a health check. Runs that miss
 * either stamp, or that have a non-positive duration, are dropped.
 *
 * One row that this function cannot read ends the whole measurement at
 * the fallback, the way jq's error on one unparseable stamp did. A
 * listing with a row like that is not a real answer about durations.
 *
 * The median is the upper of the two middles for an even count. This
 * matches what jq's `sort | .[length / 2 | floor]` picked, so the two
 * agree on every input.
 */
export const ciSeconds = (runs: unknown): number => {
  const durations: number[] = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const record = asRecord(run)
    // The row that raised `AttributeError` in the Python.
    if (record === null) return DEFAULT_CI_SECONDS
    const created = record.createdAt
    const updated = record.updatedAt
    // `is None`. A stamp that is present but unreadable takes the arm
    // below. It is not a row that this function quietly skips.
    if (created === null || created === undefined) continue
    if (updated === null || updated === undefined) continue
    const from = epochSeconds(created)
    const to = epochSeconds(updated)
    if (from === null || to === null) return DEFAULT_CI_SECONDS
    if (to - from > 0) durations.push(to - from)
  }
  durations.sort((left, right) => left - right)
  // One lookup covers both "no usable run" and the index. An empty list
  // has no middle, so the fallback is the same answer for both cases. No
  // second branch is left untested.
  const median = durations[Math.floor(durations.length / 2)]
  return median === undefined ? DEFAULT_CI_SECONDS : median
}

/** Why `shepherd-status` leaves a pull request out (ruling 10 on #465). */
export const NEEDS_APPROVAL = 'needs an approval'
export const UNRESOLVED_THREADS = 'has unresolved review threads'

/** A pull request that `shepherd-status` leaves out, with each reason. */
export interface NotReady {
  readonly number: unknown
  readonly title: unknown
  readonly author: unknown
  readonly reasons: readonly string[]
}

export interface StatusDocument {
  readonly repo: string
  readonly default_branch: string
  readonly ci_seconds: number
  readonly targets: readonly PullSummary[]
  /** Empty with `--all`, and when nothing was left out (#465). */
  readonly not_ready: readonly NotReady[]
}

/** `createdAt` as the sort key, or `""`. This is the port of
 *  `pull.get("createdAt") or ""`. It is a string comparison, in the Python
 *  and here. */
const createdAt = (pull: unknown): string => asText(field(pull, 'createdAt'))

/** Two stamps compared by code unit, which is `<` in both languages.
 *  `localeCompare` would order by the machine's locale instead. */
const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** The base a pull request merges into, or `""`. */
const baseOf = (pull: unknown): string => asText(field(pull, 'baseRefName'))

/** Open, non-draft pull requests that a human has marked for auto-merge. */
const autoMergeRows = (pulls: unknown): unknown[] =>
  (Array.isArray(pulls) ? pulls : []).filter(
    (pull) => !isTruthy(field(pull, 'isDraft')) && hasAutoMerge(pull),
  )

/** Each base of the auto-merge pull requests, once. `shepherd-status`
 *  reads the review rules of each one (#465). A row with no base is not
 *  a branch to ask about. */
export const autoMergeBases = (pulls: unknown): string[] => [
  ...new Set(
    autoMergeRows(pulls)
      .map(baseOf)
      .filter((base) => base !== ''),
  ),
]

/** The number of each auto-merge pull request whose base asks for resolved
 *  review threads. `shepherd-status` reads the threads of these alone. */
export const threadReads = (
  pulls: unknown,
  rules: ReadonlyMap<string, RequiredReviews | null>,
): number[] =>
  autoMergeRows(pulls)
    .filter((pull) => rules.get(baseOf(pull))?.threadResolution === true)
    .map((pull) => Number(field(pull, 'number')))

export interface StatusOptions {
  /** The review rules of each base. `null`, or a base not here, means the
   *  rules were not read. */
  readonly rules: ReadonlyMap<string, RequiredReviews | null>
  /** The unresolved review threads of each pull request, by number. `null`,
   *  or a number not here, means the threads were not read. */
  readonly threads: ReadonlyMap<number, number | null>
  /** `--all`: every auto-merge pull request is a target. */
  readonly all: boolean
}

/**
 * The whole `gh-shepherd-status.py` report.
 *
 * Drafts are out of scope entirely. Of what is left, a target is a pull
 * request that a human has already marked for auto-merge. One without that
 * mark is left out: auto-merge is the human's signal that the pull request
 * is wanted, and this never enables it.
 *
 * Without `--all`, a pull request whose approval is `missing`, or whose
 * threads are `unresolved`, is not a target either. It goes to
 * `not_ready`, in the same order, with each reason, so the report can name
 * it (#465).
 */
export const statusDocument = (
  pulls: unknown,
  repo: string,
  defaultBranch: string,
  ci: number,
  options: StatusOptions,
): StatusDocument => {
  const rows = autoMergeRows(pulls)
  // Stable in Python and in JavaScript. Two pull requests with the same key
  // keep the order gh listed them in.
  rows.sort((left, right) => rank(left) - rank(right) || byText(createdAt(left), createdAt(right)))
  const targets: PullSummary[] = []
  const notReady: NotReady[] = []
  for (const pull of rows) {
    const shaped = summary(
      pull,
      options.rules.get(baseOf(pull)) ?? null,
      options.threads.get(Number(field(pull, 'number'))) ?? null,
    )
    const reasons = [
      ...(shaped.approval === 'missing' ? [NEEDS_APPROVAL] : []),
      ...(shaped.threads === 'unresolved' ? [UNRESOLVED_THREADS] : []),
    ]
    if (options.all || reasons.length === 0) {
      targets.push(shaped)
    } else {
      notReady.push({ number: shaped.number, title: shaped.title, author: shaped.author, reasons })
    }
  }
  return {
    repo,
    default_branch: defaultBranch,
    ci_seconds: ci,
    targets,
    not_ready: notReady,
  }
}

/**
 * gh's output on one line, so it can sit in a JSON detail.
 *
 * This function collapses whitespace, rather than replace only the
 * newlines, so a message never arrives with a trailing space where gh's
 * own final newline was. `text.split()` with no argument is what the
 * Python calls (`gh-shepherd-pr.py:200`). It splits on runs of any
 * whitespace and drops the empty ends.
 *
 * `\s` is NOT that exact set, and this note says so instead of widening
 * the pattern. Python also splits on `\x1c` to `\x1f` and `\x85`, and
 * does not split on `\ufeff`. JavaScript does the opposite on both.
 * Unlike {@link tailLines}, whose missing separator was the bare
 * carriage return a progress bar writes on every redraw, nothing gh
 * prints carries any of these characters. A hand-built, exhaustive
 * whitespace class in a shipping function would cover no reachable case.
 * So the set stays `\s`, and this comment records the difference instead
 * of hiding it.
 */
export const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ')

/**
 * Everything `str.splitlines()` breaks a line on. This is what the Python
 * counted (`gh-shepherd-pr.py:337`).
 *
 * Splitting on `\\n` alone is not the same bound. A CI job's
 * `--log-failed` output carries bare carriage returns wherever a tool
 * redrew a progress bar. `SHEPHERD_LOG_LINES` would then keep 60 of those
 * runs, not 60 lines, so the tail an agent reads is far longer than the
 * one asked for.
 *
 * This is built, not written as a literal, for the same reason as
 * `ANSI_RE` above: most of these are control characters, and a linter
 * warns against a regular expression literal that carries them.
 */
const BREAKS = [10, 11, 12, 13, 28, 29, 30, 0x85, 0x2028, 0x2029]
  .map((code) => String.fromCharCode(code))
  .join('')
const PATTERN = `${String.fromCharCode(13, 10)}|[${BREAKS}]`
const LINE_BREAK = new RegExp(PATTERN)
/** The same, anchored: only a terminator at the very end is dropped. */
const LAST_BREAK = new RegExp(`(?:${PATTERN})$`)

/**
 * The last `count` lines, joined by newlines, the way `tail -n` into
 * `$(...)` gave them.
 *
 * Command substitution stripped the trailing newline, so the result never
 * ends in one, and an empty log is the empty string, not a newline.
 */
export const tailLines = (text: string, count: number): string => {
  // `splitlines()`: a trailing line terminator does not make a final
  // empty line. The empty string means no lines at all, not one empty
  // line.
  const lines = text === '' ? [] : text.replace(LAST_BREAK, '').split(LINE_BREAK)
  return lines.slice(Math.max(lines.length - count, 0)).join('\n')
}

/**
 * Why the target path cannot be worked in, or `null` when it can.
 *
 * This is the port of the two preflight refusals both scripts make
 * (`gh-shepherd-pr.py:1000` to `:1012`, `gh-shepherd-status.py:135` to
 * `:143`). Both exit 2. The Python asks `os.path.isdir`, then `os.chdir`.
 * Nothing here changes directory, because several commands share one
 * process, and every git and gh call names its own directory. So this
 * function asks the second question as the access check that `chdir`
 * itself needs: the execute bit, which makes a directory searchable.
 *
 * The refused-access line therefore carries node's account of the
 * refusal, where the Python carried Python's account (`[Errno 13]
 * Permission denied: '<p>'`). The sentence in front of it is the same in
 * both. This is what a caller reads, and what the tests assert.
 */
export const directoryRefusal = (target: string): string | null => {
  try {
    if (!statSync(target).isDirectory()) return `not a directory: ${target}`
  } catch {
    // A path that is not there at all. `os.path.isdir` answers `False`
    // for this case, rather than raise an error.
    return `not a directory: ${target}`
  }
  try {
    accessSync(target, constants.X_OK)
  } catch (error) {
    return `cannot enter ${target}: ${(error as Error).message}`
  }
  return null
}

/**
 * The run and the job a failing check's link names, or `null` for a link
 * that names neither.
 *
 * This is the port of `JOB_LINK_RE` (`gh-shepherd-pr.py:107`). Only an
 * Actions job reports under `.../actions/runs/<run>/job/<job>`, and only
 * that link has a log gh can fetch. A StatusContext links to its own
 * service, so the caller walks past it, rather than stop at the first
 * failing row.
 *
 * The defaults in the destructuring are what a link that matched nothing
 * leaves behind. This is the same answer as a pattern that cannot match
 * without at least one digit in each group.
 */
export const jobLink = (link: unknown): { readonly run: string; readonly job: string } | null => {
  const parts = /\/actions\/runs\/([0-9]+)\/job\/([0-9]+)/.exec(asText(link)) ?? []
  const [, run = '', job = ''] = parts
  return run === '' ? null : { run, job }
}
