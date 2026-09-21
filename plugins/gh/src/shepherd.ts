// The reading and shaping both shepherd commands share: the port of
// `plugins/gh/scripts/lib/shepherd.py`.
//
// What the shell library and the three jq programs beside it held between
// them: the fold that turns a `statusCheckRollup` into one word, the pull
// request summary the loop reads, the merge-risk ordering, and the median CI
// duration. The `--json` field list is the one part that did NOT come here:
// it moved into `lib/gh.ts` at #158, where the endpoint that asks for it is.
//
// Every decision is a plain function with a named test per arm
// (`.claude/rules/type-py.md` line 36 describes why, and the Python's own
// suite is organised the same way): under kcov the jq versions were one line
// each however many outcomes they decided between, and three mutations of the
// check-state fold left a 219 example suite green.
//
// Nothing here runs `gh`: the callers hand in parsed JSON and get back the
// object to print. The one thing that touches the filesystem is
// `directoryRefusal`, which is the preflight both commands make on the path
// they were given, and is here for the same reason the folds are: it is the
// same decision in both, and a copy in each is a copy that drifts.
//
// **Everything gh answers is `unknown` here.** These functions exist because
// gh's answer may be missing a field, or carry a null where an object was
// asked for, and a declared pull-request type would be a promise this module
// is written not to trust.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.

import { accessSync, constants, statSync } from 'node:fs'
import type { GhClient } from './lib/gh.ts'
import type { Output } from './lib/streams.ts'

/**
 * Everything a shepherd command is given: the process's edges, as arguments.
 *
 * The counterpart of `CommandContext` in `commands/sync-repo.ts`, and it is a
 * type of its own for three reasons that command does not have. `createGh`
 * takes a repository as well as a directory, because seven of the ten `gh`
 * calls these commands make name the repository with `--repo`
 * (`gh-shepherd-pr.py:399` and on) while the first one resolves it from the
 * checkout. `now` and `sleep` are here because `recreate` polls, `wait` is
 * bounded and `settle` polls until a bound, and a test that passed a real
 * timer would have to wait out a real bound. And the answer is an exit status
 * rather than an `Envelope<string>`, because these commands have a fourth
 * status: 3, an internal error, which `lib/envelope.ts` deliberately does not
 * know (`gh-shepherd-pr.py:1071`).
 */
export interface ShepherdContext {
  /** The directory the caller started in, which is the default target. */
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
  /** A `gh` scoped to a checkout, a repository, or both. Nothing here changes
   *  directory, so the checkout is named at every call. */
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
 * `gh-shepherd-pr.py`'s documented set: 0 the action ran and reported
 * (`ok: false` refusals included, because a refusal IS the report), 2 a usage
 * error, 1 gh could not answer at all, and 3 an internal error, which is
 * outside the documented set on purpose so a caller parsing the JSON on stdout
 * cannot read a crash as an answer.
 */
export type ShepherdExit = 0 | 1 | 2 | 3

/** A CheckRun conclusion that does not stand in the way of a merge. NEUTRAL
 *  and SKIPPED are not successes, but neither blocks one, so the fold counts
 *  them with SUCCESS. Everything else that has COMPLETED (FAILURE, CANCELLED,
 *  TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, and a COMPLETED run whose
 *  conclusion is still null) is a failure. Reading any of those as pending is
 *  the mistake that polls a cancelled build forever. */
const PASSING_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

/** The older commit-status API's two "not finished yet" states. */
const PENDING_STATES = ['PENDING', 'EXPECTED']

/** What the shepherd loop falls back to when a repository has no usable run
 *  history: a repo without Actions, or one whose runs all measured
 *  non-positive. */
export const DEFAULT_CI_SECONDS = 300

/** The logins Dependabot appears under. `gh pr view --json author` prefixes
 *  an app with `app/`; the GraphQL and REST answers use the `[bot]` suffix. */
export const DEPENDABOT_LOGINS = [
  'dependabot',
  'app/dependabot',
  'dependabot[bot]',
  'app/dependabot[bot]',
]

/** gh-security's bands, in the order the loop should take them. An unlabelled
 *  pull request sits between low and medium: it has not been assessed, which
 *  is not a reason to go last and not a reason to go first. */
export const RISK_ORDER = ['merge-risk:low', '', 'merge-risk:medium', 'merge-risk:high']

/**
 * Python's truth test, which is what the script this ports is written in.
 *
 * `x or y`, `if not x` and `and x` over a gh answer are truthiness, not a null
 * check, and the difference decides real cases: `reviewDecision` is `""` on a
 * repository that requires no review, `labels` is `[]` on a pull request that
 * carries none, and `headRefOid` being `""` is gh answering nothing rather
 * than gh answering a SHA. Translating one of those to `??` or to
 * `!== null` reads an empty answer as an answer, which is the defect nine
 * guards in layer 2 shipped with and 100% branch coverage could not see.
 *
 * The last line covers string, number and boolean together, and the three are
 * each a real gh value: `0`, `""` and `false`. A bigint, a symbol or a
 * function cannot come out of `JSON.parse`, and would answer `true` here,
 * which is Python's answer for them too.
 */
export const isTruthy = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return value !== 0 && value !== '' && value !== false
}

