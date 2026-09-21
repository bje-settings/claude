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
  /** Omitted, gh substitutes 30. Optional here and required on
   *  {@link MergedPullRequestQuery} because neither consumer of this query
   *  compares the row count against the window
   *  (`gh-shepherd-status.py:173` passes one and reads the rows), so there is
   *  no saturation reader to protect. Revisit if layer 2's port of that
   *  script grows one. */
  limit?: number
}

/**
 * The merged-pull-request window `gh-sync-repo.py:292` asks for.
 *
 * `base` is required because filtering it server-side is the whole point of
 * the query: a pull request that merged into some other branch is not proof
 * that a local branch landed on the default one, and `lib/prs.py` says so in
 * its header. `head` narrows it to one branch, which is the single-branch
 * fallback at `gh-sync-repo.py:493`.
 *
 * `limit` is required for the same reason `watchChecks.boundMs` is (round 5's
 * handoff fact 1, one field over): it is the number the caller compares the
 * row count against to find out whether the window saturated, and omitted it
 * is gh's own default of 30 with nothing saying so, which is a truncated list
 * read as a complete one. Both Python call sites pass one and both compare
 * against it: `gh-sync-repo.py:35` `PR_LIMIT = 200` with
 * `pr_bulk_saturated = len(rows) >= PR_LIMIT` at `:463` ("a saturated window
 * is a window, not an answer"), and `gh-sync-repo.py:41`
 * `PR_BRANCH_LIMIT = 100` with `if len(rows) >= PR_BRANCH_LIMIT: return
 * False, "crowded"` at `:503` ("concluding 'none at this commit' from a
 * truncated list is the mistake this guard exists to fix"). The saturation
 * flag is also what turns the per-branch fallback on at all (`:577`), so a
 * caller that lost it would lose the fallback with it. Nothing is being asked
 * for that a caller does not already have.
 */
export interface MergedPullRequestQuery {
  base: string
  head?: string
  limit: number
}

