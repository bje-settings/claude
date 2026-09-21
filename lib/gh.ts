// The `gh` client: the interface the commands are written against, and the
// real implementation of it.
//
// The interface and its query and result types were declared in
// `harness/gh.ts` at #124 and moved here at #125, where the harness imports
// them back and keeps `createGhMock`, which is test code and does not ship.
// The endpoints are named after the operation the caller wants, not after
// gh's argv, so the interface survives gh changing a flag. Inputs and outputs
// stay plain JSON values: a domain type invented here would be invented from
// nothing, and the commands that consume these answers (#127 layers 2 and 3)
// shape them with their own.
//
// Failure is a thrown `Error`, not a result envelope, for the three reasons
// `harness/gh.ts` already committed to: an unregistered endpoint in the mock
// has to throw anyway, so this keeps one shape for everything that goes
// wrong; an envelope would make every endpoint's return a union that every
// caller must narrow, including the callers that do not model failure at all;
// and the real client runs `gh` as a child process, where a non-zero exit
// with stderr is exactly an exception. A command turns what it catches into
// an `envelope.ts` outcome, which is where the exit code is decided.
//
// **The transport is `process.ts` now.** #154 carried a private `execFile`
// adapter here and said in as many words that it was not the process runner.
// #127 is the runner's first consumer and this is where the adapter goes: one
// place that starts children, one account of what a child did, and no 64 MiB
// `maxBuffer` to get wrong, because `spawn` reads a pipe until it ends rather
// than filling a fixed buffer.
//
// This file ships. It imports nothing outside the root lib, and stays inside
// the erasable subset (ADR 001).

import { type Runner, type RunResult, run } from './process.ts'

/** Filters `gh pr list` applies server-side, as the plugins pass them today. */
export interface PullRequestQuery {
  state?: string
  base?: string
  head?: string
  /** `gh-shepherd-status.py:172` asks for the `dependencies` label. */
  label?: string
  limit?: number
}

/**
 * The merged-pull-request window `gh-sync-repo.py:292` asks for.
 *
 * `base` is required because filtering it server-side is the whole point of
 * the query: a pull request that merged into some other branch is not proof
 * that a local branch landed on the default one, and `lib/prs.py` says so in
 * its header. `head` narrows it to one branch, which is the single-branch
 * fallback at `gh-sync-repo.py:493`, and `limit` is the window the caller
 * then compares the row count against to find out whether it saturated.
 */
export interface MergedPullRequestQuery {
  base: string
  head?: string
  limit?: number
}

/** Filters `gh run list` applies server-side. */
export interface RunQuery {
  branch?: string
  status?: string
  limit?: number
}

/**
 * What a bounded `gh pr checks --watch` did.
 *
 * The watch reports on the checks **through its exit status**, so unlike
 * every other endpoint here a non-zero status is an answer and not a failure:
 * 0 all passed, 1 a check failed, 8 still pending
 * (`gh-shepherd-pr.py:177`'s `WATCHER_CODES`). 1 is also gh's own generic
 * non-zero, so "one check failed" and "gh could not reach GitHub" arrive as
 * the same number and the caller needs {@link problem} to tell them apart.
 * That is round 5's handoff fact 2, and it is why this endpoint answers with
 * a record rather than with a list: an endpoint that threw on 1 would report
 * a red rollup as a broken token, and one that swallowed 1 would report a
 * broken token as a red rollup.
 *
 * There is deliberately no check list here. The one consumer,
 * `gh-shepherd-pr.py:668` to `690`, re-reads the pull request afterwards "in
 * every case" and decides "from the rollup rather than the watcher's exit
 * code", which is {@link GhClient.viewPullRequest}. A second `gh pr checks
 * --json` call inside this endpoint would be a round trip that consumer never
 * reads, and it fails outright on a pull request with no checks at all.
 */
export interface WatchResult {
  /** gh's own exit status, or `null` when a signal ended the watch, which is
   *  what the bound firing looks like. */
  readonly status: number | null
  /** Whether the bound fired. `run_bounded` publishes this as status 124, the
   *  way coreutils `timeout` does (`gh-shepherd-pr.py:250`); the translation
   *  belongs to the caller that publishes a status. */
  readonly timedOut: boolean
  /** How long the watch actually took. "A watcher that returned early did not
   *  wait the bound, and saying it did misleads a caller deciding whether to
   *  wait again" (`gh-shepherd-pr.py:266`). */
  readonly waitedMs: number
  /** What the watch said on stderr, whole: "the only place a watcher that
   *  could not reach GitHub says so, and without it a 502 is
   *  indistinguishable from checks that are still running"
   *  (`gh-shepherd-pr.py:255`). Tailing and one-lining it is the caller's
   *  formatting, not the transport's. */
  readonly problem: string
}