/** The value as an object, or `null` for anything that is not one. A list is
 *  not one: `missing_field` says so in as many words, and every `.get` in the
 *  Python would have raised on it. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * One field of what may or may not be an object: the port of `.get(name)`.
 *
 * Python raises `AttributeError` when the value is not a dict and the caller
 * turns that into an exit 3; this answers `undefined` instead, so a garbled
 * row is read as a row with nothing in it rather than crashing the whole
 * action. Nothing gh can answer with reaches the difference, and both ends
 * refuse to report on such a row.
 */
const field = (value: unknown, name: string): unknown => asRecord(value)?.[name]

/** `undefined` as the `null` Python's `.get` answers with, so a field gh did
 *  not send is reported as a field with no value rather than dropped from the
 *  document by `JSON.stringify`. */
const answered = (value: unknown): unknown => value ?? null

/** The value as a string, or `""`, which is what `x or ""` left the Python
 *  with for every value it then called a string method on. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

export type CheckState = 'passed' | 'pending' | 'failed'

/**
 * One `statusCheckRollup` row as passed, pending, or failed.
 *
 * The rollup mixes two shapes. A CheckRun (GitHub Actions and most apps) has
 * `status` (QUEUED, IN_PROGRESS, COMPLETED) and `conclusion` (SUCCESS,
 * FAILURE, NEUTRAL, SKIPPED, ...). A StatusContext (the older commit-status
 * API) has a single `state` (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED),
 * names itself with `context` rather than `name`, links with `targetUrl`
 * rather than `detailsUrl`, and carries no `conclusion` key at all.
 *
 * So the dispatch is on `__typename`, never on a field falling through: a
 * `conclusion ?? state` chain reads the wrong row shape silently, calling a
 * pending StatusContext a failure because it has no conclusion.
 *
 * A row that is not an object at all (a null element in the rollup, which
 * GraphQL can answer with) is pending, which is what the jq did: `null !=
 * "COMPLETED"` took the unfinished arm. Reading it as failed would report a
 * green pull request as broken.
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
  // `is None`, not truthiness: a check named `""` has a name, and falling
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
 * pending row on purpose: the loop should classify a known failure now rather
 * than wait out the rest of the run. `none` is not `passed` to the reader
 * either (the caller reports it with its own detail) but it is the state a
 * pull request whose workflows have not queued yet is in.
 *
 * A rollup that is present and is not a list at all is read as no rows. The
 * Python iterated it, which for a string meant one pending row per character;
 * neither GraphQL nor the endpoint's own parse can produce that, and the
 * alternative here would be to invent a state for it.
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
 * The first required field gh did not answer with, or `""` when all are there.
 *
 * `summary` shapes whatever it is given, so an empty object comes back as a
 * pull request whose state is null and whose rollup is empty, and `wait` reads
 * an empty rollup as "nothing to watch, passed". The caller checks this first
 * and fails closed instead.
 *
 * `statusCheckRollup` is checked for presence rather than for content: an
 * empty rollup is a real answer about a pull request whose workflows have not
 * queued yet. `reviewDecision` likewise, because null is a real answer about a
 * repository that requires no review and `settle` decides `blocked` from the
 * field. `labels` is checked for being a list, which is what gh answers with
 * when a pull request carries none.
 */