/** Filters `gh run list` applies server-side. */
export interface RunQuery {
  branch?: string
  status?: string
  /** Omitted, gh substitutes 30. Optional for the reason given on
   *  {@link PullRequestQuery.limit}: `gh-shepherd-status.py:195` passes a
   *  sample size and reads the rows rather than measuring the window. */
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
  updateBranch(pull: {
    pullRequest: number
    /** Required, and not defaulted: `gh pr update-branch` with no `--rebase`
     *  writes a MERGE COMMIT onto someone's head branch, so an omitted flag
     *  here is a write nobody asked for. The one ported call site passes it
     *  unconditionally (`gh-shepherd-pr.py:483`, and `:19` names the whole
     *  subcommand "rebase    gh pr update-branch --rebase"), so `false` is
     *  still available and nothing is being asked for that a caller does not
     *  already have. Same shape as `watchChecks.boundMs`: an optional field
     *  whose omission selects the behaviour no consumer wants. */
    rebase: boolean
  }): Promise<GhResults['updateBranch']>
  addComment(comment: { pullRequest: number } & CommentText): Promise<GhResults['addComment']>
  watchChecks(pull: {
    pullRequest: number
    /** gh's refresh interval, in SECONDS, which is the unit
     *  `gh pr checks -i, --interval int` takes. Named because it sits beside
     *  `boundMs`, and a caller that passed milliseconds here would get a poll
     *  interval measured in hours with nothing to say so. No ported call site
     *  sets it: `gh-shepherd-pr.py:645` to `655` passes `--watch
     *  --fail-fast` and takes gh's default of 10. */
    interval?: number
    /** The bound, in milliseconds. Required, because round 5's handoff fact 1
     *  is that #154 left this call unbounded and "a watch that cannot return
     *  is worse than no watch": optional, it is that same defect one line
     *  away, and `process.ts` only detaches a bounded child, so an unbounded
     *  watch cannot even be group-killed. The one ported call site has a
     *  bound (`gh-shepherd-pr.py:637`), so nothing is being asked for that a
     *  caller does not already have. */
    boundMs: number
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
  /** gh's exit status, or `null` when a signal ended it. `0` is its own case
   *  and a real one: gh succeeded and its answer could not be read, either
   *  because it was not JSON or because it was not the shape the endpoint
   *  promises. A caller reading `status !== 0` as "gh failed" would take a
   *  malformed answer for a good one, so branch on the error reaching you at
   *  all and use `status` to say which failure it was. */
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
   * `owner/name`, named on every call. Round 5's handoff fact 4: the ported
   * scripts name the repository at eight call sites (`gh-shepherd-pr.py:399`,
   * `:483`, `:533`, `:647`, `:726`, `:928` and `gh-shepherd-status.py:163`,
   * `:185`) because they run from wherever the agent started, not from the
   * checkout.
   *
   * It reaches gh as `--repo` everywhere except `gh repo view`, which has no
   * such flag and takes the repository as its positional argument instead
   * (`gh repo view [<repository>]`, verified against gh 2.98.0: the flag form
   * is refused with "unknown flag: --repo"). That is also why the two Python
   * `repo view` calls, `gh-shepherd-pr.py:959` and `gh-shepherd-status.py:104`,
   * are the only two of the ten that pass no `--repo`.
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
 * A child whose pipes failed is a third case: the account of the pipe leads,
 * because what reached this process through it is not the whole of what gh
 * wrote and answering with a short transcript as though it were complete is
 * the silence this file exists to refuse.
 *
 * A child that ran says why on stderr, and that wording travels with the
 * failure because a caller cannot tell an expired token from a repository
 * that does not exist without it. With stderr empty the status is all there
 * is, which at least separates a refusal from a crash, and a child that a
 * signal ended has no status at all to name.
 */
const accountOf = (result: RunResult): string => {
  if (result.startFailure !== null) return `cannot run gh: ${result.startFailure.message}`
  // A pipe that failed outranks whatever gh managed to say through it: the
  // words in hand may be half the words gh wrote, and a reader given only
  // those would be told a truncated answer confidently.
  const broke = result.streamErrors[0]
  if (broke !== undefined) return `gh's output could not be read: ${broke.code}, ${broke.message}`
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
 * The whole {@link RunResult} is carried in rather than just its stdout, and
 * it is what the {@link GhError} thrown here reports as its `cause`, exactly
 * as one thrown for a non-zero exit does. A caller catching one shape gets one
 * shape, so `error.cause.stderr` and `error.cause.elapsedMs` mean the same
 * thing whichever of the four throw sites it came from. What gh actually said
 * is the part a reader needs and it would be lost if the cause were the
 * `SyntaxError` or the decoded value instead, so those go into the message,
 * where they are read.
 */
const parse = (result: RunResult, what: string): unknown => {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new GhError(
      `gh answered ${what} with something that is not JSON: ${(error as Error).message}`,
      result.status,
      { cause: result },
    )
  }
}

const rows = (result: RunResult, what: string): unknown[] => {
  const value = parse(result, what)
  if (!Array.isArray(value)) {
    throw new GhError(
      `gh answered ${what} with something that is not a list: ${JSON.stringify(value)}`,
      result.status,
      { cause: result },
    )
  }
  return value
}

const record = (result: RunResult, what: string): Record<string, unknown> => {
  const value = parse(result, what)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GhError(
      `gh answered ${what} with something that is not an object: ${JSON.stringify(value)}`,
      result.status,
      { cause: result },
    )
  }
  return value as Record<string, unknown>
}

/** A `GhClient` that runs the real `gh`. */
export const createGhClient = (options: GhClientOptions = {}): GhClient => {
  const spawn = options.run ?? run
  const repository = filter('repo', options.repository)
  // `gh repo view` is the one command here with no `--repo`: its inherited
  // flags are `--help` alone and the repository is its positional argument.
  // Passing the flag form is refused outright ("unknown flag: --repo", gh
  // 2.98.0), so that endpoint spells the same fact the other way.
  const repositoryArgument = options.repository === undefined ? [] : [options.repository]

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
    // A pipe error is a failure even on status 0: gh exits happily on the
    // bytes it wrote, and the bytes that arrived here are the ones that got
    // through. Parsing a short answer would be reading a truncated list as a
    // complete one, which is the fact `rows` and `record` refuse to default.
    if (result.status !== 0 || result.streamErrors.length !== 0) {
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
        await succeeded(['repo', 'view', ...repositoryArgument, '--json', REPOSITORY_FIELDS]),
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
        // gh's own words when gh got to say any, and an account of what
        // happened to it when it did not.
        //
        // A watch a signal ended has no status to report and, unlike the
        // Python, nothing on stderr either: `run_bounded` calls
        // `communicate()` a second time after the kill specifically to drain
        // it (`gh-shepherd-pr.py:286` to `291`) and this transport does not.
        // So a watch killed by anything that is not this process's own bound
        // (the OOM killer, a SIGHUP when the terminal went away, a
        // supervisor) used to arrive as `{ status: null, timedOut: false,
        // problem: '' }`: no status the caller recognises, nothing saying it
        // did not time out either, and silence in the one field whose
        // contract is to be "the only place a watcher that could not reach
        // GitHub says so".
        //
        // The bound firing is exempt because it already says so in
        // `timedOut`, which is what the caller at `gh-shepherd-pr.py:644`
        // reads, and because `accountOf` would otherwise put this process's
        // own SIGKILL where gh's words belong.
        //
        // `result.stderr` WHOLE in the first arm, never `accountOf`'s trimmed
        // copy: the field's own contract two screens up is "what the watch
        // said on stderr, whole", with the tailing left to the caller. A watch
        // that died with something already on stderr keeps those words for the
        // same reason, which is the `result.stderr !== ''` clause.
        //
        // A pipe that failed disqualifies the whole transcript, so it falls
        // through to `accountOf` with everything else that is not gh speaking.
        problem:
          result.startFailure === null &&
          result.streamErrors.length === 0 &&
          (result.signal === null || result.timedOut || result.stderr !== '')
            ? result.stderr
            : accountOf(result),
      }
    },
  }
}
