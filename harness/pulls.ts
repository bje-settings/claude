// The pull requests a test answers `gh` with, and a `gh` that filters them the
// way GitHub does.
//
// The port of the pull-request half of `tests/gh/conftest.py` (`pr`,
// `write_prs`, `no_prs`, `many_prs`, `dep_pr`) and of the filtering the stub
// `gh` at `tests/gh/bin/gh` applies before it answers (`--state`, `--base`,
// `--head`, `--label`, `--limit`, and resolving `pr view <n>` against the same
// set). Round 4's note puts the row builders with the shepherd layer, which is
// the layer that needs all five.
//
// **Why this exists beside `createGhMock`.** The mock answers each endpoint
// with one registered reply, by design, and that is the right double for a
// command that asks a question once. Two things in these commands are not
// that:
//
//   - One endpoint is asked two different questions. `gh-sync-repo.py` asks
//     for a window of merged pull requests and then, if that window
//     saturated, about one branch; both are `gh pr list`. A double that
//     cannot tell them apart cannot reach the per-branch fallback at all.
//   - An endpoint is asked the same question repeatedly and the answer
//     changes. `settle` reads the pull request until GitHub decides, and
//     `recreate` polls the head SHA until Dependabot moves it. The Python
//     arranges that by mutating the canned file from a background thread;
//     here it is a registered SEQUENCE of replies, which is the same fact
//     without a race.
//
// Everything here stays a filter over registered data. Nothing in it knows
// what a command decides, which is ADR 001's "the mock holds no conditional
// logic": reproducing the SERVER's filter is fidelity, and an endpoint nobody
// registered still throws and names itself.
//
// This is test code and does not ship.

import {
  createGhMock,
  type GhClient,
  type GhEndpoint,
  type GhReplies,
  type GhResults,
  ghFails,
  type MergedPullRequestQuery,
  type PullRequestQuery,
} from './gh.ts'

/** One row of a canned pull-request set: whatever fields the test gives it,
 *  which is what `gh --json` answers with. `unknown` rather than a declared
 *  pull-request type, because the commands under test have to survive an
 *  answer that is missing a field, and a type that promised the field would
 *  make those examples unwritable. */
export interface PullRequestRow {
  readonly [field: string]: unknown
}

/** One merged pull request, for composing a canned set. The port of
 *  `conftest.py`'s `pr`, used by the sync layer's merged-window queries. */
export const pr = (
  headRefName: string,
  headRefOid: string,
  baseRefName = 'main',
  isCrossRepository = false,
): PullRequestRow => ({
  headRefName,
  headRefOid,
  baseRefName,
  isCrossRepository,
  state: 'MERGED',
})

/** The canned set, from the rows given. The port of `write_prs`, which wrote
 *  the same list to the file the stub `gh` read; here the set is passed to
 *  {@link createGhServer} instead of to a file. */
export const writePrs = (...rows: readonly PullRequestRow[]): PullRequestRow[] => [...rows]

/** No pull requests at all, which is a different answer from "not
 *  registered": the port of `no_prs`. */
export const noPrs = (): PullRequestRow[] => []

/**
 * `count` filler pull requests, followed by any given explicitly.
 *
 * The port of `many_prs`. When `count` is at least the query's limit, anything
 * appended is past the window: invisible to the bulk query and reachable only
 * by asking about that branch directly, which is how a saturated window is
 * told from a complete answer.
 */
export const manyPrs = (count: number, ...extra: readonly PullRequestRow[]): PullRequestRow[] => [
  ...Array.from({ length: count }, (_unused, index) => pr(`old-${index}`, String(index))),
  ...extra,
]