export const missingField = (pull: unknown): string => {
  const record = asRecord(pull)
  if (record === null) return 'a pull request object'
  // The fields the loop decides on; the checks differ per field, so the list
  // is here rather than in a constant nothing else reads.
  for (const name of ['state', 'headRefOid']) {
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
 * `@dependabot recreate` is answered by one bot and ignored by every other, so
 * this is deliberately a login match and not the general bot flag: renovate
 * and github-actions are bots whose pull requests a recreate comment would
 * only litter.
 */
export const isDependabot = (pull: unknown): boolean =>
  DEPENDABOT_LOGINS.includes(authorLogin(pull))

/**
 * Whether any bot authored this pull request.
 *
 * `author.is_bot` is what gh reports, but the login is checked too: a GraphQL
 * answer that omits the flag still names the actor, and an app appears as
 * `app/<name>` from `gh pr view` and as `<name>[bot]` elsewhere. This is the
 * flag the report carries; what `recreate` acts on is `isDependabot`.
 */
export const isBot = (pull: unknown): boolean => {
  // `is True`, an identity check in the Python: a truthy value that is not the
  // boolean is gh answering something this does not understand.
  if (field(field(pull, 'author'), 'is_bot') === true) return true
  const login = authorLogin(pull)
  return login.endsWith('[bot]') || login.startsWith('app/') || isDependabot(pull)
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
 * Key order is the contract: the agent reads fields by name, but the JSON is
 * also read by a human in a transcript, and the shell version printed them in
 * this order. A field added since goes on the end, so the order of the ones
 * that were already there still holds. The order here is the order
 * `JSON.stringify` writes, because a string key keeps its insertion position.
 *
 * Nothing here validates: {@link missingField} does that, and the callers run
 * it before they get here.
 */
export const summary = (pull: unknown): PullSummary => {
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
    // `""` for a repository that requires no review, which is the common case
    // and a real answer, and why `missingField` does not require it.
    // REVIEW_REQUIRED and CHANGES_REQUESTED are what `settle` reads as proof
    // that auto-merge cannot fire, rather than guessing at branch protection.
    reviewDecision: isTruthy(field(pull, 'reviewDecision')) ? field(pull, 'reviewDecision') : '',
  }
}

/**
 * The merge-risk band as a sort key: low, unlabelled, medium, high.
 *
 * The first `merge-risk:` label wins, as jq's `first` did. A band nobody
 * recognises sorts after all four rather than being read as one of them.
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
 * The port of `_epoch`, which raised `ValueError` on anything `strptime` could
 * not read and `TypeError` on a stamp that was not text; {@link ciSeconds}
 * catches both by falling back, so `null` here means the same thing. The
 * pattern is stricter than `strptime` in one way that no answer reaches:
 * `strptime` accepts a one-digit month where gh writes two.
 */
const epochSeconds = (stamp: unknown): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(asText(stamp))) return null
  const milliseconds = Date.parse(asText(stamp))
  // A well-formed stamp naming a day or a month that does not exist.
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000
}

/**
 * The median wall time of the given workflow runs, or 300 for none usable.
 *
 * A run's wall time is `updatedAt - createdAt`; `startedAt` can be null for a
 * run that was queued and never started, so it is not used. Failures are kept:
 * a failing run took as long as it took, and the loop is sizing a wait rather
 * than judging health. Runs missing either stamp, or with a non-positive
 * duration, are dropped.
 *
 * One row that cannot be read ends the whole measurement at the fallback, as
 * jq's error on one unparseable stamp did: a listing with a row like that is
 * not an answer about durations.
 *
 * The median is the upper of the two middles for an even count, which is what
 * jq's `sort | .[length / 2 | floor]` picked, so the two agree on every input.
 */
