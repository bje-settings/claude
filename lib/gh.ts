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

//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree; the
// file and line references below are to what they held at `cd0d515`, kept
// because each says where a rule came from. Nothing here changed with the
// deletion.
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

/** The three states GraphQL reports for an issue or a pull request. */
export type IssueState = 'OPEN' | 'CLOSED' | 'MERGED'

/**
 * One open milestone, with the two counts a sweep reports beside it.
 *
 * A named shape rather than the plain JSON row the older endpoints answer
 * with, for the reason `issueStates` is also shaped: the query is written
 * here, so the fields are this file's promise rather than gh's, and a caller
 * that had to re-derive `openIssues` from an untyped record would be
 * re-deriving something this file already knows.
 */
export interface MilestoneSummary {
  readonly number: number
  readonly title: string
  /** Open issues on the milestone. Pull requests are not counted: the
   *  connection is asked for `issues`, which on GitHub excludes them. */
  readonly openIssues: number
  readonly closedIssues: number
}

/** One issue or pull request a relationship field points at: the number and
 *  the state, which is all a blocker graph needs. */
export interface IssueRef {
  readonly number: number
  readonly state: IssueState
}

/** One open issue, as a sweep reads it.
 *
 *  `blockedBy` and `blocking` are GitHub's issue-dependency relationships and
 *  exist in GraphQL alone, which is why these endpoints are `gh api graphql`
 *  and not `gh issue list`. */
export interface IssueSummary {
  readonly number: number
  readonly title: string
  /** The milestone, or null for an issue on none. */
  readonly milestone: { readonly number: number; readonly title: string } | null
  readonly labels: readonly string[]
  readonly blockedBy: readonly IssueRef[]
  readonly blocking: readonly IssueRef[]
  /** The pull requests that would close this issue, including closed ones, so
   *  a sweep can see that work has already been opened for it. */
  readonly pullRequests: readonly IssueRef[]
}

/** One open pull request, with the two refs a sweep needs to see a stack. */
export interface PullRequestSummary {
  readonly number: number
  readonly title: string
  readonly head: string
  readonly base: string
  readonly draft: boolean
}

/**
 * One status check reported on a commit, whichever of the two kinds GitHub
 * reports it as.
 *
 * A check run and a commit status are different objects with different field
 * names (`name`/`conclusion` against `context`/`state`) and a required context
 * may be either, so they are read into one shape here rather than leaving
 * every caller to handle both. `conclusion` is null while the check has not
 * concluded, which is the difference between "pending" and "failed" that a
 * caller reads before deciding anything.
 */
export interface CheckContext {
  readonly name: string
  /** `COMPLETED`, `IN_PROGRESS`, `QUEUED`, or null for a commit status, which
   *  reports no status of its own. */
  readonly status: string | null
  /** `SUCCESS`, `FAILURE`, `SKIPPED` and the rest, or null while the check has
   *  not concluded. */
  readonly conclusion: string | null
}

/**
 * One pull request, with the facts a review loop derives its state from.
 *
 * Not {@link GhClient.viewPullRequest}, which answers the shepherd's
 * `--json` field list: that list carries neither ref name, and it carries no
 * review threads at all, because thread resolution exists in GraphQL alone.
 * Widening it would change what every existing consumer is handed for a
 * question none of them asked, which is the rule `listOpenPullRequests`
 * already follows.
 *
 * The two author lists are one entry per thread and one per comment, so a
 * caller reports both a count and who is waiting on it. They are separate
 * fields because they are separate facts: the enterprise coverage bot posts a
 * COMMENT on every pull request here, and a loop that counted it as an
 * unresolved review thread would never reach `done`.
 */