/** What each endpoint answers with. One entry per operation, so the reply map
 *  and the client cannot drift apart. */
export interface GhResults {
  /** Pull requests matching the query, projected as JSON rows. */
  listPullRequests: unknown[]
  /** Merged pull requests, as `lib/prs.py` reads them. */
  listMergedPullRequests: unknown[]
  /** One pull request's own fields. */
  viewPullRequest: Record<string, unknown>
  /** The repository's own fields: default branch and `nameWithOwner`. */
  viewRepository: Record<string, unknown>
  /** Workflow runs matching the query, as JSON rows. */
  listRuns: unknown[]
  /** The log of a run's failed steps, as text. */
  readFailedRunLog: string
  /** Whatever the update printed. The verdict is that it did not throw. */
  updateBranch: string
  /** Whatever posting the comment printed. */
  addComment: string
  /** What the bounded watch did. */
  watchChecks: WatchResult
}

export type GhEndpoint = keyof GhResults

/**
 * A comment's text, from a string or from a file, exactly one of the two.
 *
 * The `never` arms are what make it exactly one: a value carrying both is
 * refused at the call site rather than in a runtime check this file would
 * then need a test for, and `gh` itself refuses `--body` with `--body-file`
 * anyway. Round 5's handoff fact 5. Both arms have a consumer:
 * `gh-shepherd-pr.py:533` posts `@dependabot recreate` as a string, and
 * `gh-shepherd-pr.py:928` posts the skip comment with `--body-file`, because
 * the reason is a file the agent wrote.
 */
export type CommentText =
  | { readonly body: string; readonly bodyFile?: never }
  | { readonly bodyFile: string; readonly body?: never }

/** The operations the plugins ask `gh` for. Implemented by `createGhClient`
 *  below and by `createGhMock` in the harness; a command takes one as an
 *  argument and never constructs it, which is what makes it swappable at
 *  all. */
export interface GhClient {
  listPullRequests(query?: PullRequestQuery): Promise<GhResults['listPullRequests']>
  listMergedPullRequests(
    query: MergedPullRequestQuery,
  ): Promise<GhResults['listMergedPullRequests']>
  viewPullRequest(pull: { pullRequest: number }): Promise<GhResults['viewPullRequest']>
  viewRepository(): Promise<GhResults['viewRepository']>
  listRuns(query?: RunQuery): Promise<GhResults['listRuns']>
  readFailedRunLog(run: {
    run: string | number
    job?: string | number
  }): Promise<GhResults['readFailedRunLog']>
  updateBranch(pull: { pullRequest: number; rebase?: boolean }): Promise<GhResults['updateBranch']>
  addComment(comment: { pullRequest: number } & CommentText): Promise<GhResults['addComment']>
  watchChecks(pull: {
    pullRequest: number
    interval?: number
    boundMs?: number
    failFast?: boolean
  }): Promise<GhResults['watchChecks']>
}

/**
 * What every endpoint here throws.
 *
 * Round 5's handoff fact 3: #154 threw a plain `Error` carrying gh's words
 * and neither its exit status nor a cause, so a caller could only branch on
 * prose. `status` is gh's own exit status (or the shell's 127 and 126 when gh
 * could not be started at all, which is `lib/install.py`'s convention that
 * `process.ts` keeps), and `cause` is the whole {@link RunResult}, so a
 * caller that needs stderr, the signal or the elapsed time has them without
 * this class growing a field per question.
 *
 * Every member is public. A class exported from `lib/` is seen by `tsc` under
 * two identities, its real path and `plugins/<p>/src/lib/gh.ts` through the
 * committed symlink, and a `private` or `protected` member would make it
 * nominal per declaration, so the two would stop being assignable to each
 * other (round 5's rule, reproduced on #156). `cause` is `Error`'s own
 * public property and is set through `super`.
 */
export class GhError extends Error {
  /** gh's exit status, or `null` when a signal ended it. */
  readonly status: number | null

  constructor(message: string, status: number | null, options: { cause: unknown }) {
    super(message, options)
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this a caught failure reports as a plain
    // `Error`.
    this.name = 'GhError'
    this.status = status
  }
}