export const ciSeconds = (runs: unknown): number => {
  const durations: number[] = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const record = asRecord(run)
    // The row that raised `AttributeError` in the Python.
    if (record === null) return DEFAULT_CI_SECONDS
    const created = record.createdAt
    const updated = record.updatedAt
    // `is None`, so a stamp that is present and unreadable is the arm below
    // rather than a row quietly skipped.
    if (created === null || created === undefined) continue
    if (updated === null || updated === undefined) continue
    const from = epochSeconds(created)
    const to = epochSeconds(updated)
    if (from === null || to === null) return DEFAULT_CI_SECONDS
    if (to - from > 0) durations.push(to - from)
  }
  durations.sort((left, right) => left - right)
  // One lookup for both "no usable run" and the index: an empty list has no
  // middle, so the fallback is the same answer for both and there is no
  // second branch to leave untested.
  const median = durations[Math.floor(durations.length / 2)]
  return median === undefined ? DEFAULT_CI_SECONDS : median
}

export interface SkippedPull {
  readonly number: unknown
  readonly title: unknown
  readonly author: unknown
}

export interface StatusDocument {
  readonly repo: string
  readonly default_branch: string
  readonly ci_seconds: number
  readonly targets: readonly PullSummary[]
  readonly skipped_no_automerge: readonly SkippedPull[]
}

/** `createdAt` as the sort key, or `""`: the port of `pull.get("createdAt") or
 *  ""`, which is a string comparison in the Python and here. */
const createdAt = (pull: unknown): string => asText(field(pull, 'createdAt'))

/** Two stamps compared by code unit, which is `<` in both languages.
 *  `localeCompare` would order by the machine's locale instead. */
const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The whole `gh-shepherd-status.py` report.
 *
 * Drafts are out of scope entirely. Of what is left, a pull request a human
 * has already marked for auto-merge is a target; one without it is reported
 * under `skipped_no_automerge` and never enabled, because auto-merge is the
 * human's signal that the pull request is wanted.
 */
export const statusDocument = (
  pulls: unknown,
  repo: string,
  defaultBranch: string,
  ci: number,
): StatusDocument => {
  const rows: unknown[] = Array.isArray(pulls) ? pulls : []
  const open = rows.filter((pull) => !isTruthy(field(pull, 'isDraft')))
  const targets = open.filter((pull) => hasAutoMerge(pull))
  const skipped = open.filter((pull) => !hasAutoMerge(pull))
  // Both sorts are stable in Python and in JavaScript, so two pull requests
  // with the same key keep the order gh listed them in.
  targets.sort(
    (left, right) => rank(left) - rank(right) || byText(createdAt(left), createdAt(right)),
  )
  skipped.sort((left, right) => byText(createdAt(left), createdAt(right)))
  return {
    repo,
    default_branch: defaultBranch,
    ci_seconds: ci,
    targets: targets.map(summary),
    skipped_no_automerge: skipped.map((pull) => ({
      number: answered(field(pull, 'number')),
      title: answered(field(pull, 'title')),
      author: answered(field(field(pull, 'author'), 'login')),
    })),
  }
}

/**
 * gh's output on one line, so it can sit in a JSON detail.
 *
 * The whitespace is collapsed rather than only the newlines replaced, so a
 * message does not arrive with a trailing space where gh's own final newline
 * was. `text.split()` with no argument is what the Python calls
 * (`gh-shepherd-pr.py:200`), which splits on runs of any whitespace and drops
 * the empty ends.
 *
 * `\s` is NOT that set exactly, and saying so here rather than widening it:
 * Python also splits on `\x1c` to `\x1f` and `\x85`, and does not split on
 * `\ufeff`, where JavaScript is the other way round on both. Unlike
 * {@link tailLines}, whose missing separator was the bare carriage return a
 * progress bar writes on every redraw, nothing gh prints carries any of
 * these, and `\x1c` to `\x1e` cannot reach here on the watcher path because
 * `tailLines` has already broken the text on them. A hand-built exhaustive
 * whitespace class in a shipping function buys no reachable case, so the set
 * stays `\s` and the difference is recorded instead of claimed away.
 */