/** A CheckRun row, the shape GitHub Actions and most apps report under. */
const checkRun = (
  number: number,
  name: string,
  status: string,
  conclusion: string | null,
): PullRequestRow => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/widgets/actions/runs/1${number}/job/2${number}`,
})

/** A StatusContext row: the older commit-status API, which names itself with
 *  `context`, links with `targetUrl` and carries no `conclusion` key at all. */
const statusContext = (state: string): PullRequestRow => ({
  __typename: 'StatusContext',
  context: 'ci/legacy',
  state,
  targetUrl: 'https://ci.example/1',
})

/** One entry per arm the check-state fold can take. Values that share an arm
 *  share a shape; what needs its own shape is each arm. */
const ROLLUP_SHAPES: Record<string, readonly (readonly [string, string, string | null])[]> = {
  passed: [
    ['test', 'COMPLETED', 'SUCCESS'],
    ['lint', 'COMPLETED', 'SKIPPED'],
  ],
  failed: [
    ['test', 'COMPLETED', 'SUCCESS'],
    ['build', 'COMPLETED', 'FAILURE'],
  ],
  pending: [
    ['test', 'COMPLETED', 'SUCCESS'],
    ['build', 'IN_PROGRESS', null],
  ],
  mixed: [
    ['test', 'IN_PROGRESS', null],
    ['build', 'COMPLETED', 'FAILURE'],
  ],
  neutral: [
    ['lint', 'COMPLETED', 'NEUTRAL'],
    ['docs', 'COMPLETED', 'SKIPPED'],
  ],
  cancelled: [
    ['test', 'COMPLETED', 'SUCCESS'],
    ['build', 'COMPLETED', 'CANCELLED'],
  ],
  'null-conclusion': [
    ['test', 'COMPLETED', 'SUCCESS'],
    ['build', 'COMPLETED', null],
  ],
}

/** The older commit-status shape, which the fold reads by `state` rather than
 *  by `status` and `conclusion`. */
const STATUS_SHAPES: Record<string, string> = {
  'status-failed': 'FAILURE',
  'status-pending': 'PENDING',
  'status-passed': 'SUCCESS',
}

/** A rollup whose first failing row is a StatusContext and whose second is an
 *  Actions job. Nothing links a StatusContext to a run, so a caller after the
 *  failed steps' log has to keep looking rather than stop at the first
 *  failure. */
const STATUS_THEN_JOB = 'status-then-job-failed'

const rollupFor = (number: number, checks: string): PullRequestRow[] => {
  if (checks === STATUS_THEN_JOB) {
    return [statusContext('FAILURE'), checkRun(number, 'build', 'COMPLETED', 'FAILURE')]
  }
  const status = STATUS_SHAPES[checks]
  if (status !== undefined) return [statusContext(status)]
  return (ROLLUP_SHAPES[checks] ?? []).map(([name, state, conclusion]) =>
    checkRun(number, name, state, conclusion),
  )
}

/** The keys `dep_pr` takes, with the same names and the same defaults. */
export interface DepPrKeys {
  /** `OPEN` (the default), `MERGED` or `CLOSED`. */
  readonly state?: string
  /** `mergeStateStatus`: `CLEAN` (the default), `BEHIND`, `DIRTY`, `BLOCKED`,
   *  or anything else GitHub reports. */
  readonly merge?: string
  /** The rollup shape: `passed` (the default), `failed`, `pending`, `none`,
   *  `mixed`, `neutral`, `cancelled`, `null-conclusion`, `status-failed`,
   *  `status-pending`, `status-passed`, or `status-then-job-failed`. */
  readonly checks?: string
  /** Auto-merge enabled. Default true. */
  readonly auto?: boolean
  /** Authored by `app/dependabot`. Default true; false gives a human. */
  readonly bot?: boolean
  readonly draft?: boolean
  /** `reviewDecision`: `""` (no review required, the default),
   *  `REVIEW_REQUIRED`, `CHANGES_REQUESTED` or `APPROVED`. */
  readonly review?: string
  /** The merge-risk band to label: `low`, `medium` or `high`. */
  readonly risk?: string
  /** `createdAt`. Defaults to `2026-01-<number>T00:00:00Z`. */
  readonly created?: string
  /** `headRefOid`. Defaults to `sha<number>`. */
  readonly head?: string
}

/**
 * One `dependencies` pull request as the shepherd scripts see it, with every
 * field `PR_FIELDS` asks gh for.
 *
 * The port of `conftest.py`'s `dep_pr`, keys and defaults unchanged, so a
 * captured Python run and the TypeScript example beside it are built from the
 * same row.
 */
export const depPr = (number: number, keys: DepPrKeys = {}): PullRequestRow => {
  const merge = keys.merge ?? 'CLEAN'
  const state = keys.state ?? 'OPEN'
  // `||` and not `??`: the Python reads these two with `or`, so an empty
  // string selects the default exactly as an omitted key does.
  const created = keys.created || `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`
  const head = keys.head || `sha${number}`
  const risk = keys.risk ?? ''
  const labels: PullRequestRow[] = [{ name: 'dependencies' }]
  if (risk !== '') labels.push({ name: `merge-risk:${risk}` })
  return {
    number,
    title: `build(deps): bump dep-${number}`,
    state,
    isDraft: keys.draft ?? false,
    author:
      (keys.bot ?? true)
        ? { login: 'app/dependabot', is_bot: true }
        : { login: 'someone', is_bot: false },
    labels,
    autoMergeRequest: (keys.auto ?? true) ? { mergeMethod: 'MERGE' } : null,
    mergeStateStatus: merge,
    reviewDecision: keys.review ?? '',
    mergeable: merge === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
    headRefOid: head,
    headRefName: `dependabot/npm/dep-${number}`,
    baseRefName: 'main',
    createdAt: created,
    mergeCommit: state === 'MERGED' ? { oid: `merged${number}` } : null,
    statusCheckRollup: rollupFor(number, keys.checks ?? 'passed'),
  }
}

/** A sequence of replies for one endpoint, in the order the calls take them.
 *  The last entry repeats, so a poll that runs one read longer than the test
 *  expected reads the settled answer rather than falling off the end. */
export type GhSequences = { [K in GhEndpoint]?: readonly (GhResults[K] | Error)[] }

export interface GhServerOptions {
  /**
   * The canned set the three pull-request endpoints are answered from.
   *
   * Given, `listPullRequests`, `listMergedPullRequests` and `viewPullRequest`
   * are all answered from it, filtered the way gh filters; left out, all three
   * are unregistered endpoints and throw like any other. That is the one
   * property of `createGhMock` this gives up on purpose, and it is why a test
   * that wants "this must not be called" passes no `prs` (or registers a
   * failure for the endpoint).
   */
  readonly prs?: readonly PullRequestRow[]
  /** One reply per endpoint, exactly as `createGhMock` takes them. A reply
   *  registered here outranks the pull-request set, which is how a test says
   *  "this endpoint failed" for a set it still wants served elsewhere. */
  readonly replies?: GhReplies
  /** A sequence per endpoint, which outranks both. */
  readonly sequences?: GhSequences
  /** Every call fails with this error: the stub's `GH_FIXTURE_FAIL`, which is
   *  a gh that cannot reach GitHub at all rather than one endpoint refusing. */
  readonly fail?: Error
  /** Only a query naming a head fails: the stub's `GH_FIXTURE_FAIL_HEAD`, so a
   *  bulk window can be answered while the per-branch question is not. */
  readonly failHead?: Error
}

/** The names of the endpoints, one filter each, as gh applies them. */
const matchesQuery = (row: PullRequestRow, query: PullRequestQuery): boolean => {
  // `r.get("state") or "MERGED"` (`tests/gh/bin/gh:212`): truthiness, not
  // `??`, so a row whose state is the empty string is a merged row to this
  // filter exactly as it is to the stub it ports.
  const state =
    row.state === undefined || row.state === null || row.state === '' ? 'MERGED' : row.state
  if (query.state !== undefined && state !== query.state.toUpperCase()) {
    return false
  }
  if (query.base !== undefined && row.baseRefName !== query.base) return false
  if (query.head !== undefined && row.headRefName !== query.head) return false
  if (query.label !== undefined) {
    const labels = Array.isArray(row.labels) ? row.labels : []
    const named = labels.map((label) => (label as PullRequestRow).name)
    if (!named.includes(query.label)) return false
  }
  return true
}

const filtered = (
  rows: readonly PullRequestRow[],
  query: PullRequestQuery,
): readonly PullRequestRow[] => rows.filter((row) => matchesQuery(row, query)).slice(0, query.limit)

/**
 * A `GhClient` that answers from registered data.
 *
 * Precedence, highest first: {@link GhServerOptions.fail}, a sequence, a
 * single reply, the pull-request set, and then the unregistered endpoint's
 * throw. Each level is a different fact a test is stating, and a lower one
 * never silently overrides a higher one.
 */
export function createGhServer(options: GhServerOptions = {}): GhClient {
  const base = createGhMock(options.replies ?? {})
  const sequences = options.sequences ?? {}
  // One cursor per endpoint. The double holds this much state because a
  // sequence is what a poll needs; it still decides nothing, since the answer
  // at each position was written by the test.
  const taken = new Map<GhEndpoint, number>()

  /** The next entry of `endpoint`'s sequence, or `undefined` when it has
   *  none. The last entry repeats. */
  const fromSequence = <K extends GhEndpoint>(endpoint: K): GhResults[K] | undefined => {
    const replies = sequences[endpoint]
    if (replies === undefined) return undefined
    if (replies.length === 0) {
      throw new Error(`gh server: the sequence registered for ${endpoint} is empty`)
    }
    const position = Math.min(taken.get(endpoint) ?? 0, replies.length - 1)
    taken.set(endpoint, position + 1)
    const reply = replies[position] as GhResults[K] | Error
    if (reply instanceof Error) throw reply
    return reply
  }

  /** What every endpoint does before it answers: the whole-client failure,
   *  then its own sequence. */
  const registered = <K extends GhEndpoint>(endpoint: K): GhResults[K] | undefined => {
    if (options.fail !== undefined) throw options.fail
    return fromSequence(endpoint)
  }

  /** The rows, or the throw that says this server was given none. */
  const rowsFor = (endpoint: GhEndpoint): readonly PullRequestRow[] => {
    if (options.prs === undefined) {
      throw new Error(`gh mock: no reply registered for ${endpoint}`)
    }
    return options.prs
  }

  /** `GH_FIXTURE_FAIL_HEAD`: a query that names a branch, and only that. */
  const headMayFail = (head: string | undefined): void => {
    if (options.failHead !== undefined && head !== undefined) throw options.failHead
  }

  /** A reply the test registered for this endpoint, if it did. `createGhMock`
   *  throws for an endpoint with no reply, which is the answer this server
   *  wants only once the pull-request set has had its turn. */
  const hasReply = (endpoint: GhEndpoint): boolean => options.replies?.[endpoint] !== undefined

  return {
    ...base,

    listPullRequests: async (query = {}) => {
      const sequenced = registered('listPullRequests')
      if (sequenced !== undefined) return sequenced
      if (hasReply('listPullRequests')) return base.listPullRequests(query)
      headMayFail(query.head)
      return [...filtered(rowsFor('listPullRequests'), query)]
    },

    listMergedPullRequests: async (query: MergedPullRequestQuery) => {
      const sequenced = registered('listMergedPullRequests')
      if (sequenced !== undefined) return sequenced
      if (hasReply('listMergedPullRequests')) return base.listMergedPullRequests(query)
      headMayFail(query.head)
      // The real client sends `--state merged` on this endpoint, so the server
      // applies that filter as well as the two the caller chose.
      return [...filtered(rowsFor('listMergedPullRequests'), { ...query, state: 'merged' })]
    },

    viewPullRequest: async (pull) => {
      const sequenced = registered('viewPullRequest')
      if (sequenced !== undefined) return sequenced
      if (hasReply('viewPullRequest')) return base.viewPullRequest(pull)
      const found = rowsFor('viewPullRequest').find((row) => row.number === pull.pullRequest)
      if (found === undefined) {
        // gh's own words for a number that resolves to nothing, which is what
        // a command's "could not read pull request" arm quotes.
        throw ghFails(
          `GraphQL: Could not resolve to a PullRequest with the number of ${pull.pullRequest}.`,
        )
      }
      return { ...found }
    },

    viewRepository: async () => registered('viewRepository') ?? base.viewRepository(),
    listRuns: async (query) => registered('listRuns') ?? base.listRuns(query),
    readFailedRunLog: async (run) => registered('readFailedRunLog') ?? base.readFailedRunLog(run),
    updateBranch: async (pull) => registered('updateBranch') ?? base.updateBranch(pull),
    addComment: async (comment) => registered('addComment') ?? base.addComment(comment),
    watchChecks: async (pull) => registered('watchChecks') ?? base.watchChecks(pull),
  }
}