export interface GhClientOptions {
  /**
   * Where `gh` runs. `gh` resolves the repository from the working directory
   * when nothing names one, which is what `gh-sync-repo.py` relies on after
   * it has chdir'd into the checkout.
   */
  readonly cwd?: string
  /**
   * `owner/name`, added to every call as `--repo`. Round 5's handoff fact 4:
   * the ported scripts name the repository at eight call sites
   * (`gh-shepherd-pr.py` and `gh-shepherd-status.py` pass `--repo` on every
   * call they make) because they run from wherever the agent started, not
   * from the checkout.
   */
  readonly repository?: string
  /** The spawn seam. Defaults to the root lib's own process runner.
   *
   *  It is a parameter rather than a hardcoded import so that this file's
   *  suite drives every endpoint, and every arm of the failure each one
   *  reports, in-process with nothing spawned and no `gh` on the machine. The
   *  runner itself is the thing tested against real children
   *  (`process.test.ts`); duplicating that here would only prove node twice. */
  readonly run?: Runner
}

/**
 * The `--json` field lists, taken from the scripts that ask for them today:
 * `plugins/gh/scripts/lib/shepherd.py`'s `PR_FIELDS` (`gh-shepherd-pr.py`'s
 * `read_pr` and `gh-shepherd-status.py`'s pull-request query ask for exactly
 * this list), `lib/prs.py`'s `FIELDS` for the merged window, and
 * `gh-shepherd-status.py`'s repository and run queries. The run list adds the
 * run's identity and outcome to the two timestamps that script reads, because
 * a run row with no id cannot be followed to `readFailedRunLog`, which is the
 * next endpoint in this same interface.
 */
const PULL_REQUEST_FIELDS =
  'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
  'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision'
const MERGED_PULL_REQUEST_FIELDS = 'headRefName,headRefOid,isCrossRepository'
const REPOSITORY_FIELDS = 'nameWithOwner,defaultBranchRef'
const RUN_FIELDS = 'databaseId,status,conclusion,createdAt,updatedAt'