export const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ')

/**
 * Everything `str.splitlines()` breaks a line on, which is what the Python
 * counted (`gh-shepherd-pr.py:337`).
 *
 * Splitting on `\\n` alone is not the same bound: a CI job's `--log-failed`
 * output carries bare carriage returns wherever a tool redrew a progress bar,
 * and `SHEPHERD_LOG_LINES` would then keep 60 of those runs rather than 60
 * lines, so the tail an agent reads is far longer than the one that was asked
 * for.
 *
 * Built rather than written as a literal for the same reason as `ANSI_RE`
 * above: most of these are control characters, which a regular expression
 * literal is linted against carrying.
 */
const BREAKS = [10, 11, 12, 13, 28, 29, 30, 0x85, 0x2028, 0x2029]
  .map((code) => String.fromCharCode(code))
  .join('')
const PATTERN = `${String.fromCharCode(13, 10)}|[${BREAKS}]`
const LINE_BREAK = new RegExp(PATTERN)
/** The same, anchored: only a terminator at the very end is dropped. */
const LAST_BREAK = new RegExp(`(?:${PATTERN})$`)

/**
 * The last `count` lines, joined by newlines, as `tail -n` into `$(...)` gave.
 *
 * Command substitution stripped the trailing newline, so the result never ends
 * in one and an empty log is the empty string rather than a newline.
 */
export const tailLines = (text: string, count: number): string => {
  // `splitlines()`: a trailing line terminator does not make a final empty
  // line, and the empty string is no lines at all rather than one empty one.
  const lines = text === '' ? [] : text.replace(LAST_BREAK, '').split(LINE_BREAK)
  return lines.slice(Math.max(lines.length - count, 0)).join('\n')
}

/**
 * Why the target path cannot be worked in, or `null` when it can.
 *
 * The port of the two preflight refusals both scripts make
 * (`gh-shepherd-pr.py:1000` to `:1012`, `gh-shepherd-status.py:135` to
 * `:143`), both exit 2. The Python asks `os.path.isdir` and then `os.chdir`;
 * nothing here changes directory, because several commands share one process
 * and every git and gh call names its own directory, so the second question is
 * asked as the access `chdir` itself needs: the execute bit, which is what
 * makes a directory searchable.
 *
 * The refused-access line therefore carries node's account of the refusal
 * where the Python carried Python's (`[Errno 13] Permission denied: '<p>'`).
 * The sentence in front of it, which is what a caller reads and what the
 * tests assert, is the same.
 */
export const directoryRefusal = (target: string): string | null => {
  try {
    if (!statSync(target).isDirectory()) return `not a directory: ${target}`
  } catch {
    // A path that is not there at all, which `os.path.isdir` answers `False`
    // for rather than raising.
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
 * The run and the job a failing check's link names, or `null` for a link that
 * names neither.
 *
 * The port of `JOB_LINK_RE` (`gh-shepherd-pr.py:112`). Only an Actions job
 * reports under `.../actions/runs/<run>/job/<job>`, and only that link has a
 * log gh can be asked for; a StatusContext links to its own service, so the
 * caller walks past it rather than stopping at the first failing row.
 *
 * The defaults in the destructuring are what a link that matched nothing
 * leaves behind, which is the same answer as a pattern that cannot match
 * without at least one digit in each group.
 */
export const jobLink = (link: unknown): { readonly run: string; readonly job: string } | null => {
  const parts = /\/actions\/runs\/([0-9]+)\/job\/([0-9]+)/.exec(asText(link)) ?? []
  const [, run = '', job = ''] = parts
  return run === '' ? null : { run, job }
}