export interface PullRequestDetail {
  readonly number: number
  readonly title: string
  readonly state: IssueState
  readonly draft: boolean
  readonly base: string
  readonly head: string
  /** The head commit's oid, which is what a workflow run names as its
   *  `head_sha`. */
  readonly headSha: string
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`, as GitHub answers it. Carried as
   *  the string GitHub uses rather than a boolean, because `UNKNOWN` means the
   *  mergeability is still being computed and is not a third kind of "no". */
  readonly mergeable: string
  /** Every check reported on the head commit, in the order GitHub lists them.
   *  Empty for a head no check has reported on yet. */
  readonly checks: readonly CheckContext[]
  /** One login per UNRESOLVED review thread, from the thread's first comment.
   *  A thread whose author GitHub no longer names is `unknown`. */
  readonly unresolvedThreadAuthors: readonly string[]
  /** One login per issue comment on the pull request. */
  readonly commentAuthors: readonly string[]
}

/** One workflow run, as `actions/runs` reports it. */
export interface WorkflowRun {
  /** The run's name, which is the workflow's `name:` (`CI` here). */
  readonly name: string
  /** `pull_request`, `push`, `pull_request_target` and the rest. A caller
   *  asserting that a pull request's checks are running reads this: a
   *  `pull_request_target` run on the same head is a different workflow. */
  readonly event: string
  readonly headSha: string
  readonly status: string
  /** Null while the run has not concluded. */
  readonly conclusion: string | null
  /** When the run actually started, which is what a duration is measured
   *  from; `created_at` can precede it by the queue wait. */
  readonly startedAt: string
  readonly updatedAt: string
}

/**
 * What a paginated GraphQL read answers with: the rows it could read, and the
 * reason it could not read more, in the shape {@link GhClient.issueStates}
 * established.
 *
 * `unavailable` beside the rows rather than a throw, for that endpoint's own
 * reason one step further: a sweep asks about several milestones, and one
 * page that could not be read must not cost every other answer. A row left
 * out is therefore never silence: the count of unreadable rows is folded into
 * `unavailable` too.
 */
export interface PagedResult<T> {
  readonly rows: readonly T[]
  readonly unavailable: string | null
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
  /** Every requested number's state, resolved through one or more `gh api
   *  graphql` calls. `not_found` only for a number GraphQL names outright as
   *  gone; any other unresolved number is left out of `states` and its
   *  reason folded into `unavailable`, so a permissions error or a timeout is
   *  never reported as "this issue does not exist" (see {@link GhClient.issueStates}). */
  issueStates: {
    readonly states: Readonly<Record<string, IssueState | 'not_found'>>
    readonly unavailable: string | null
  }
  /** The repository's open milestones. */
  listMilestones: PagedResult<MilestoneSummary>
  /** Open issues, with their dependency relationships. */
  listIssues: PagedResult<IssueSummary>
  /** Open pull requests, including ones no round opened. */
  listOpenPullRequests: PagedResult<PullRequestSummary>
  /** The status-check contexts a branch's rulesets require. An empty list is
   *  an answer: it means no ruleset requires anything of that branch. */
  requiredContexts: {
    readonly contexts: readonly string[]
    readonly unavailable: string | null
  }
  /** One pull request with the facts a review loop reads, or null when it
   *  could not be read. */
  viewPullRequestDetail: {
    readonly pullRequest: PullRequestDetail | null
    readonly unavailable: string | null
  }
  /** Workflow runs, newest first. */
  listWorkflowRuns: PagedResult<WorkflowRun>
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
    /** The bound, in milliseconds, and see {@link RunOptions.timeoutMs} for
     *  what `number` admits that a bound does not. Required, because round 5's
     *  handoff fact 1
     *  is that #154 left this call unbounded and "a watch that cannot return
     *  is worse than no watch": optional, it is that same defect one line
     *  away, and `process.ts` only detaches a bounded child, so an unbounded
     *  watch cannot even be group-killed. The one ported call site has a
     *  bound (`gh-shepherd-pr.py:637`), so nothing is being asked for that a
     *  caller does not already have. */
    boundMs: number
    failFast?: boolean
  }): Promise<GhResults['watchChecks']>
  /**
   * Every number's state: open, closed, merged, or not found. Reads the
   * repository from {@link GhClient.viewRepository} rather than taking one,
   * because the one caller (tier 0 of the context audit, #170) has already
   * resolved the checkout and wants the same repository every other endpoint
   * here answers about.
   *
   * Never throws. A number GraphQL cannot place at all (a private repository
   * this token cannot see, a rate limit, a timeout) is left out of `states`
   * and its reason goes into `unavailable`, because reporting it `not_found`
   * would fabricate a finding out of a failure to ask.
   */
  issueStates(query: { readonly numbers: readonly number[] }): Promise<GhResults['issueStates']>
  /**
   * The repository's open milestones, with their open and closed issue
   * counts. Never throws, for {@link PagedResult}'s reason.
   */
  listMilestones(): Promise<GhResults['listMilestones']>
  /**
   * Open issues with their labels, their `blockedBy` and `blocking`
   * relationships and the pull requests that would close them.
   *
   * `milestone` is GitHub's own `milestoneNumber` filter, as a string because
   * that is the type the filter declares. Left out, every open issue is
   * answered for, which is how a caller reads the issues on no milestone at
   * all: `milestoneNumber: "none"` is NOT that query, verified against the
   * API on 2026-09-21 (it matches nothing rather than matching the
   * unassigned), so the caller filters on `milestone === null` instead.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listIssues(query?: { readonly milestone?: string }): Promise<GhResults['listIssues']>
  /**
   * Every open pull request: number, title, head, base and draft.
   *
   * Not {@link GhClient.listPullRequests}, which answers the shepherd's field
   * list and carries neither `headRefName` nor `baseRefName`. Widening that
   * list would change what every existing consumer is handed for a question
   * none of them asked, so this is its own endpoint and its own query.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listOpenPullRequests(): Promise<GhResults['listOpenPullRequests']>
  /**
   * The status-check contexts every ruleset that applies to `branch`
   * requires, unioned and in the order the rules name them.
   *
   * REST (`repos/{owner}/{name}/rules/branches/{branch}`) rather than
   * GraphQL, which exposes no equivalent, and per branch rather than per
   * repository, because that endpoint answers for the rules that actually
   * apply to one ref: a stacked pull request based on a topic branch is
   * required to pass nothing at all by the rulesets, while the same head
   * based on the default branch is required to pass every context. A caller
   * that hard-coded the default branch's list would report the wrong answer
   * for exactly the pull requests a stack is made of.
   *
   * An EMPTY list is an answer and not a failure: it says no ruleset requires
   * anything of that branch. Never throws, for {@link PagedResult}'s reason.
   */
  requiredContexts(query: { readonly branch: string }): Promise<GhResults['requiredContexts']>
  /**
   * One pull request's refs, head commit, draft flag, mergeability, reported
   * checks, unresolved review threads and comments, in one round trip.
   *
   * Never throws, for {@link PagedResult}'s reason: a review loop reads this
   * on every tick and a read that failed is a tick that waits, not a loop
   * that dies. A pull request the reply does not carry is `null` with the
   * reason beside it.
   */
  viewPullRequestDetail(pull: {
    readonly pullRequest: number
  }): Promise<GhResults['viewPullRequestDetail']>
  /**
   * Workflow runs, newest first, through `actions/runs`.
   *
   * Not {@link GhClient.listRuns}, whose `--json` field list carries neither
   * `event` nor the head commit, so a caller cannot tell a `pull_request` run
   * from a `push` one, nor tell which head either ran on. `branch` is the
   * filter the REST endpoint applies server-side; `head_sha` is NOT used,
   * because it answered nothing once for a head whose runs existed (round 7
   * finding 6) while `branch` answered.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listWorkflowRuns(query?: {
    readonly branch?: string
    readonly perPage?: number
  }): Promise<GhResults['listWorkflowRuns']>
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

  /**
   * The account of the failure WITHOUT the `gh <argv> failed: ` prefix the
   * message carries, so a report that quotes gh quotes gh alone.
   *
   * A caller printing a one-line reason reads this, never `message`. The
   * Python's `gh_json` prints `last_line(stderr)`, and stderr for the
   * ordinary refusal is a single line ("gh: API rate limit exceeded"), so
   * tailing `message` returns the WHOLE message, argv and all, and only a
   * MULTI-line stderr happens to reduce to the Python's wording. That is the
   * defect `plugins/gh/src/commands/sync-repo.ts` found at #159: a rate limit
   * put forty characters of `--json` fields inside a report line.
   *
   * It is the same string for every throw site: {@link accountOf} for a gh
   * that exited non-zero or could not be started, and the message itself
   * where the message is already gh's account alone (an answer that is not
   * JSON, or not the shape the endpoint promises).
   *
   * Public like every other member, for the double identity rule above.
   */
  readonly detail: string

  constructor(message: string, status: number | null, options: { cause: unknown; detail: string }) {
    super(message, { cause: options.cause })
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this a caught failure reports as a plain
    // `Error`.
    this.name = 'GhError'
    this.status = status
    this.detail = options.detail
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
  /**
   * The child's whole environment. Left out, `gh` inherits this process's,
   * which is what every ported call site gets today.
   *
   * It is here because `GH_REPO` does to `cwd` exactly what `GIT_DIR` does
   * (`gh help environment`: "specify the GitHub repository in the
   * `[HOST/]OWNER/REPO` format for commands that otherwise operate on a local
   * repository"), and the mode it displaces is the one `gh-sync-repo.py:250`
   * uses: no `repository`, chdir'd into the checkout, letting gh resolve.
   * `GH_HOST`, `GH_TOKEN` and `GH_CONFIG_DIR` are the same class, which is why
   * `harness/sandbox.ts` strips every `GH_` key before a test runs anything.
   *
   * Optional rather than required, unlike `RepoOptions.env` next door: the
   * other two fields here are optional, no ported call site pins an
   * environment, and as with that one naming it buys the naming and not the
   * scrubbing. A caller inside a hook, or anywhere else that inherited a
   * `GH_REPO` it did not choose, passes an environment without it.
   */
  readonly env?: NodeJS.ProcessEnv
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

/** How many numbers `issueStates` puts in one `gh api graphql` call. A
 *  conservative batch size rather than a documented limit: GitHub rejects a
 *  query by node count and complexity, not by a fixed number of aliases, and
 *  100 `state` fields are far below either (the context-audit spike, #164). */
const ISSUE_BATCH = 100

/** How many nodes one page of a paginated sweep query asks for. 100 is the
 *  most a GitHub connection accepts in one `first:`. */
const SWEEP_PAGE = 100

/**
 * How many pages one paginated read will ask for before it stops and says so.
 *
 * A `hasNextPage` that stays true with a cursor that does not advance is a
 * loop this process never leaves, and a command that never returns is worse
 * than a short answer that admits it is short. 20 pages is 2,000 open issues,
 * milestones or pull requests in one repository, which is far past anything a
 * round sweeps; reaching it is reported through `unavailable` rather than
 * silently truncating the rows.
 */
const SWEEP_PAGES = 20

/**
 * How many workflow runs `listWorkflowRuns` asks for when the caller names no
 * number. 30 is `actions/runs`' own default page size, written out here so
 * the argv says what it asks for rather than inheriting a number from the
 * API; a caller measuring durations passes its own sample size.
 */
const RUN_PAGE = 30

/** Every value {@link IssueState} can hold, as a `Record` rather than a bare
 *  array literal: adding a member to the union without adding its key here is
 *  a `tsc` error (an incomplete `Record<IssueState, true>`), where a
 *  `readonly IssueState[]` literal would stay valid with a member missing and
 *  the two would drift apart silently. */
const ISSUE_STATES: Record<IssueState, true> = { OPEN: true, CLOSED: true, MERGED: true }

/** Whether a GraphQL `state` field is one of the three states this promises. */
const isIssueState = (value: unknown): value is IssueState =>
  typeof value === 'string' && Object.hasOwn(ISSUE_STATES, value)

/** `unknown` narrowed to a record, or `undefined` when it is not one. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** Several reasons as one sentence, or null when there are none. */
const joinedReasons = (reasons: readonly string[]): string | null =>
  reasons.length === 0 ? null : reasons.join('; ')

/**
 * The GraphQL query for a batch of issue and pull-request numbers in one
 * round trip: one aliased `issueOrPullRequest` field per number, each asking
 * for `state` under both possible types, because `gh` cannot tell the caller
 * in advance which of the two a number is. Ported from the context-audit
 * spike's `buildIssueQuery` (#164).
 */
const buildIssueQuery = (owner: string, name: string, numbers: readonly number[]): string => {
  const fields = numbers.map(
    (n, index) =>
      `i${index}: issueOrPullRequest(number: ${n}) ` +
      `{ ... on Issue { state } ... on PullRequest { state } }`,
  )
  return `query {
  repository(owner: "${owner}", name: "${name}") {
    ${fields.join('\n    ')}
  }
}`
}

/**
 * The alias one error says outright does not exist, or null for every other
 * error. A GraphQL reply tags each error with a `type` and the `path` it
 * happened on: a missing node is
 * `{"type":"NOT_FOUND","path":["repository","i1"], ...}`. A `FORBIDDEN`, a
 * `RATE_LIMITED` and a timeout are tagged differently, and a timeout carries
 * no `path` at all, so none of them names an alias here. That is the whole
 * point: only an alias this returns may be reported absent.
 */
const notFoundAlias = (entry: unknown): string | null => {
  const error = asRecord(entry)
  if (error?.type !== 'NOT_FOUND') return null
  const path = error.path
  if (!Array.isArray(path) || path.length === 0) return null
  const last: unknown = path[path.length - 1]
  return typeof last === 'string' ? last : null
}

/**
 * One chunk's reply, aligned back to `numbers` by alias index, or `undefined`
 * when there is nothing to align against: stdout that is not JSON, or JSON
 * with no `data.repository` object in it. The reason for that `undefined` is
 * not this function's to give, because the caller holds the {@link RunResult}
 * the body came from and reports `accountOf` it, which covers a gh that never
 * started as well as a body with no repository in it.
 *
 * `states` carries only the numbers the reply actually answered for: a number
 * left out is one the reply gave no usable answer for, and a caller reads that
 * as `unavailable`, never as absent. `errors` is every error message NOT
 * already accounted for by a `not_found` state, because a `NOT_FOUND` on a
 * named alias is a complete answer about that number rather than a reason the
 * lookup was unavailable. Ported from the spike's `parseIssueResponse` and
 * `parseIssueChunkBody` (#164), which were two functions only for the
 * fallback the spike kept for a reply with no `data` wrapper; that fallback is
 * unreachable once a reply needs a `data.repository` to be read at all.
 */
const parseIssueChunk = (
  stdout: string,
  numbers: readonly number[],
): { states: Record<string, IssueState | 'not_found'>; errors: string | null } | undefined => {
  let reply: Record<string, unknown> | undefined
  try {
    reply = asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
  const repository = asRecord(asRecord(reply?.data)?.repository)
  if (repository === undefined) return undefined

  const errorsField = reply?.errors
  const entries = Array.isArray(errorsField) ? errorsField : []
  const absent = new Set(entries.map(notFoundAlias).filter((alias) => alias !== null))
  const states: Record<string, IssueState | 'not_found'> = {}
  numbers.forEach((n, index) => {
    const alias = `i${index}`
    const state = asRecord(repository[alias])?.state
    if (isIssueState(state)) {
      states[String(n)] = state
    } else if (absent.has(alias)) {
      states[String(n)] = 'not_found'
    }
  })
  const messages = entries
    .filter((entry) => notFoundAlias(entry) === null)
    .map((entry) => asRecord(entry)?.message)
    .filter((message): message is string => typeof message === 'string')
  return { states, errors: joinedReasons(messages) }
}

/**
 * The three paginated sweep queries.
 *
 * Owner, name, cursor and milestone arrive as GraphQL VARIABLES rather than
 * interpolated into the query text the way {@link buildIssueQuery} builds its
 * aliases. The aliases have to be text, because a variable cannot name a
 * field; these do not, and a cursor is an opaque base64 string from the
 * server that has no business being spliced into a query body. One query
 * string per endpoint also means the argv gh is handed is the same bytes on
 * every page, which is what a captured fixture can be compared against.
 *
 * `after: $cursor` with no `cursor` variable supplied is `null`, which is the
 * first page; the client omits the variable rather than passing an empty
 * string.
 */
const MILESTONES_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    milestones(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, orderBy: {field: NUMBER, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
      }
    }
  }
}`

const ISSUES_QUERY = `query($owner: String!, $name: String!, $cursor: String, $milestone: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, filterBy: {milestoneNumber: $milestone}, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        milestone { number title }
        labels(first: ${SWEEP_PAGE}) { nodes { name } }
        blockedBy(first: ${SWEEP_PAGE}) { nodes { number state } }
        blocking(first: ${SWEEP_PAGE}) { nodes { number state } }
        closedByPullRequestsReferences(first: ${SWEEP_PAGE}, includeClosedPrs: true) { nodes { number state } }
      }
    }
  }
}`

const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title isDraft headRefName baseRefName }
    }
  }
}`

/**
 * One pull request's whole state in one round trip.
 *
 * `commits(last: 1)` is how the head commit's rollup is reached: a pull
 * request has no rollup field of its own, and `last: 1` is the head whatever
 * the branch's length. The three connections each carry `pageInfo`, unlike
 * the dependency connections in {@link ISSUES_QUERY}, because here there IS a
 * page signal to ask for and a caller that must not under-report an
 * unresolved thread needs to know when the list is short.
 *
 * A review thread's author is its FIRST comment's, which is who opened it.
 */
const PULL_REQUEST_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      state
      isDraft
      mergeable
      baseRefName
      headRefName
      reviewThreads(first: ${SWEEP_PAGE}) {
        pageInfo { hasNextPage }
        nodes { isResolved comments(first: 1) { nodes { author { login } } } }
      }
      comments(first: ${SWEEP_PAGE}) {
        pageInfo { hasNextPage }
        nodes { author { login } }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: ${SWEEP_PAGE}) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/** An integer, or null for anything else. GraphQL answers a count and a
 *  number as JSON numbers, and a value that is not one is a reply this file
 *  does not recognise rather than a zero to carry on with. */
const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null

/** A string, or null for anything else. */
const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A connection's `nodes` array, or null when the field is not one. */
const nodesOf = (value: unknown): unknown[] | null => {
  const nodes = asRecord(value)?.nodes
  return Array.isArray(nodes) ? nodes : null
}

/**
 * A `{ nodes { number state } }` connection as refs, or null when any entry
 * is not one.
 *
 * Null for the whole connection rather than for the bad entry: a blocker list
 * with one entry quietly dropped is a blocked issue reported as unblocked,
 * which is the one mistake a sweep must not make. The caller turns a null
 * into an unreadable row and says so.
 */
const readRefs = (value: unknown): IssueRef[] | null => {
  const nodes = nodesOf(value)
  if (nodes === null) return null
  const refs: IssueRef[] = []
  for (const entry of nodes) {
    const record = asRecord(entry)
    const number = asInteger(record?.number)
    const state = record?.state
    if (number === null || !isIssueState(state)) return null
    refs.push({ number, state })
  }
  return refs
}

/** One milestone node, or null when it is not the shape asked for. */
const readMilestone = (node: unknown): MilestoneSummary | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const title = asText(record?.title)
  const openIssues = asInteger(asRecord(record?.issues)?.totalCount)
  const closedIssues = asInteger(asRecord(record?.closedIssues)?.totalCount)
  if (number === null || title === null || openIssues === null || closedIssues === null) return null
  return { number, title, openIssues, closedIssues }
}

/** One issue node, or null when it is not the shape asked for. */
const readIssue = (node: unknown): IssueSummary | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const title = asText(record?.title)
  const blockedBy = readRefs(record?.blockedBy)
  const blocking = readRefs(record?.blocking)
  const pullRequests = readRefs(record?.closedByPullRequestsReferences)
  const labelNodes = nodesOf(record?.labels)
  if (
    number === null ||
    title === null ||
    blockedBy === null ||
    blocking === null ||
    pullRequests === null ||
    labelNodes === null
  ) {
    return null
  }
  // The dependency connections are asked for with a `first:` and no page
  // signal of their own, so a list answered at exactly the ceiling cannot be
  // told from the first page of a longer one. The classification reads
  // `blockedBy`, and a blocker list one entry short is a blocked issue
  // reported as unblocked, which is the one mistake a sweep must not make, so
  // the ambiguity is read the same conservative way a malformed entry is:
  // the whole issue is unreadable and is counted as such. `blocking` is in the
  // rule for its own reason: it classifies nothing, but it is what a caller
  // reads to say which issues a round unlocks and which of them the round's
  // comment has to reach, and a truncated `blocking` list would under-claim
  // both in silence. `labels` and `closedByPullRequestsReferences` are read
  // and reported without anything being concluded from their length, so they
  // are left alone.
  if (blockedBy.length === SWEEP_PAGE || blocking.length === SWEEP_PAGE) return null
  const labels: string[] = []
  for (const entry of labelNodes) {
    const name = asText(asRecord(entry)?.name)
    if (name === null) return null
    labels.push(name)
  }
  // An issue on no milestone answers `null` here, which is the query a caller
  // reading the unassigned set depends on being distinguishable from a
  // milestone whose fields could not be read. A field that is present but
  // neither an object nor `null` is not "no milestone", it is a malformed
  // row, and is rejected like every sibling field rather than folded into
  // the no-milestone case.
  const milestoneField = record?.milestone
  let milestone: IssueSummary['milestone'] = null
  if (milestoneField !== undefined && milestoneField !== null) {
    const milestoneRecord = asRecord(milestoneField)
    if (milestoneRecord === undefined) return null
    const milestoneNumber = asInteger(milestoneRecord.number)
    const milestoneTitle = asText(milestoneRecord.title)
    if (milestoneNumber === null || milestoneTitle === null) return null
    milestone = { number: milestoneNumber, title: milestoneTitle }
  }
  return { number, title, milestone, labels, blockedBy, blocking, pullRequests }
}

/** One pull request node, or null when it is not the shape asked for. */
const readPullRequest = (node: unknown): PullRequestSummary | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const title = asText(record?.title)
  const head = asText(record?.headRefName)
  const base = asText(record?.baseRefName)
  const draft = record?.isDraft
  if (number === null || title === null || head === null || base === null) return null
  if (typeof draft !== 'boolean') return null
  return { number, title, head, base, draft }
}

/** Whether a connection said it has a page after the one that was read. */
const truncated = (value: unknown): boolean =>
  asRecord(asRecord(value)?.pageInfo)?.hasNextPage === true

/** A node's author's login, or `unknown` for an author GitHub no longer
 *  names, which is what a deleted account answers with. */
const loginOf = (value: unknown): string => {
  const login = asText(asRecord(asRecord(value)?.author)?.login)
  return login === null ? 'unknown' : login
}

/** The two `StatusState` values that mean a commit status has not concluded. */
const UNCONCLUDED: Record<string, true> = { PENDING: true, EXPECTED: true }

/**
 * One reported check, from either object GitHub reports one as.
 *
 * Told apart by the fields present rather than by `__typename`: the two are
 * `name`/`status`/`conclusion` and `context`/`state`, so asking which fields
 * answered is asking the same question one step closer to what is read. A
 * commit status carries no status of its own, so its `status` is null, which
 * is what {@link CheckContext} promises.
 *
 * Its `state` is its conclusion only where it names one. `StatusState` is
 * `EXPECTED, ERROR, FAILURE, PENDING, SUCCESS` (GitHub's schema, read by
 * introspection), and two of those five are the check saying it has NOT
 * concluded. Carrying them through as a conclusion breaks the one invariant
 * {@link CheckContext} states, and a reader that trusts it, such as a review
 * loop matching a conclusion against the set that satisfies a required check,
 * calls a preview deployment that is still building a failure and reports the
 * whole pull request red.
 */
const readCheck = (node: unknown): CheckContext | null => {
  const record = asRecord(node)
  const name = asText(record?.name)
  if (name !== null) {
    return { name, status: asText(record?.status), conclusion: asText(record?.conclusion) }
  }
  // A node that is not a record at all lands here too, and is refused by the
  // same arm: it has neither field, which is what "neither kind of check"
  // means.
  const context = asText(record?.context)
  if (context === null) return null
  const state = asText(record?.state)
  return {
    name: context,
    status: null,
    conclusion: state !== null && Object.hasOwn(UNCONCLUDED, state) ? null : state,
  }
}

/** One pull request's facts, with every reason a list beside them is short,
 *  or null when the reply is not the shape the query asked for. */
const readPullRequestDetail = (
  node: unknown,
): { detail: PullRequestDetail; reasons: string[] } | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const title = asText(record?.title)
  const state = record?.state
  const draft = record?.isDraft
  const mergeable = asText(record?.mergeable)
  const base = asText(record?.baseRefName)
  const head = asText(record?.headRefName)
  if (number === null || title === null || !isIssueState(state)) return null
  if (typeof draft !== 'boolean' || mergeable === null || base === null || head === null)
    return null

  const commits = nodesOf(record?.commits)
  const commit = commits === null ? undefined : asRecord(asRecord(commits[0])?.commit)
  const headSha = asText(commit?.oid)
  if (headSha === null) return null

  const reasons: string[] = []
  const checks: CheckContext[] = []
  // A null `statusCheckRollup` is a head nothing has reported on yet, which
  // is an answer about the checks and not a read that fell short. Whether
  // that means the run has not started is a question about workflow runs, and
  // `listWorkflowRuns` is where it is asked.
  const rollup = asRecord(commit?.statusCheckRollup)
  if (rollup !== undefined) {
    const nodes = nodesOf(rollup.contexts)
    if (nodes === null) return null
    for (const entry of nodes) {
      const check = readCheck(entry)
      if (check === null) return null
      checks.push(check)
    }
    if (truncated(rollup.contexts)) {
      reasons.push(`pull request ${number} reported more checks than the ${SWEEP_PAGE} this reads`)
    }
  }

  const threads = nodesOf(record?.reviewThreads)
  if (threads === null) return null
  const unresolvedThreadAuthors: string[] = []
  for (const entry of threads) {
    const thread = asRecord(entry)
    if (typeof thread?.isResolved !== 'boolean') return null
    if (thread.isResolved) continue
    unresolvedThreadAuthors.push(loginOf(nodesOf(thread.comments)?.[0]))
  }
  if (truncated(record?.reviewThreads)) {
    reasons.push(
      `pull request ${number} has more review threads than the ${SWEEP_PAGE} this reads, ` +
        'so the unresolved count may be short',
    )
  }

  const comments = nodesOf(record?.comments)
  if (comments === null) return null
  if (truncated(record?.comments)) {
    reasons.push(
      `pull request ${number} has more comments than the ${SWEEP_PAGE} this reads, ` +
        'so the comment count may be short',
    )
  }

  return {
    detail: {
      number,
      title,
      state,
      draft,
      base,
      head,
      headSha,
      mergeable,
      checks,
      unresolvedThreadAuthors,
      commentAuthors: comments.map(loginOf),
    },
    reasons,
  }
}

/** One `actions/runs` row, or null when it is not the shape REST promises.
 *  The field names are REST's own, which are not GraphQL's. */
const readWorkflowRun = (node: unknown): WorkflowRun | null => {
  const record = asRecord(node)
  const name = asText(record?.name)
  const event = asText(record?.event)
  const headSha = asText(record?.head_sha)
  const status = asText(record?.status)
  const startedAt = asText(record?.run_started_at)
  const updatedAt = asText(record?.updated_at)
  if (name === null || event === null || headSha === null) return null
  if (status === null || startedAt === null || updatedAt === null) return null
  // A run that has not concluded reports `conclusion: null`, which is the
  // difference between "still going" and "failed" and is carried as null.
  return {
    name,
    event,
    headSha,
    status,
    conclusion: asText(record?.conclusion),
    startedAt,
    updatedAt,
  }
}

/**
 * Every context the branch rules require, unioned across the rules, or null
 * when a rule is not the shape the endpoint promises.
 *
 * Null for the whole read rather than for the one bad rule, on
 * {@link readRefs}' grounds one domain over: a required context silently
 * dropped is a pull request reported green that the ruleset would refuse, and
 * a caller told nothing cannot know it happened.
 */
const requiredContextsOf = (rules: readonly unknown[]): string[] | null => {
  const contexts: string[] = []
  for (const entry of rules) {
    const rule = asRecord(entry)
    if (rule?.type !== 'required_status_checks') continue
    const checks = asRecord(rule.parameters)?.required_status_checks
    if (!Array.isArray(checks)) return null
    for (const check of checks) {
      const context = asText(asRecord(check)?.context)
      if (context === null) return null
      if (!contexts.includes(context)) contexts.push(context)
    }
  }
  return contexts
}

/** What one page of a paginated read yielded. */
interface Page {
  readonly nodes: readonly unknown[]
  readonly hasNextPage: boolean
  readonly endCursor: string | null
  readonly errors: string | null
}

/**
 * One page's reply, or `undefined` when there is nothing to read: stdout that
 * is not JSON, or JSON with no connection at `data.repository.<field>` in it.
 * The reason for that `undefined` belongs to the caller, which holds the
 * {@link RunResult} and reports `accountOf` it, exactly as `parseIssueChunk`
 * leaves it.
 *
 * `errors` is every message the reply carried. Unlike `issueStates` there is
 * no per-alias `NOT_FOUND` to account for separately: a sweep query names no
 * node that may legitimately be absent, so any error at all is a reason the
 * answer is short.
 */
const parseConnection = (stdout: string, field: string): Page | undefined => {
  let reply: Record<string, unknown> | undefined
  try {
    reply = asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
  const connection = asRecord(asRecord(asRecord(reply?.data)?.repository)?.[field])
  if (connection === undefined) return undefined
  const nodes = nodesOf(connection)
  if (nodes === null) return undefined
  const info = asRecord(connection.pageInfo)
  const errorsField = reply?.errors
  const entries = Array.isArray(errorsField) ? errorsField : []
  const messages = entries
    .map((entry) => asRecord(entry)?.message)
    .filter((message): message is string => typeof message === 'string')
  return {
    nodes,
    hasNextPage: info?.hasNextPage === true,
    endCursor: asText(info?.endCursor),
    errors: joinedReasons(messages),
  }
}

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
    // The message is already gh's account with no argv in front of it, so it
    // is its own `detail`. Every throw site here carries one, so a caller
    // reads the same field whichever it caught.
    const said = `gh answered ${what} with something that is not JSON: ${(error as Error).message}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
}