/** An optional filter, as the two argv words gh wants or as nothing at all. */
const filter = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}`, String(value)]

/** A boolean flag, as the one argv word gh wants or as nothing at all. */
const flag = (name: string, value: boolean | undefined): string[] =>
  value === true ? [`--${name}`] : []

/**
 * What to say about a failure, chosen between the three accounts of it.
 *
 * A child that never started is node's failure to report rather than gh's: gh
 * is not on PATH, or is there and unrunnable. Whatever was on stderr is not
 * an account of that, so node's message leads. "cannot run gh" is the wording
 * `gh-sync-repo.py:280`, `gh-shepherd-pr.py:415` and
 * `gh-shepherd-status.py:85` all print, kept so a reader who has seen the
 * Python's line sees the same one.
 *
 * A child that ran says why on stderr, and that wording travels with the
 * failure because a caller cannot tell an expired token from a repository
 * that does not exist without it. With stderr empty the status is all there
 * is, which at least separates a refusal from a crash, and a child that a
 * signal ended has no status at all to name.
 */
const accountOf = (result: RunResult): string => {
  if (result.startFailure !== null) return `cannot run gh: ${result.startFailure.message}`
  const said = result.stderr.trim()
  if (said !== '') return said
  if (result.status === null) return `gh was killed by ${result.signal}`
  return `gh exited ${result.status}`
}

/**
 * A process seam is where untrusted input arrives, so every reply is parsed
 * and asserted to be the shape the endpoint promises, never defaulted: an
 * answer that is not what it claims is a failure here rather than an empty
 * list a caller reads as "nothing matched".
 *
 * The whole {@link RunResult} is carried in rather than just its stdout, so
 * that the {@link GhError} thrown here reports the same `status` and `cause`
 * as one thrown for a non-zero exit. A caller catching one shape gets one
 * shape.
 */
const parse = (result: RunResult, what: string): unknown => {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new GhError(`gh answered ${what} with something that is not JSON`, result.status, {
      cause: error,
    })
  }
}

const rows = (result: RunResult, what: string): unknown[] => {
  const value = parse(result, what)
  if (!Array.isArray(value)) {
    throw new GhError(`gh answered ${what} with something that is not a list`, result.status, {
      cause: value,
    })
  }
  return value
}

const record = (result: RunResult, what: string): Record<string, unknown> => {
  const value = parse(result, what)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GhError(`gh answered ${what} with something that is not an object`, result.status, {
      cause: value,
    })
  }
  return value as Record<string, unknown>
}

/** A `GhClient` that runs the real `gh`. */
export const createGhClient = (options: GhClientOptions = {}): GhClient => {
  const spawn = options.run ?? run
  const repository = filter('repo', options.repository)

  /** Run gh, and answer with everything the child did. Nothing here decides
   *  whether that is a failure: the watch reports through its status and the
   *  others do not, so each endpoint says so for itself. */
  const invoke = (args: readonly string[], boundMs?: number): Promise<RunResult> =>
    spawn('gh', args, { cwd: options.cwd, timeoutMs: boundMs })

  /** What gh did, once it has been established that gh succeeded. A non-zero
   *  exit, or a gh that never started, is a {@link GhError} carrying the
   *  status and gh's own words. */
  const succeeded = async (args: readonly string[]): Promise<RunResult> => {
    const result = await invoke(args)
    if (result.status !== 0) {
      throw new GhError(`gh ${args.join(' ')} failed: ${accountOf(result)}`, result.status, {
        cause: result,
      })
    }
    return result
  }

  /** gh's stdout alone, for the endpoints whose answer is text. */
  const text = async (args: readonly string[]): Promise<string> => (await succeeded(args)).stdout

  return {
    listPullRequests: async (query = {}) => {
      const args = [
        'pr',
        'list',
        ...repository,
        ...filter('state', query.state),
        ...filter('base', query.base),
        ...filter('head', query.head),
        ...filter('label', query.label),
        ...filter('limit', query.limit),
        '--json',
        PULL_REQUEST_FIELDS,
      ]
      return rows(await succeeded(args), 'gh pr list')
    },

    listMergedPullRequests: async (query) =>
      rows(
        await succeeded([
          'pr',
          'list',
          ...repository,
          '--state',
          'merged',
          '--base',
          query.base,
          ...filter('head', query.head),
          ...filter('limit', query.limit),
          '--json',
          MERGED_PULL_REQUEST_FIELDS,
        ]),
        'gh pr list',
      ),

    viewPullRequest: async (pull) =>
      record(
        await succeeded([
          'pr',
          'view',
          String(pull.pullRequest),
          ...repository,
          '--json',
          PULL_REQUEST_FIELDS,
        ]),
        'gh pr view',
      ),

    viewRepository: async () =>
      record(
        await succeeded(['repo', 'view', ...repository, '--json', REPOSITORY_FIELDS]),
        'gh repo view',
      ),

    listRuns: async (query = {}) =>
      rows(
        await succeeded([
          'run',
          'list',
          ...repository,
          ...filter('branch', query.branch),
          ...filter('status', query.status),
          ...filter('limit', query.limit),
          '--json',
          RUN_FIELDS,
        ]),
        'gh run list',
      ),

    // Text, not JSON: `--log-failed` is the log itself, and the caller reads
    // it as the lines a human would. `--job` narrows it to one job of the
    // run, which is what `gh-shepherd-pr.py:726` asks for: it has followed a
    // check's link to a run and a job, and the whole run's failed steps would
    // be a different question.
    readFailedRunLog: (run) =>
      text([
        'run',
        'view',
        String(run.run),
        ...repository,
        ...filter('job', run.job),
        '--log-failed',
      ]),

    updateBranch: (pull) =>
      text([
        'pr',
        'update-branch',
        String(pull.pullRequest),
        ...repository,
        ...flag('rebase', pull.rebase),
      ]),

    addComment: (comment) =>
      text([
        'pr',
        'comment',
        String(comment.pullRequest),
        ...repository,
        ...filter('body', comment.body),
        ...filter('body-file', comment.bodyFile),
      ]),

    // The blocking call, and the only one that takes a bound. Round 5's
    // handoff fact 1: #154 left `gh pr checks --watch` unbounded, while the
    // Python wraps the same call in `run_bounded` for the reasons it records
    // at `gh-shepherd-pr.py:633` to `637`. A watch that cannot return is
    // worse than no watch.
    //
    // gh refuses `--watch` together with `--json` and refuses `--interval`
    // without `--watch`, both verified against gh 2.98.0, which is why there
    // is no `--json` here: this endpoint is the wait, and the caller reads
    // the rollup afterwards with `viewPullRequest`, exactly as
    // `gh-shepherd-pr.py:668` does.
    //
    // Nothing throws. Every outcome, including gh failing to start, is
    // reported through {@link WatchResult}, because the status is an answer
    // here and a caller that must distinguish 1 from 8 from 127 cannot be
    // handed some of them as values and the rest as exceptions.
    watchChecks: async (pull) => {
      const result = await invoke(
        [
          'pr',
          'checks',
          String(pull.pullRequest),
          ...repository,
          '--watch',
          ...flag('fail-fast', pull.failFast),
          ...filter('interval', pull.interval),
        ],
        pull.boundMs,
      )
      return {
        status: result.status,
        timedOut: result.timedOut,
        waitedMs: result.elapsedMs,
        problem: result.startFailure === null ? result.stderr : accountOf(result),
      }
    },
  }
}