const rows = (result: RunResult, what: string): unknown[] => {
  const value = parse(result, what)
  if (!Array.isArray(value)) {
    const said = `gh answered ${what} with something that is not a list: ${JSON.stringify(value)}`
    throw new GhError(said, result.status, { cause: result, detail: said })
  }
  return value
}

const record = (result: RunResult, what: string): Record<string, unknown> => {
  const value = parse(result, what)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const said = `gh answered ${what} with something that is not an object: ${JSON.stringify(value)}`
    throw new GhError(said, result.status, { cause: result, detail: said })
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
    spawn('gh', args, { cwd: options.cwd, env: options.env, timeoutMs: boundMs })

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
      // The account goes on the error as well as into the message: a caller
      // printing a one-line reason wants gh's words alone, and tailing the
      // message would hand it this argv (`GhError.detail`).
      const detail = accountOf(result)
      throw new GhError(`gh ${args.join(' ')} failed: ${detail}`, result.status, {
        cause: result,
        detail,
      })
    }
    return result
  }

  /** gh's stdout alone, for the endpoints whose answer is text. */
  const text = async (args: readonly string[]): Promise<string> => (await succeeded(args)).stdout

  /**
   * The repository this client answers about, split into the two arguments a
   * GraphQL query names it with, or the reason neither could be read.
   *
   * Read through `client.viewRepository` rather than from `options`, because
   * a client built with a `cwd` and no `repository` is the mode
   * `gh-sync-repo.py` used and the one `bin/gh.ts` still builds: the
   * repository is whatever gh resolves from that directory, and asking the
   * existing endpoint is how this file finds out (round 6's ruling on #170).
   *
   * `nameWithOwner` is "owner/name" in one string, so reusing that endpoint
   * costs this split. There is deliberately no branch for a value of some
   * other shape: `split` never throws, and the query built from whatever it
   * yields fails downstream, where `accountOf` already reports it.
   * `owner`'s cast is `noUncheckedIndexedAccess` being exact about a
   * `string[]` of unknown length, erased and adding no branch; `name` is
   * `String(parts[1])` rather than the same cast, because a `nameWithOwner`
   * with no `/` leaves `parts[1]` genuinely `undefined` and a cast would be a
   * type that lies about the value it holds.
   */
  const repositoryParts = async (): Promise<
    { owner: string; name: string; unavailable: null } | { unavailable: string }
  > => {
    try {
      const viewed = await client.viewRepository()
      const parts = String(viewed.nameWithOwner).split('/')
      return { owner: parts[0] as string, name: String(parts[1]), unavailable: null }
    } catch (error) {
      // `viewRepository` throws only `GhError` (`succeeded` and `record`
      // above), so this is a cast, not a runtime check: an `instanceof` guard
      // here would add an arm no input can reach, which is the branch the
      // coverage rule says to restructure away rather than exclude.
      return { unavailable: (error as GhError).detail }
    }
  }

  /**
   * Every page of one paginated GraphQL read, as rows.
   *
   * Read through `invoke` and not `succeeded`, for `issueStates`' reason:
   * `gh api graphql` exits 1 on a partial body that is still an answer, so
   * the body is read whatever the status. Nothing here throws; every reason
   * the answer is short, including a row whose shape could not be read, ends
   * up in `unavailable` beside the rows that were read.
   */
  const collect = async <T>(
    field: string,
    query: string,
    variables: readonly string[],
    read: (node: unknown) => T | null,
  ): Promise<PagedResult<T>> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null) return { rows: [], unavailable: parts.unavailable }

    const rows: T[] = []
    const reasons: string[] = []
    let unreadable = 0
    let cursor: string | null = null
    for (let page = 0; page < SWEEP_PAGES; page += 1) {
      const args = [
        'api',
        'graphql',
        '-f',
        `owner=${parts.owner}`,
        '-f',
        `name=${parts.name}`,
        ...variables,
        ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
        '-f',
        `query=${query}`,
      ]
      const result = await invoke(args)
      const answer = parseConnection(result.stdout, field)
      if (answer === undefined) {
        reasons.push(accountOf(result))
        break
      }
      // A non-null `endCursor` equal to the cursor this page was just asked
      // with is a reply this cannot follow: asking again would ask the same
      // question forever, and the page's rows have already been read once.
      // Breaking here, before they are read a second time, is what keeps a
      // stuck cursor from counting the same rows up to `SWEEP_PAGES` times.
      if (answer.endCursor !== null && answer.endCursor === cursor) {
        reasons.push(`${field}'s reply repeated the same cursor without advancing`)
        break
      }
      for (const node of answer.nodes) {
        const row = read(node)
        if (row === null) unreadable += 1
        else rows.push(row)
      }
      if (answer.errors !== null) reasons.push(answer.errors)
      // An `endCursor` of null with `hasNextPage` true is a reply this cannot
      // follow, and asking again with the same cursor would ask the same
      // question forever. Ending here is the short answer, and it is a reason
      // like any other: the rows already read are still an answer, but a
      // caller told nothing would read a truncated set as a complete one.
      if (answer.hasNextPage && answer.endCursor === null) {
        reasons.push(`${field} has more pages and the reply named no cursor to ask with`)
        break
      }
      if (!answer.hasNextPage) break
      if (page === SWEEP_PAGES - 1) {
        reasons.push(`${field} has more pages than the ${SWEEP_PAGES} this reads`)
        break
      }
      cursor = answer.endCursor
    }
    // One counter and one reason for two causes: a field that was not the
    // shape the query asked for, and a dependency list at the page ceiling,
    // which is a well formed row this refuses to trust. The sentence has to be
    // true of both, because telling them apart would mean a second answer from
    // `read`, which three endpoints share. `lib/README.md` lists the causes.
    if (unreadable > 0) {
      reasons.push(`${unreadable} ${field} row(s) could not be read`)
    }
    return { rows, unavailable: joinedReasons(reasons) }
  }

  /**
   * One GraphQL read that is not paginated: the repository resolved the one
   * way, the body read through `invoke` whatever gh's exit status (a partial
   * body is still an answer), and every reason there is no answer returned as
   * a sentence rather than thrown.
   *
   * `data` is the `repository` object, so a caller reads its own field off it
   * exactly as {@link parseConnection} does for the paginated reads. `data`
   * and `unavailable` are independent: GraphQL answers a `repository` and an
   * `errors` list together for a query that partly succeeded, and dropping
   * either would be reporting half an answer as a whole one.
   */
  const queryOnce = async (
    query: string,
    variables: readonly string[],
  ): Promise<{ data: Record<string, unknown> | null; unavailable: string | null }> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null) return { data: null, unavailable: parts.unavailable }
    const result = await invoke([
      'api',
      'graphql',
      '-f',
      `owner=${parts.owner}`,
      '-f',
      `name=${parts.name}`,
      ...variables,
      '-f',
      `query=${query}`,
    ])
    let reply: Record<string, unknown> | undefined
    try {
      reply = asRecord(JSON.parse(result.stdout))
    } catch {
      return { data: null, unavailable: accountOf(result) }
    }
    const repository = asRecord(asRecord(reply?.data)?.repository)
    if (repository === undefined) return { data: null, unavailable: accountOf(result) }
    const errorsField = reply?.errors
    const entries = Array.isArray(errorsField) ? errorsField : []
    const messages = entries
      .map((entry) => asRecord(entry)?.message)
      .filter((message): message is string => typeof message === 'string')
    return { data: repository, unavailable: joinedReasons(messages) }
  }

  /**
   * One REST read under this repository's path, as whatever JSON it answered,
   * or the reason there is none.
   *
   * Read through `invoke` for `issueStates`' reason: `gh api` exits non-zero
   * on a 404 and on a 403 alike, and the body it printed is still the best
   * account of which it was, so the status decides nothing here and
   * `accountOf` reports what gh said.
   */
  const restJson = async (
    path: string,
  ): Promise<{ value: unknown; unavailable: null } | { value: null; unavailable: string }> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null) return { value: null, unavailable: parts.unavailable }
    const result = await invoke(['api', `repos/${parts.owner}/${parts.name}/${path}`])
    try {
      return { value: JSON.parse(result.stdout), unavailable: null }
    } catch {
      return { value: null, unavailable: accountOf(result) }
    }
  }

  // A `const` bound and then returned, rather than a plain `return`, because
  // `issueStates` reads the repository through `client.viewRepository` (round
  // 6's ruling on #170: "the existing viewRepository()", not a second copy of
  // its argv). The reference resolves when that endpoint is called, by which
  // point `client` is assigned.
  const client: GhClient = {
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

    // Never throws (the interface's own contract): a failure to resolve the
    // repository, to reach gh at all, or to read what gh printed is folded
    // into `unavailable` rather than rejecting, because the one consumer
    // (tier 0 of the context audit, #164/#170) reports on many numbers at
    // once and a single bad chunk must not cost it every other answer.
    issueStates: async (query) => {
      // The same two arguments every GraphQL endpoint here needs, resolved
      // the one way (`repositoryParts`, which carries the reasoning and the
      // pinned case "reports a repository whose name has no owner prefix").
      const parts = await repositoryParts()
      if (parts.unavailable !== null) return { states: {}, unavailable: parts.unavailable }
      const { owner, name } = parts

      const states: Record<string, IssueState | 'not_found'> = {}
      const reasons: string[] = []
      for (let i = 0; i < query.numbers.length; i += ISSUE_BATCH) {
        const chunk = query.numbers.slice(i, i + ISSUE_BATCH)
        // `gh api graphql` exits 1 on a partial body that is still an answer
        // (one bad alias fails the whole call), so the body is read whatever
        // the status, through `invoke` rather than `succeeded`.
        const args = ['api', 'graphql', '-f', `query=${buildIssueQuery(owner, name, chunk)}`]
        const result = await invoke(args)
        const answer = parseIssueChunk(result.stdout, chunk)
        if (answer === undefined) {
          reasons.push(accountOf(result))
          continue
        }
        Object.assign(states, answer.states)
        if (answer.errors !== null) reasons.push(answer.errors)
      }
      return { states, unavailable: joinedReasons(reasons) }
    },

    listMilestones: async () => collect('milestones', MILESTONES_QUERY, [], readMilestone),

    // The milestone filter is a variable and not a second query, so the argv
    // differs by two words and the query text does not. Omitted, the variable
    // is null and GitHub applies no milestone filter at all, which is how a
    // caller reads the issues on no milestone (see the interface).
    listIssues: async (query = {}) =>
      collect(
        'issues',
        ISSUES_QUERY,
        query.milestone === undefined ? [] : ['-f', `milestone=${query.milestone}`],
        readIssue,
      ),

    listOpenPullRequests: async () =>
      collect('pullRequests', PULL_REQUESTS_QUERY, [], readPullRequest),

    // The branch is percent-encoded into the path because a branch name may
    // carry a `/` (`spike/context-audit`), and an unencoded one would name a
    // path segment that is not the branch and answer 404 for a branch that
    // exists.
    requiredContexts: async (query) => {
      const answer = await restJson(`rules/branches/${encodeURIComponent(query.branch)}`)
      if (answer.unavailable !== null) return { contexts: [], unavailable: answer.unavailable }
      if (!Array.isArray(answer.value)) {
        return {
          contexts: [],
          unavailable: `the rules for ${query.branch} were not a list of rules`,
        }
      }
      const contexts = requiredContextsOf(answer.value)
      if (contexts === null) {
        return {
          contexts: [],
          unavailable: `a required-status-checks rule on ${query.branch} could not be read`,
        }
      }
      return { contexts, unavailable: null }
    },

    viewPullRequestDetail: async (pull) => {
      const answer = await queryOnce(PULL_REQUEST_DETAIL_QUERY, [
        // `-F` and not `-f`: `number` is an `Int!`, and `-f` would send it as
        // the string "178", which GraphQL refuses outright.
        '-F',
        `number=${pull.pullRequest}`,
      ])
      if (answer.data === null) return { pullRequest: null, unavailable: answer.unavailable }
      const read = readPullRequestDetail(answer.data.pullRequest)
      if (read === null) {
        const said = `pull request ${pull.pullRequest} could not be read`
        return {
          pullRequest: null,
          // Whatever GraphQL said about it leads, because "no such pull
          // request" and "this token may not see it" arrive as the same
          // missing node and only the error tells them apart.
          unavailable: answer.unavailable === null ? said : `${said}: ${answer.unavailable}`,
        }
      }
      return {
        pullRequest: read.detail,
        unavailable: joinedReasons(
          answer.unavailable === null ? read.reasons : [...read.reasons, answer.unavailable],
        ),
      }
    },

    listWorkflowRuns: async (query = {}) => {
      const perPage = query.perPage === undefined ? RUN_PAGE : query.perPage
      const filters = [`per_page=${perPage}`]
      if (query.branch !== undefined) filters.push(`branch=${encodeURIComponent(query.branch)}`)
      const answer = await restJson(`actions/runs?${filters.join('&')}`)
      if (answer.unavailable !== null) return { rows: [], unavailable: answer.unavailable }
      const runs = asRecord(answer.value)?.workflow_runs
      if (!Array.isArray(runs)) {
        return { rows: [], unavailable: 'the runs reply carried no workflow_runs list' }
      }
      const rows: WorkflowRun[] = []
      let unreadable = 0
      for (const entry of runs) {
        const row = readWorkflowRun(entry)
        if (row === null) unreadable += 1
        else rows.push(row)
      }
      return {
        rows,
        // A row left out is never silence, for `collect`'s reason: a caller
        // asserting that a run exists for a head would read a dropped row as
        // "no run" and close and reopen a pull request over it.
        unavailable:
          unreadable === 0 ? null : `${unreadable} workflow run row(s) could not be read`,
      }
    },
  }
  return client
}
