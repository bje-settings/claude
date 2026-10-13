// The `gh` client: the interface the commands are written against, and the
// real implementation of it.
//
// The interface and its query and result types were declared in
// `harness/gh.ts` at #124, and moved here at #125. The harness imports them
// back, and keeps `createGhMock`, which is test code and does not ship. The
// endpoints are named after the operation the caller wants, not after gh's
// argv, so the interface still works when gh changes a flag. Inputs and
// outputs stay plain JSON values. A domain type invented here would be
// invented from nothing, and the commands that consume these answers (#127
// layers 2 and 3) shape the values with their own types.
//
// Failure is a thrown `Error`, not a result envelope, for three reasons
// `harness/gh.ts` already committed to. An unregistered endpoint in the mock
// has to throw anyway, so this keeps one shape for everything that goes
// wrong. An envelope would make every endpoint's return a union that every
// caller must narrow, including callers that do not model failure at all.
// The real client also runs `gh` as a child process, where a non-zero exit
// with stderr is exactly an exception. A command turns what it catches into
// an `envelope.ts` outcome, which is where the exit code is decided.
//
// **The transport is `process.ts` now.** #154 carried a private `execFile`
// adapter here, and said in as many words that it was not the process
// runner. #127 is the runner's first consumer, and this is where the adapter
// goes: one place that starts children, one account of what a child did, and
// no 64 MiB `maxBuffer` to get wrong, because `spawn` reads a pipe until it
// ends, rather than fill a fixed buffer.
//
// This file ships. It imports nothing outside the root lib, and stays inside
// the erasable subset (ADR 001).

//
// **The Python this file ports was deleted at #127.**
// `plugins/gh/scripts/*.py`, its `lib/`, and `plugins/gh/hooks/hook-io.py`
// are gone from the tree. The file and line references below point to what
// they held at `cd0d515`. Each reference stays because it says where a rule
// came from. Nothing here changed with the deletion.
import { type Runner, type RunResult, run } from './process.ts'

/** Filters `gh pr list` applies server-side, as the plugins pass them today. */
export interface PullRequestQuery {
  state?: string
  base?: string
  head?: string
  /** `gh-shepherd-status.py:172` asks for the `dependencies` label. */
  label?: string
  /** Left out, gh substitutes 30. This field is optional here, but required
   *  on {@link MergedPullRequestQuery}. Neither consumer of this query
   *  compares the row count against the window (`gh-shepherd-status.py:173`
   *  passes a number and reads the rows), so there is no saturation reader
   *  here to protect. Revisit this if layer 2's port of that script grows
   *  one. */
  limit?: number
}

/**
 * The merged-pull-request window `gh-sync-repo.py:292` asks for.
 *
 * `base` is required, because the whole point of the query is to filter it
 * server-side. A pull request that merged into some other branch is not proof
 * that a local branch landed on the default one; `lib/prs.py` says so in its
 * header. `head` narrows the query to one branch, which is the single-branch
 * fallback at `gh-sync-repo.py:493`.
 *
 * `limit` is required for the same reason `watchChecks.boundMs` is (round 5's
 * handoff fact 1, one field over). It is the number the caller compares the
 * row count against, to find out whether the window saturated. Left out, it
 * is gh's own default of 30, with nothing to say so: a truncated list read
 * as a complete one.
 *
 * Both Python call sites pass a limit, and both compare the row count
 * against it: `gh-sync-repo.py:35` sets `PR_LIMIT = 200`, and compares with
 * `pr_bulk_saturated = len(rows) >= PR_LIMIT` at `:463` ("a saturated window
 * is a window, not an answer"). `gh-sync-repo.py:41` sets
 * `PR_BRANCH_LIMIT = 100`, and compares with `if len(rows) >=
 * PR_BRANCH_LIMIT: return False, "crowded"` at `:503` ("concluding 'none at
 * this commit' from a truncated list is the mistake this guard exists to
 * fix"). The saturation flag also turns the per-branch fallback on at all
 * (`:577`), so a caller that lost the flag would lose the fallback with it.
 * Nothing here asks a caller for something it does not already have.
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
  /** Left out, gh substitutes 30. This field is optional for the reason
   *  given on {@link PullRequestQuery.limit}: `gh-shepherd-status.py:195`
   *  passes a sample size. It reads the rows, and does not measure the
   *  window. */
  limit?: number
}

/**
 * What a bounded `gh pr checks --watch` did.
 *
 * The watch reports on the checks **through its exit status**. So, unlike
 * every other endpoint here, a non-zero status is an answer, not a failure:
 * 0 means all passed, 1 means a check failed, 8 means still pending
 * (`gh-shepherd-pr.py:177`'s `WATCHER_CODES`). 1 is also gh's own generic
 * failure code, so "one check failed" and "gh could not reach GitHub" arrive
 * as the same number. The caller needs {@link problem} to tell them apart.
 * That is round 5's handoff fact 2. It is why this endpoint answers with a
 * record, not a list: an endpoint that threw on 1 would report a red rollup
 * as a broken token, and one that swallowed 1 would report a broken token as
 * a red rollup.
 *
 * There is deliberately no check list here. The one consumer,
 * `gh-shepherd-pr.py:668` to `690`, re-reads the pull request afterwards "in
 * every case", and decides "from the rollup rather than the watcher's exit
 * code". That re-read is {@link GhClient.viewPullRequest}. A second
 * `gh pr checks --json` call inside this endpoint would be a round trip that
 * consumer never reads, and it fails outright on a pull request with no
 * checks at all.
 */
export interface WatchResult {
  /** gh's own exit status, or `null` when a signal ended the watch. That is
   *  what it looks like when the bound fires. */
  readonly status: number | null
  /** Whether the bound fired. `run_bounded` publishes this as status 124,
   *  the way coreutils `timeout` does (`gh-shepherd-pr.py:250`). That
   *  translation belongs to the caller that publishes a status. */
  readonly timedOut: boolean
  /** How long the watch actually took. "A watcher that returned early did not
   *  wait the bound, and saying it did misleads a caller deciding whether to
   *  wait again" (`gh-shepherd-pr.py:266`). */
  readonly waitedMs: number
  /** What the watch said on stderr, whole: "the only place a watcher that
   *  could not reach GitHub says so, and without it a 502 is
   *  indistinguishable from checks that are still running"
   *  (`gh-shepherd-pr.py:255`). To tail this text, or reduce it to one line,
   *  is the caller's own formatting job, not the transport's. */
  readonly problem: string
}

/** The three states GraphQL reports for an issue or a pull request. */
export type IssueState = 'OPEN' | 'CLOSED' | 'MERGED'

/**
 * One open milestone, with the two counts a sweep reports beside it.
 *
 * This is a named shape, not the plain JSON row the older endpoints answer
 * with, for the same reason `issueStates` is also shaped. The query is
 * written here, so the fields are this file's own promise, not gh's. A
 * caller that had to re-derive `openIssues` from an untyped record would
 * re-derive something this file already knows.
 */
export interface MilestoneSummary {
  readonly number: number
  readonly title: string
  /** Open issues on the milestone. Pull requests are not counted: the
   *  connection is asked for `issues`, which on GitHub excludes them. */
  readonly openIssues: number
  readonly closedIssues: number
}

/** One issue or pull request that a relationship field points at: the number
 *  and the state. That is all a blocker graph needs. */
export interface IssueRef {
  readonly number: number
  readonly state: IssueState
}

/** One open issue, as a sweep reads it.
 *
 *  `blockedBy` and `blocking` are GitHub's issue-dependency relationships.
 *  They exist in GraphQL alone. That is why these endpoints use
 *  `gh api graphql`, not `gh issue list`. */
export interface IssueSummary {
  readonly number: number
  readonly title: string
  /** The milestone, or null for an issue on none. */
  readonly milestone: { readonly number: number; readonly title: string } | null
  readonly labels: readonly string[]
  readonly blockedBy: readonly IssueRef[]
  readonly blocking: readonly IssueRef[]
  /** The pull requests that would close this issue, including closed ones. A
   *  sweep uses this list to see that work on the issue has already opened. */
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

/** One comment's first line and when it was made. A round reads only the
 *  first line of a plan or a round-end comment, so the rest of the body is
 *  not kept. */
export interface CommentLine {
  readonly createdAt: string
  readonly firstLine: string
}

/** One issue that carries a round's plan comment, with the first line of
 *  each comment, oldest first. `truncated` is true when the issue has more
 *  comments than the read asked for, so the oldest ones are not here. */
export interface IssueComments {
  readonly number: number
  readonly state: IssueState
  /** The milestone's number, or null for an issue on none. */
  readonly milestone: number | null
  readonly comments: readonly CommentLine[]
  readonly truncated: boolean
}

/**
 * One open pull request's head commit, and the checks reported on it.
 *
 * This is a row of its own, not a wider {@link PullRequestSummary}. The
 * sweep's acceptance test replays `listOpenPullRequests` by its exact argv,
 * query text included. A wider query there would change what the sweep
 * gets. The sweep does not ask this question (round 10 ruling P8).
 */
export interface PullRequestHead {
  readonly number: number
  readonly title: string
  readonly head: string
  /** The head commit's full oid. A caller compares it whole: a short oid
   *  once made a known head read as new. */
  readonly headSha: string
  readonly base: string
  readonly draft: boolean
  /** Whether the head branch is in a fork. A fork's branch name says
   *  nothing about a branch of this repository with the same name. */
  readonly crossRepository: boolean
  /** Every check reported on the head commit, in the order GitHub lists
   *  them. Empty for a head nothing has reported on yet. */
  readonly checks: readonly CheckContext[]
}

/**
 * One open pull request as a link of a stack: its head, its base, and
 * whether the head is in a fork.
 *
 * This is a row of its own for the reason {@link PullRequestHead} gives,
 * and it carries no checks. A walk down a stack needs only the branch
 * names. A row with more checks than one page holds would make its whole
 * read short, for a fact the walk does not use (#398).
 */
export interface PullRequestLink {
  readonly number: number
  readonly head: string
  readonly base: string
  /** Whether the head branch is in a fork. A fork's branch name says
   *  nothing about a branch of this repository with the same name. */
  readonly crossRepository: boolean
}

/**
 * One status check reported on a commit, whichever of the two kinds GitHub
 * reports it as.
 *
 * A check run and a commit status are different objects, with different
 * field names (`name`/`conclusion` against `context`/`state`). A required
 * context may be either kind, so this file reads both into one shape here,
 * rather than leave every caller to handle both. `conclusion` is null while
 * the check has not concluded. That null is the difference between "pending"
 * and "failed" that a caller reads before it decides anything.
 */
export interface CheckContext {
  readonly name: string
  /** `COMPLETED`, `IN_PROGRESS`, `QUEUED`, or null for a commit status, which
   *  reports no status of its own. */
  readonly status: string | null
  /** `SUCCESS`, `FAILURE`, `SKIPPED` and the rest, or null while the check has
   *  not concluded. */
  readonly conclusion: string | null
  /** When the check started: a check run's `startedAt`, a commit status's
   *  `createdAt`, or null when GitHub answers neither. A re-run adds a
   *  second check under the same name, and this field is how a reader
   *  tells the new one from the one a `gh stack push` cancelled. */
  readonly startedAt: string | null
  /** The workflow run that made this check. Absent for a commit status,
   *  and for a check run that no workflow made: GitHub answers a null
   *  `workflowRun` for it. Also absent when the run lacks a field. A newer
   *  run of the same workflow on the same head can supersede a cancelled
   *  run (#364). */
  readonly run?: CheckWorkflowRun
}

/** The workflow run behind one check run, read through its check suite. */
export interface CheckWorkflowRun {
  /** The run's `databaseId`, the same id `actions/runs` names. Of two
   *  runs created in the same second, the newer one has the larger id. */
  readonly id: number
  /** The workflow's `databaseId`. Two workflow files can have the same
   *  name, so this id, not the name, tells one workflow from another. */
  readonly workflowId: number
  /** The workflow's own name, for a reader. */
  readonly workflow: string
  /** When the run was created. Of two runs of one workflow on one head,
   *  the later one is the newer run. */
  readonly createdAt: string
  /** The check suite's conclusion, such as `SUCCESS` or `CANCELLED`, or
   *  null while the run has not concluded. GraphQL's `WorkflowRun` has no
   *  conclusion field of its own. */
  readonly conclusion: string | null
}

/** One UNRESOLVED review thread's first comment: who opened it, and whether
 *  that account is a bot (`author.__typename === "Bot"`). `bot` is false
 *  for a thread whose author GitHub no longer names. That is the safe
 *  side: an unknown author still holds the review loop at `fixing`, as a
 *  person's thread does. */
export interface UnresolvedThread {
  readonly author: string
  readonly bot: boolean
}

/**
 * One pull request, with the facts a review loop derives its state from.
 *
 * This is not {@link GhClient.viewPullRequest}, which answers the shepherd's
 * `--json` field list. That list carries neither ref name, and carries no
 * review threads at all, because thread resolution exists in GraphQL alone.
 * A wider list would change what every consumer that already uses it
 * receives, for a question none of them asked. `listOpenPullRequests`
 * already follows this same rule.
 *
 * The threads and the comments hold one entry per thread and one entry per
 * comment. From these, a caller reports both a count and who still waits
 * on it. They are separate fields because they are separate facts: the
 * enterprise coverage bot posts a COMMENT on every pull request here, and
 * a loop that counted it as an unresolved review thread would never reach
 * `done`.
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
  /** `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`, as GitHub answers it. Carried
   *  as the string GitHub uses, not as a boolean, because `UNKNOWN` means
   *  GitHub has not yet decided the mergeability. It is not a third kind of
   *  "no". */
  readonly mergeable: string
  /** Every check reported on the head commit, in the order GitHub lists them.
   *  Empty for a head no check has reported on yet. */
  readonly checks: readonly CheckContext[]
  /** One row per UNRESOLVED review thread, from the thread's first comment.
   *  See {@link UnresolvedThread}. */
  readonly unresolvedThreads: readonly UnresolvedThread[]
  /** One login per issue comment on the pull request. */
  readonly commentAuthors: readonly string[]
}

/** One workflow run, as `actions/runs` reports it. */
export interface WorkflowRun {
  /** The run's `id`, the same number as {@link CheckWorkflowRun.id}. Of two
   *  runs created in the same second, the newer one has the larger id. */
  readonly id: number
  /** The workflow's `workflow_id`, the same number as
   *  {@link CheckWorkflowRun.workflowId}. */
  readonly workflowId: number
  /** When the run was created, the same field as
   *  {@link CheckWorkflowRun.createdAt}. A run that made no check yet is
   *  visible only here (#370). */
  readonly createdAt: string
  /** The run's name, which is the workflow's `name:` (`CI` here). */
  readonly name: string
  /** `pull_request`, `push`, `pull_request_target`, and the rest. A caller
   *  that confirms a pull request's checks are active reads this field: a
   *  `pull_request_target` run on the same head is a different workflow. */
  readonly event: string
  readonly headSha: string
  readonly status: string
  /** Null while the run has not concluded. */
  readonly conclusion: string | null
  /** When the run actually started. A duration is measured from this field,
   *  not from `created_at`, which can precede it by the queue wait. */
  readonly startedAt: string
  readonly updatedAt: string
}

/** How the head of a compare relates to its base, in GitHub's own words.
 *  `ahead` and `identical` mean the base is an ancestor of the head. */
export type CompareStatus = 'ahead' | 'behind' | 'diverged' | 'identical'

/** One `<base>...<head>` compare, as `compareCommits` reads it. */
export interface CommitComparison {
  readonly status: CompareStatus
  /** The path of each changed file. A renamed file gives its old path too. */
  readonly files: readonly string[]
  /** True when the file list has GitHub's limit of entries (300). Then the
   *  list can be short, and cannot prove that a path did not change. */
  readonly filesAtLimit: boolean
}

/** One commit status on a commit of a pull request, as
 *  `listPullRequestStatuses` reads it. GitHub gives only the newest status
 *  of each context on one commit. */
export interface CommitStatus {
  /** The full oid of the commit that carries the status. */
  readonly commit: string
  readonly context: string
  /** Null when the status has no description. */
  readonly description: string | null
  readonly createdAt: string
}

/** The four states a commit status can have (REST, "Create a commit
 *  status"). */
export type CommitStatusState = 'error' | 'failure' | 'pending' | 'success'

/**
 * What a paginated GraphQL read answers with: the rows it could read, and the
 * reason it could not read more. This is the shape {@link
 * GhClient.issueStates} established.
 *
 * `unavailable` sits beside the rows, rather than a throw, for that
 * endpoint's own reason taken one step further. A sweep asks about several
 * milestones at once, and one page that could not be read must not cost
 * every other answer. A row left out is therefore never silence: the count
 * of unreadable rows folds into `unavailable` too.
 */
export interface PagedResult<T> {
  readonly rows: readonly T[]
  readonly unavailable: string | null
}

/** The head of one merged pull request, as the status line reads it. */
export interface MergedHead {
  readonly headRefName: string
  readonly headRefOid: string
  readonly isCrossRepository: boolean
}

/**
 * One repository's GitHub side, for the gh plugin's status line. Each field
 * is `null` when the reply did not give it in the shape the query asked
 * for. So one field that could not be read costs only that field.
 */
export interface RepositoryStatus {
  /** Open Dependabot alerts. */
  readonly alerts: number | null
  /** Open pull requests that Dependabot opened. */
  readonly dependencies: number | null
  /** The last 100 merged pull requests, most recently updated first. */
  readonly mergedPullRequests: readonly MergedHead[] | null
}

/** What each endpoint answers with. One entry per operation, so the reply map
 *  and the client cannot drift apart. */
export interface GhResults {
  /** Pull requests that match the query, projected as JSON rows. */
  listPullRequests: unknown[]
  /** Merged pull requests, as `lib/prs.py` reads them. */
  listMergedPullRequests: unknown[]
  /** One pull request's own fields. */
  viewPullRequest: Record<string, unknown>
  /** The repository's own fields: default branch and `nameWithOwner`. */
  viewRepository: Record<string, unknown>
  /** Workflow runs that match the query, as JSON rows. */
  listRuns: unknown[]
  /** The log of a run's failed steps, as text. */
  readFailedRunLog: string
  /** Whatever the update printed. The verdict is that it did not throw. */
  updateBranch: string
  /** Whatever gh printed when it posted the comment. */
  addComment: string
  /** What the bounded watch did. */
  watchChecks: WatchResult
  /** Every requested number's state, resolved through one or more `gh api
   *  graphql` calls. `not_found` applies only to a number GraphQL names
   *  outright as gone. Any other unresolved number is left out of `states`,
   *  with its reason folded into `unavailable` instead. So a permissions
   *  error or a timeout is never reported as "this issue does not exist"
   *  (see {@link GhClient.issueStates}). */
  issueStates: {
    readonly states: Readonly<Record<string, IssueState | 'not_found'>>
    readonly unavailable: string | null
  }
  /** The repository's open milestones. */
  listMilestones: PagedResult<MilestoneSummary>
  /** Open issues, with their dependency relationships. */
  listIssues: PagedResult<IssueSummary>
  /** The open issues that carry a round's plan comment, from a search. */
  searchPlanIssues: PagedResult<IssueComments>
  /** Named issues, open or closed, with their newest comments. */
  readPlanIssues: PagedResult<IssueComments>
  /** Open pull requests, including ones no round opened. */
  listOpenPullRequests: PagedResult<PullRequestSummary>
  /** Open pull requests with their head commits and the checks on them. */
  listOpenPullRequestHeads: PagedResult<PullRequestHead>
  /** Open pull requests as stack links: head, base, and the fork flag. */
  listOpenPullRequestLinks: PagedResult<PullRequestLink>
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
    /** True only when GraphQL named this pull request itself NOT_FOUND.
     *  That means the number does not exist. `lib/README.md` names every
     *  other reason this stays false. */
    readonly missing: boolean
  }
  /** Workflow runs, newest first. */
  listWorkflowRuns: PagedResult<WorkflowRun>
  /** One compare of two commits, or null when it could not be read. */
  compareCommits: {
    readonly comparison: CommitComparison | null
    readonly unavailable: string | null
  }
  /** The statuses with one context prefix on a pull request's commits. */
  listPullRequestStatuses: PagedResult<CommitStatus>
  /** The status GitHub created, as its JSON object. */
  createCommitStatus: Record<string, unknown>
  /** Each repository GitHub answered for, by `owner/name`. A repository with
   *  no answer at all is left out, and the reason goes into `unavailable`. */
  repositoryStatus: {
    readonly repositories: Readonly<Record<string, RepositoryStatus>>
    readonly unavailable: string | null
  }
}

export type GhEndpoint = keyof GhResults

/**
 * A comment's text.
 *
 * `#216` removed the `skip` action, `shepherd-pr`'s only caller that posted
 * from a file. `recreate` posts `@dependabot recreate` as a string
 * (`gh-shepherd-pr.py:533`), and it is the one caller left.
 */
export type CommentText = { readonly body: string }

/** The operations the plugins ask `gh` for. `createGhClient`, below,
 *  implements it, and so does `createGhMock` in the harness. A command takes
 *  one as an argument, and never builds one itself. That is what makes it
 *  swappable at all. */
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
    /** Required, and not defaulted. `gh pr update-branch` with no `--rebase`
     *  writes a MERGE COMMIT onto someone's head branch, so an omitted flag
     *  here is a write nobody asked for. The one ported call site passes
     *  this flag unconditionally (`gh-shepherd-pr.py:483`; `:19` names the
     *  whole subcommand "rebase    gh pr update-branch --rebase"). `false`
     *  is still an available value, so nothing here asks a caller for
     *  something it does not already have. This field has the same shape as
     *  `watchChecks.boundMs`: an optional field whose omission would select
     *  the behaviour no consumer wants. */
    rebase: boolean
  }): Promise<GhResults['updateBranch']>
  addComment(comment: { pullRequest: number } & CommentText): Promise<GhResults['addComment']>
  watchChecks(pull: {
    pullRequest: number
    /** gh's refresh interval, in SECONDS, the unit
     *  `gh pr checks -i, --interval int` takes. This field is named
     *  `interval` because it sits beside `boundMs`, and a caller that passed
     *  milliseconds here would get a poll interval measured in hours, with
     *  nothing to say so. No ported call site sets it: `gh-shepherd-pr.py:645`
     *  to `655` passes `--watch --fail-fast`, and takes gh's default of 10. */
    interval?: number
    /** The bound, in milliseconds. See {@link RunOptions.timeoutMs} for what
     *  `number` admits that a bound does not. This field is required,
     *  because round 5's handoff fact 1 is that #154 left this call
     *  unbounded, and "a watch that cannot return is worse than no watch".
     *  Made optional, it would be that same defect one line away, and
     *  `process.ts` only detaches a bounded child, so an unbounded watch
     *  could not even be group-killed. The one ported call site already has
     *  a bound (`gh-shepherd-pr.py:637`), so nothing here asks a caller for
     *  something it does not already have. */
    boundMs: number
    failFast?: boolean
  }): Promise<GhResults['watchChecks']>
  /**
   * Every number's state: open, closed, merged, or not found. This method
   * reads the repository from {@link GhClient.viewRepository}, rather than
   * take one as an argument, because the one caller (tier 0 of the context
   * audit, #170) has already resolved the checkout, and wants the same
   * repository every other endpoint here answers about.
   *
   * Never throws. A number GraphQL cannot place at all, such as one in a
   * private repository this token cannot see, or one lost to a rate limit
   * or a timeout, is left out of `states`, with its reason folded into
   * `unavailable`. A report of such a number as `not_found` would fabricate
   * a finding out of a failure to ask.
   */
  issueStates(query: { readonly numbers: readonly number[] }): Promise<GhResults['issueStates']>
  /**
   * The repository's open milestones, with their open and closed issue
   * counts. Never throws, for {@link PagedResult}'s reason.
   */
  listMilestones(): Promise<GhResults['listMilestones']>
  /**
   * Open issues, with their labels, their `blockedBy` and `blocking`
   * relationships, and the pull requests that would close them.
   *
   * `milestone` is GitHub's own `milestoneNumber` filter, given as a string
   * because that is the type the filter declares. Left out, this method
   * answers for every open issue. That is also how a caller reads the issues
   * on no milestone at all: `milestoneNumber: "none"` is NOT that query.
   * Verified against the API on 2026-09-21: that filter matches nothing, not
   * the unassigned issues. The caller filters on `milestone === null`
   * instead.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listIssues(query?: { readonly milestone?: string }): Promise<GhResults['listIssues']>
  /**
   * The open issues with a comment that contains the words `plan, approved`,
   * with the first line of each of their 100 newest comments.
   *
   * This is a GitHub search, newest update first. A comment made in the
   * last minute or so can be absent, because the search index is not
   * immediate. Past 500 issues, the read stops and says so. Never throws,
   * for {@link PagedResult}'s reason.
   */
  searchPlanIssues(): Promise<GhResults['searchPlanIssues']>
  /**
   * Named issues, open or closed, with the first line of each of their 100
   * newest comments. This reads each issue directly, so it sees a new
   * comment at once. A number that is not a positive whole number, or not
   * an issue, is named under `unavailable`. An empty list reads nothing.
   * Never throws, for {@link PagedResult}'s reason.
   */
  readPlanIssues(numbers: readonly number[]): Promise<GhResults['readPlanIssues']>
  /**
   * Every open pull request: number, title, head, base, and draft.
   *
   * This is not {@link GhClient.listPullRequests}, whose field list answers
   * the shepherd, and carries neither `headRefName` nor `baseRefName`.
   * A wider list would change what every consumer that already uses it
   * receives, for a question none of them asked. So this is its own
   * endpoint, with its own query.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listOpenPullRequests(): Promise<GhResults['listOpenPullRequests']>
  /**
   * Every open pull request, with the full oid of its head commit and the
   * checks on that commit. One paginated read answers it all.
   *
   * A watch asks this once for each poll, not once for each pull request.
   * So one poll is one view of every head, taken at one time. A row with
   * more checks than one page holds is left out, and counted in
   * `unavailable`. A list cut short could leave out the one required
   * context that failed.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listOpenPullRequestHeads(): Promise<GhResults['listOpenPullRequestHeads']>
  /**
   * Every open pull request as a stack link: number, head, base, and
   * whether the head is in a fork. It reads no checks, so only a row of
   * the wrong shape makes it short.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listOpenPullRequestLinks(): Promise<GhResults['listOpenPullRequestLinks']>
  /**
   * The status-check contexts every ruleset that applies to `branch`
   * requires, unioned, and in the order the rules name them.
   *
   * This endpoint uses REST (`repos/{owner}/{name}/rules/branches/{branch}`),
   * not GraphQL, which exposes no equivalent. It asks per branch, not per
   * repository, because REST answers for the rules that actually apply to
   * one ref. A stacked pull request based on a topic branch must pass
   * nothing at all by the rulesets, while the same head based on the default
   * branch must pass every context. A caller that hard-coded the default
   * branch's list would report the wrong answer for exactly the pull
   * requests a stack is made of.
   *
   * An EMPTY list is an answer, not a failure: it says no ruleset requires
   * anything of that branch. Never throws, for {@link PagedResult}'s reason.
   */
  requiredContexts(query: { readonly branch: string }): Promise<GhResults['requiredContexts']>
  /**
   * One pull request's refs, head commit, draft flag, mergeability, reported
   * checks, unresolved review threads, and comments, in one round trip.
   *
   * Never throws, for {@link PagedResult}'s reason. A review loop reads this
   * on every tick, and a read that failed is a tick that waits, not a loop
   * that dies. A pull request the reply does not carry is `null`, with the
   * reason beside it.
   */
  viewPullRequestDetail(pull: {
    readonly pullRequest: number
  }): Promise<GhResults['viewPullRequestDetail']>
  /**
   * Workflow runs, newest first, through `actions/runs`.
   *
   * This is not {@link GhClient.listRuns}, whose `--json` field list carries
   * neither `event` nor the head commit. So a caller cannot tell a
   * `pull_request` run from a `push` run, nor tell which head either ran on.
   * `branch` is the filter this REST endpoint applies server-side.
   * `head_sha` is NOT used: it once answered nothing for a head whose runs
   * did exist (round 7 finding 6), while `branch` answered.
   *
   * This reads ONE page, newest first, and does not claim to be a complete
   * list. `perPage` is the bound, and nothing reports that the repository
   * holds more, because every caller wants recent runs, not all of them
   * (this repository had 1,733 runs when that was measured). Ask this
   * endpoint only what the newest page can answer, such as whether a run
   * exists for the head that was just pushed, or how long recent runs took.
   * `unavailable` is for a row that could not be READ.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listWorkflowRuns(query?: {
    readonly branch?: string
    readonly perPage?: number
  }): Promise<GhResults['listWorkflowRuns']>
  /**
   * The compare of `<base>...<head>` through REST
   * (`repos/{owner}/{name}/compare/{base}...{head}`): how the head relates to
   * the base, and the files that changed.
   *
   * It asks for one commit per page. The file list comes only on the first
   * page, and the commits are not read. GitHub gives 300 files at most, so a
   * list of that length sets `filesAtLimit`.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  compareCommits(query: {
    readonly base: string
    readonly head: string
  }): Promise<GhResults['compareCommits']>
  /**
   * The commit statuses whose context starts with `prefix`, on the first 100
   * commits of one pull request, oldest commit first (#377). Each row
   * carries its commit, context, description and `createdAt`, and nothing
   * else.
   *
   * GitHub gives only the newest status of each context on one commit
   * (`Status.contexts`, measured on 2026-10-13). A pull request with more
   * than 100 commits keeps the rows read, and `unavailable` says that a
   * later commit was not read. A commit whose status does not have the
   * shape asked for is counted in `unavailable`, never dropped.
   *
   * Never throws, for {@link PagedResult}'s reason.
   */
  listPullRequestStatuses(query: {
    readonly pullRequest: number
    readonly prefix: string
  }): Promise<GhResults['listPullRequestStatuses']>
  /**
   * Write one commit status on `sha`, through REST
   * (`POST repos/{owner}/{name}/statuses/{sha}`). A status cannot be
   * deleted. GitHub keeps 1000 statuses at most for one sha and context.
   *
   * Throws a {@link GhError} when gh fails, as the other writes here do.
   */
  createCommitStatus(status: {
    readonly sha: string
    readonly context: string
    readonly state: CommitStatusState
    /** Left out, the status has no description. */
    readonly description?: string
  }): Promise<GhResults['createCommitStatus']>
  /**
   * Open Dependabot alerts, open Dependabot pull requests, and the last
   * 100 merged pull requests, for each `owner/name` in `repos`.
   *
   * One aliased `gh api graphql` query asks about five repositories at
   * most. The queries go at the same time, and each one stops at `boundMs`.
   *
   * Never throws. A query that failed costs only its own repositories, and
   * a field that failed costs only that field. The reason goes into
   * `unavailable`.
   */
  repositoryStatus(
    repos: readonly string[],
    options: { readonly boundMs: number },
  ): Promise<GhResults['repositoryStatus']>
}

/**
 * What every endpoint here throws.
 *
 * Round 5's handoff fact 3: #154 threw a plain `Error` that carried gh's
 * words, with neither its exit status nor a cause, so a caller could only
 * branch on prose. `status` is gh's own exit status (or the shell's 127 and 126 when gh
 * could not start at all, which is `lib/install.py`'s convention that
 * `process.ts` keeps). `cause` is the whole {@link RunResult}, so a caller
 * that needs stderr, the signal, or the elapsed time has them, and this
 * class needs no new field per question.
 *
 * Every member is public. `tsc` sees a class exported from `lib/` under two
 * identities: its real path, and the copy at `plugins/<p>/src/lib/gh.ts`
 * (ADR 006). A `private` or `protected` member would make it nominal
 * per declaration, so the two identities would no longer be assignable to
 * each other (round 5's rule, reproduced on #156). `cause` is `Error`'s own public
 * property, and is set through `super`.
 */
export class GhError extends Error {
  /** gh's exit status, or `null` when a signal ended it. `0` is its own case,
   *  and a real one: gh succeeded, and its answer could not be read, either
   *  because it was not JSON or because it was not the shape the endpoint
   *  promises. A caller that reads `status !== 0` as "gh failed" would take a
   *  malformed answer for a good one. Branch on whether the error reaches
   *  you at all, and use `status` only to say which failure it was. */
  readonly status: number | null

  /**
   * The account of the failure WITHOUT the `gh <argv> failed: ` prefix the
   * message carries, so a report that quotes gh quotes gh alone.
   *
   * A caller that prints a one-line reason reads this field, never
   * `message`. The Python's `gh_json` prints `last_line(stderr)`, and stderr
   * for the ordinary refusal is a single line ("gh: API rate limit
   * exceeded"). So a tail of `message` returns the WHOLE message, argv and
   * all, and only a MULTI-line stderr happens to reduce to the Python's
   * wording. That is the defect `plugins/gh/src/subcommands/sync-repo.ts` found
   * at #159: a rate limit put forty characters of `--json` fields inside a
   * report line.
   *
   * It is the same string for every throw site: {@link accountOf} for a gh
   * that exited non-zero or could not start, and the message itself where
   * the message is already gh's account alone (an answer that is not JSON,
   * or not the shape the endpoint promises).
   *
   * Public like every other member, for the double identity rule above.
   */
  readonly detail: string

  constructor(message: string, status: number | null, options: { cause: unknown; detail: string }) {
    super(message, { cause: options.cause })
    // Set explicitly, not inherited. `Error` names itself after its own
    // constructor. Without this line, a caught failure would report as a
    // plain `Error`.
    this.name = 'GhError'
    this.status = status
    this.detail = options.detail
  }
}

export interface GhClientOptions {
  /**
   * Where `gh` runs. `gh` resolves the repository from the working directory
   * when nothing names one. `gh-sync-repo.py` relies on this, after it has
   * changed into the checkout with `chdir`.
   */
  readonly cwd?: string
  /**
   * `owner/name`, named on every call. Round 5's handoff fact 4: the ported
   * scripts name the repository at eight call sites (`gh-shepherd-pr.py:399`,
   * `:483`, `:533`, `:647`, `:726`, `:928` and `gh-shepherd-status.py:163`,
   * `:185`), because they run from wherever the agent started, not from the
   * checkout.
   *
   * This option reaches gh as `--repo` everywhere except `gh repo view`.
   * That command has no `--repo` flag, and takes the repository as its
   * positional argument instead (`gh repo view [<repository>]`, verified
   * against gh 2.98.0: the flag form is refused with "unknown flag:
   * --repo"). That is also why the two Python `repo view` calls,
   * `gh-shepherd-pr.py:959` and `gh-shepherd-status.py:104`, are the only two
   * of the ten that pass no `--repo`.
   */
  readonly repository?: string
  /**
   * The child's whole environment. Left out, `gh` inherits this process's
   * own environment, which is what every ported call site gets today.
   *
   * This option exists because `GH_REPO` does to `cwd` exactly what
   * `GIT_DIR` does (`gh help environment`: "specify the GitHub repository in
   * the `[HOST/]OWNER/REPO` format for commands that otherwise operate on a
   * local repository"). The mode it displaces is the one
   * `gh-sync-repo.py:250` uses: no `repository`, changed into the checkout
   * with `chdir`, and gh resolves the rest from there. `GH_HOST`,
   * `GH_TOKEN`, and `GH_CONFIG_DIR` are the same class of variable, which is why
   * `harness/sandbox.ts` strips every `GH_` key before a test runs anything.
   *
   * This field is optional, not required, unlike `RepoOptions.env` next
   * door. The other two fields here are optional, no ported call site pins
   * an environment, and, as with that one, naming an environment buys only
   * the naming, not the scrubbing. A caller inside a hook, or anywhere else
   * that inherited a `GH_REPO` it did not choose, passes an environment
   * without it.
   */
  readonly env?: NodeJS.ProcessEnv
  /** The spawn seam. Defaults to the root lib's own process runner.
   *
   *  This is a parameter, not a hardcoded import, so that this file's suite
   *  drives every endpoint, and every arm of the failure each one reports,
   *  in-process, with nothing spawned and no `gh` on the machine. The
   *  runner itself is the thing tested against real children
   *  (`tests/lib/process.test.ts`); a copy of that test here would only prove node
   *  twice. */
  readonly run?: Runner
  /**
   * The time limit, in milliseconds, for every call this client makes.
   * A call that already carries its own bound keeps it instead
   * (`watchChecks.boundMs`, `repositoryStatus`'s second argument).
   *
   * Left out, a call waits for `gh` as long as it takes. That was the
   * mode of every endpoint before this option existed. It is still the
   * mode the `gh` plugin uses (ruling 4, #295).
   *
   * `watch` sets this, fit to its own poll interval. So a hung `gh` child
   * cannot outlast one whole poll cycle. `lib/process.ts`'s `timeoutMs`
   * kills a bounded child's whole process group when the bound fires. The
   * failure this produces is a failed read, reported as itself, never a
   * silent wait.
   */
  readonly boundMs?: number
}

/**
 * The `--json` field lists, taken from the scripts that ask for them today.
 * `PULL_REQUEST_FIELDS` matches `plugins/gh/scripts/lib/shepherd.py`'s
 * `PR_FIELDS`: `gh-shepherd-pr.py`'s `read_pr` and `gh-shepherd-status.py`'s
 * pull-request query both ask for exactly this list.
 * `MERGED_PULL_REQUEST_FIELDS` matches `lib/prs.py`'s `FIELDS` for the merged
 * window. `REPOSITORY_FIELDS` and `RUN_FIELDS` match `gh-shepherd-status.py`'s
 * repository and run queries. The run list adds the run's identity and
 * outcome to the two timestamps that script reads, because a run row with no
 * id cannot be followed to `readFailedRunLog`, the next endpoint in this
 * same interface.
 */
const PULL_REQUEST_FIELDS =
  'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
  'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision'
const MERGED_PULL_REQUEST_FIELDS = 'headRefName,headRefOid,isCrossRepository'
const REPOSITORY_FIELDS = 'nameWithOwner,defaultBranchRef'
const RUN_FIELDS = 'databaseId,status,conclusion,createdAt,updatedAt'

/** How many numbers `issueStates` puts in one `gh api graphql` call. This is
 *  a conservative batch size, not a documented limit. GitHub rejects a
 *  query by node count and complexity, not by a fixed number of aliases, and
 *  100 `state` fields sit far below either limit (the context-audit spike,
 *  #164). */
const ISSUE_BATCH = 100

/** How many nodes one page of a paginated sweep query asks for. 100 is the
 *  most a GitHub connection accepts in one `first:`. */
const SWEEP_PAGE = 100

/**
 * How many pages one paginated read will ask for, before it stops and says
 * so.
 *
 * A `hasNextPage` field that stays true with a cursor that does not advance
 * is a loop this process would never leave. A command that never returns is
 * worse than a short answer that admits it is short. 20 pages is 2,000 open
 * issues, milestones, or pull requests in one repository, far past anything
 * a round sweeps. This limit, once reached, is reported through
 * `unavailable`, rather than by a silent truncation of the rows.
 */
const SWEEP_PAGES = 20

/**
 * How many workflow runs `listWorkflowRuns` asks for, when the caller names
 * no number. 30 is `actions/runs`' own default page size, written out here
 * so the argv says what it asks for, rather than inherit a number from the
 * API. A caller that measures durations passes its own sample size instead.
 */
const RUN_PAGE = 30

/** Every value {@link IssueState} can hold, as a `Record`, not a bare array
 *  literal. A new member added to the union with no key here to match it is
 *  a `tsc` error: an incomplete `Record<IssueState, true>`. A
 *  `readonly IssueState[]` literal would instead stay valid with a member
 *  missing, and the two would drift apart in silence. */
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

/** How many repositories `repositoryStatus` puts in one query. Each
 *  repository asks for 100 pull requests, so a small batch keeps each query
 *  far below GitHub's node limit. The batches go at the same time, so a
 *  small batch also costs no time. */
const STATUS_BATCH = 5

/** The fields `repositoryStatus` asks about each repository. All of them
 *  are inside the repository node, so they follow its redirect after a
 *  rename or a transfer, and they fail with it. */
const STATUS_FIELDS = `
    vulnerabilityAlerts(states: OPEN) { totalCount }
    open: pullRequests(states: OPEN, first: 100) {
      totalCount
      nodes { author { login } }
    }
    merged: pullRequests(states: MERGED, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { headRefName headRefOid isCrossRepository }
    }`

/** One aliased query for a batch of `owner/name` values. The aliases start
 *  at `r0` in each batch. `JSON.stringify` writes each name as a GraphQL
 *  string, with its quotes escaped. */
const buildStatusQuery = (repos: readonly string[]): string => {
  const fields = repos.map((repo, index) => {
    const slash = repo.indexOf('/')
    const owner = JSON.stringify(repo.slice(0, slash))
    const name = JSON.stringify(repo.slice(slash + 1))
    return `  r${index}: repository(owner: ${owner}, name: ${name}) {${STATUS_FIELDS}\n  }`
  })
  return `query {\n${fields.join('\n')}\n}`
}

/** A `{ totalCount }` field's number, or `null` for any other shape. */
const totalCount = (value: unknown): number | null => {
  const count = asRecord(value)?.totalCount
  return typeof count === 'number' ? count : null
}

/** The login GraphQL gives the Dependabot app as a pull request author. */
const DEPENDABOT = 'dependabot'

/** One open pull request's author login. `null` is an author that GitHub
 *  no longer has. `undefined` is a row that is not the shape asked for. */
const authorLogin = (value: unknown): string | null | undefined => {
  const row = asRecord(value)
  if (row?.author === null) return null
  const login = asRecord(row?.author)?.login
  return typeof login === 'string' ? login : undefined
}

/**
 * How many open pull requests Dependabot opened, or `null` when the list
 * cannot give the answer.
 *
 * `Repository.pullRequests` cannot filter by author, and a label can be on
 * a pull request that someone else opened. So this counts the authors of
 * the first 100 open pull requests. A repository with more than 100 open
 * pull requests gives `null`, not a count that is too low. A search can
 * filter by author, but it does not follow a redirect, and one failed
 * search makes all of `data` null.
 */
const dependabotCount = (value: unknown): number | null => {
  const total = totalCount(value)
  const nodes = asRecord(value)?.nodes
  if (total === null || !Array.isArray(nodes) || nodes.length < total) return null
  const logins = nodes.map(authorLogin)
  if (logins.includes(undefined)) return null
  return logins.filter((login) => login === DEPENDABOT).length
}

/** One merged pull request, or `null` when it is not the shape asked for. */
const mergedHead = (value: unknown): MergedHead | null => {
  const row = asRecord(value)
  const { headRefName, headRefOid, isCrossRepository } = row ?? {}
  return typeof headRefName === 'string' &&
    typeof headRefOid === 'string' &&
    typeof isCrossRepository === 'boolean'
    ? { headRefName, headRefOid, isCrossRepository }
    : null
}

/** A `{ nodes }` field's merged pull requests, or `null` when the list, or
 *  any one row in it, is not the shape asked for. A list that is one row
 *  short could hide the row that proves a squash merge. */
const mergedHeads = (value: unknown): MergedHead[] | null => {
  const nodes = asRecord(value)?.nodes
  if (!Array.isArray(nodes)) return null
  const heads = nodes.map(mergedHead)
  return heads.every((head) => head !== null) ? heads : null
}

/**
 * One batch's reply, by `owner/name`, or the reason there is none.
 *
 * gh exits 1 when any alias fails, and still prints the whole body. So this
 * reads the body whatever the status, the way `issueStates` does. A pipe
 * that failed makes the body untrusted, so the whole batch fails.
 */
const readStatusBatch = (
  result: RunResult,
  repos: readonly string[],
  boundMs: number,
): { repositories: Record<string, RepositoryStatus>; reason: string | null } => {
  if (result.timedOut) return { repositories: {}, reason: `gh did not answer in ${boundMs} ms` }
  let reply: Record<string, unknown> | undefined
  try {
    reply = asRecord(JSON.parse(result.stdout))
  } catch {
    reply = undefined
  }
  const data = asRecord(reply?.data)
  if (data === undefined || result.streamErrors.length !== 0) {
    return { repositories: {}, reason: accountOf(result) }
  }
  const repositories: Record<string, RepositoryStatus> = {}
  repos.forEach((repo, index) => {
    const answer = asRecord(data[`r${index}`])
    if (answer === undefined) return
    repositories[repo] = {
      alerts: totalCount(answer.vulnerabilityAlerts),
      dependencies: dependabotCount(answer.open),
      mergedPullRequests: mergedHeads(answer.merged),
    }
  })
  const errors = Array.isArray(reply?.errors) ? reply.errors : []
  const messages = errors
    .map((entry) => asRecord(entry)?.message)
    .filter((message): message is string => typeof message === 'string')
  return { repositories, reason: joinedReasons(messages) }
}

/**
 * The GraphQL query for a batch of issue and pull-request numbers, in one
 * round trip: one aliased `issueOrPullRequest` field per number. Each field
 * asks for `state` under both possible types, because `gh` cannot tell the
 * caller in advance which of the two a number is. This ports the
 * context-audit spike's `buildIssueQuery` (#164).
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
 * `RATE_LIMITED`, and a timeout are each tagged differently, and a timeout
 * carries no `path` at all, so none of them names an alias here. That is
 * the whole point: only an alias this function returns may be reported
 * absent.
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
 * One chunk's reply, aligned back to `numbers` by alias index, or
 * `undefined` when there is nothing to align against: stdout that is not
 * JSON, or JSON with no `data.repository` object in it. The reason for
 * that `undefined` is not this function's to give. The caller holds the
 * {@link RunResult} the body came from, and reports `accountOf` it, which
 * covers a gh that never started, as well as a body with no repository in
 * it.
 *
 * `states` carries only the numbers the reply actually answered for. A
 * number left out is one the reply gave no usable answer for, and a caller
 * reads that as `unavailable`, never as absent. `errors` is every error
 * message NOT already accounted for by a `not_found` state, because a
 * `NOT_FOUND` on a named alias is a complete answer about that number, not a
 * reason the lookup was unavailable. This function ports the spike's
 * `parseIssueResponse` and `parseIssueChunkBody` (#164). Those were two
 * functions only for the fallback the spike kept for a reply with no `data`
 * wrapper; that fallback is unreachable once a reply needs a
 * `data.repository` to be read at all.
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
 * Owner, name, cursor, and milestone arrive as GraphQL VARIABLES, not
 * interpolated into the query text the way {@link buildIssueQuery} builds
 * its aliases. The aliases have to be text, because a variable cannot name a
 * field; these values do not need to be text. A cursor is also an opaque
 * base64 string from the server, which has no business inside a query body.
 * One query string per endpoint also means the argv gh receives is the same
 * bytes on every page, so a captured fixture can be compared against it.
 *
 * `after: $cursor` with no `cursor` variable supplied is `null`, which asks
 * for the first page. The client omits the variable, rather than pass an
 * empty string.
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

/** How many issues one page of {@link PLAN_ISSUES_QUERY} asks for. Each
 *  issue brings up to {@link PLAN_COMMENTS} whole comment bodies, and a plan
 *  or a sequencing comment can be several kilobytes. So a page is smaller
 *  than {@link SWEEP_PAGE}. */
const PLAN_PAGE = 25

/** How many of an issue's newest comments {@link PLAN_ISSUES_QUERY} reads.
 *  The newest plan is the one a round reads, so the oldest comments are the
 *  ones to lose. */
const PLAN_COMMENTS = 100

/** The fields a round reads of one issue that carries a plan comment. */
const PLAN_FIELDS = `number
        state
        milestone { number }
        comments(last: ${PLAN_COMMENTS}) {
          pageInfo { hasPreviousPage }
          nodes { createdAt body }
        }`

/**
 * The open issues that carry a plan comment, found by a search, because no
 * repository connection filters issues by the text of their comments.
 * `$q` holds the repository, so this query takes no `$owner` or `$name`.
 *
 * Only open issues: a round with no open issue left has nothing to build,
 * and the rounds that ended before the round-end record existed (#368)
 * would otherwise stay in flight for ever. The search words sort by update,
 * newest first, so the page limit in `collect` cuts old issues, not live
 * ones.
 */
const PLAN_ISSUES_QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${PLAN_PAGE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        ${PLAN_FIELDS}
      }
    }
  }
}`

/** The search words for {@link PLAN_ISSUES_QUERY}. `is:issue` keeps pull
 *  requests out. The quotes make the two words one phrase, so they match
 *  only next to each other and in that order. */
const PLAN_SEARCH = 'is:issue is:open "plan, approved" in:comments sort:updated-desc'

/**
 * The same fields for named issues, read directly, with one alias per
 * number. A direct read sees a comment at once, where the search index can
 * take a minute. `readPlanIssues` passes only positive whole numbers, so
 * each one goes into the query as text.
 */
const buildPlanIssueQuery = (numbers: readonly number[]): string => {
  const fields = numbers.map(
    (number, index) => `    i${index}: issue(number: ${number}) {\n        ${PLAN_FIELDS}\n    }`,
  )
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${fields.join('\n')}\n  }\n}`
}

const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title isDraft headRefName baseRefName }
    }
  }
}`

/**
 * Every open pull request's head commit and the checks on it.
 *
 * `headRefOid` is the head commit's oid. `commits(last: 1)` reaches the
 * same commit's rollup, as {@link PULL_REQUEST_DETAIL_QUERY} does. A page of
 * 100 pull requests with 100 checks each is 10,000 nodes, far below
 * GitHub's limit of 500,000.
 */
const PULL_REQUEST_HEADS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title isDraft headRefName headRefOid baseRefName isCrossRepository
        commits(last: 1) { nodes { commit { statusCheckRollup {
          contexts(first: ${SWEEP_PAGE}) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion startedAt
                checkSuite { conclusion workflowRun { databaseId createdAt workflow { databaseId name } } }
              }
              ... on StatusContext { context state createdAt }
            }
          }
        } } } }
      }
    }
  }
}`

/** Every open pull request's head and base, and whether the head is in a
 *  fork. No checks: see {@link PullRequestLink}. */
const PULL_REQUEST_LINKS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${SWEEP_PAGE}, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number headRefName baseRefName isCrossRepository }
    }
  }
}`

/**
 * One pull request's whole state, in one round trip.
 *
 * `commits(last: 1)` is how this query reaches the head commit's rollup. A
 * pull request has no rollup field of its own, and `last: 1` names the head,
 * whatever the branch's length. The three connections each carry `pageInfo`,
 * unlike the dependency connections in {@link ISSUES_QUERY}. Here there IS a
 * page signal to ask for, and a caller that must not under-report an
 * unresolved thread needs to know when the list is short.
 *
 * A review thread's author is the author of its FIRST comment, the comment
 * that opened it. That comment's `__typename` says whether the account is
 * a bot. This is what tells a bot's own thread, a preview workflow or a
 * review bot, apart from a person's (#219).
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
        nodes { isResolved comments(first: 1) { nodes { author { __typename login } } } }
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
                  ... on CheckRun {
                    name status conclusion startedAt
                    checkSuite { conclusion workflowRun { databaseId createdAt workflow { databaseId name } } }
                  }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/**
 * The commit statuses on a pull request's commits (#377). Its own query, not
 * a wider {@link PULL_REQUEST_DETAIL_QUERY}: that query reads only the head
 * commit, and two callers read it on every tick. `first` gives the oldest
 * commits. `Status.contexts` is a list, not a connection, so it has no page
 * to bound.
 */
const PULL_REQUEST_STATUSES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: ${SWEEP_PAGE}) {
        pageInfo { hasNextPage }
        nodes { commit { oid status { contexts { context description createdAt } } } }
      }
    }
  }
}`

/** An integer, or null for anything else. GraphQL answers a count and a
 *  number as JSON numbers. A value that is not one is a reply this file
 *  does not recognise, not a zero to carry on with. */
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
 * This returns null for the whole connection, not just for the bad entry. A
 * blocker list with one entry quietly dropped would report a blocked issue
 * as unblocked, the one mistake a sweep must not make. The caller turns a
 * null into an unreadable row, and reports it that way.
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

/** One comment as its first line, or null when it is not the shape asked
 *  for. */
const readCommentLine = (node: unknown): CommentLine | null => {
  const record = asRecord(node)
  const createdAt = asText(record?.createdAt)
  const body = asText(record?.body)
  if (createdAt === null || body === null) return null
  const end = body.indexOf('\n')
  return { createdAt, firstLine: (end === -1 ? body : body.slice(0, end)).trim() }
}

/** One issue that carries a plan comment, or null when it is not the shape
 *  asked for. A pull request can match the search too. It has no `number`
 *  under the `... on Issue` fragment, so it reads as null here, and the
 *  search asks for `is:issue` so that none arrives. */
const readPlanIssue = (node: unknown): IssueComments | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const state = record?.state
  const commentNodes = nodesOf(record?.comments)
  if (number === null || !isIssueState(state) || commentNodes === null) return null
  const milestone = record?.milestone
  let milestoneNumber: number | null = null
  if (milestone !== null) {
    milestoneNumber = asInteger(asRecord(milestone)?.number)
    if (milestoneNumber === null) return null
  }
  const comments: CommentLine[] = []
  for (const entry of commentNodes) {
    const line = readCommentLine(entry)
    if (line === null) return null
    comments.push(line)
  }
  const info = asRecord(asRecord(record?.comments)?.pageInfo)
  return {
    number,
    state,
    milestone: milestoneNumber,
    comments,
    truncated: info?.hasPreviousPage === true,
  }
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
  // signal of their own. So a list answered at exactly the ceiling cannot be
  // told from the first page of a longer one. The classification reads
  // `blockedBy`, and a blocker list one entry short would report a blocked
  // issue as unblocked, the one mistake a sweep must not make. So this
  // ambiguity is read the same conservative way a malformed entry is: the
  // whole issue is unreadable, and is counted as such.
  //
  // `blocking` is in this rule for its own reason. It classifies nothing,
  // but a caller reads it to say which issues a round unlocks, and which of
  // them the round's comment has to reach, so a truncated `blocking` list
  // would under-claim both in silence. `labels` and
  // `closedByPullRequestsReferences` are read and reported with nothing
  // concluded from their length, so they are left alone.
  if (blockedBy.length === SWEEP_PAGE || blocking.length === SWEEP_PAGE) return null
  const labels: string[] = []
  for (const entry of labelNodes) {
    const name = asText(asRecord(entry)?.name)
    if (name === null) return null
    labels.push(name)
  }
  // An issue on no milestone answers `null` here. A caller that reads the
  // unassigned set needs this null to stay distinct from a milestone whose
  // fields could not be read. A field that is present but
  // is neither an object nor `null` is not "no milestone"; it is a
  // malformed row. This function rejects it like every sibling field,
  // rather than fold it into the no-milestone case.
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

/**
 * One commit's rollup as checks. Null when the rollup is not the shape asked
 * for, or holds more checks than one page. A null rollup is a commit nothing
 * has reported on yet. That is an empty list and not a failure.
 */
const readRollup = (rollup: unknown): CheckContext[] | null => {
  if (rollup === null) return []
  const nodes = nodesOf(asRecord(rollup)?.contexts)
  if (nodes === null) return null
  if (truncated(asRecord(rollup)?.contexts)) return null
  const checks: CheckContext[] = []
  for (const entry of nodes) {
    const check = readCheck(entry)
    if (check === null) return null
    checks.push(check)
  }
  return checks
}

/** One pull request head node, or null when it is not the shape asked for. */
const readPullRequestHead = (node: unknown): PullRequestHead | null => {
  const record = asRecord(node)
  const summary = readPullRequest(node)
  const headSha = asText(record?.headRefOid)
  const crossRepository = record?.isCrossRepository
  if (summary === null || headSha === null) return null
  if (typeof crossRepository !== 'boolean') return null
  const commit = asRecord(asRecord(nodesOf(record?.commits)?.[0])?.commit)
  if (commit === undefined) return null
  const checks = readRollup(commit.statusCheckRollup)
  if (checks === null) return null
  return { ...summary, headSha, crossRepository, checks }
}

/** One pull request link node, or null when it is not the shape asked for. */
const readPullRequestLink = (node: unknown): PullRequestLink | null => {
  const record = asRecord(node)
  const number = asInteger(record?.number)
  const head = asText(record?.headRefName)
  const base = asText(record?.baseRefName)
  const crossRepository = record?.isCrossRepository
  if (number === null || head === null || base === null) return null
  if (typeof crossRepository !== 'boolean') return null
  return { number, head, base, crossRepository }
}

/** Whether a connection said it has a page after the one that was read. */
const truncated = (value: unknown): boolean =>
  asRecord(asRecord(value)?.pageInfo)?.hasNextPage === true

/** A node's author's login, or `unknown` for an author GitHub no longer
 *  names. That is what a deleted account answers with. */
const loginOf = (value: unknown): string => {
  const login = asText(asRecord(asRecord(value)?.author)?.login)
  return login === null ? 'unknown' : login
}

/** Whether a node's author is a bot account (`__typename === "Bot"`). False
 *  for any other value, and for an author GitHub no longer names. An
 *  unknown author is read as a person, never promoted to a bot. */
const isBotAuthor = (value: unknown): boolean =>
  asText(asRecord(asRecord(value)?.author)?.__typename) === 'Bot'

/** The two `StatusState` values that mean a commit status has not concluded. */
const UNCONCLUDED: Record<string, true> = { PENDING: true, EXPECTED: true }

/**
 * The workflow run behind a check run's suite, or null when there is none.
 *
 * A check run that no workflow made, such as an uploaded code scanning
 * result, has a suite whose `workflowRun` is null. A run that lacks a field
 * is read as no run too. That is the safe side: a check with no run is never superseded,
 * so it keeps its own conclusion.
 */
const readCheckWorkflowRun = (value: unknown): CheckWorkflowRun | null => {
  const suite = asRecord(value)
  const run = asRecord(suite?.workflowRun)
  const id = asInteger(run?.databaseId)
  const createdAt = asText(run?.createdAt)
  const workflowId = asInteger(asRecord(run?.workflow)?.databaseId)
  const workflow = asText(asRecord(run?.workflow)?.name)
  if (id === null || createdAt === null || workflowId === null || workflow === null) return null
  return { id, workflowId, workflow, createdAt, conclusion: asText(suite?.conclusion) }
}

/**
 * One reported check, from either object GitHub reports one as.
 *
 * This function tells the two apart by the fields present, not by
 * `__typename`: the two are `name`/`status`/`conclusion` and
 * `context`/`state`. Which fields answered is the same question, asked one
 * step closer to what is read. A commit status carries no status of its
 * own, so its `status` reads as null, which is what {@link CheckContext}
 * promises.
 *
 * Its `state` is its conclusion only where it names one. `StatusState` is
 * `EXPECTED, ERROR, FAILURE, PENDING, SUCCESS` (GitHub's schema, read by
 * introspection), and two of those five mean the check has NOT concluded.
 * If those two carried through as a conclusion, that would break the one
 * invariant {@link CheckContext} states. A reader that trusts that
 * invariant, such as a review loop that matches a conclusion against the
 * set that satisfies a required check, would then call a preview
 * deployment that is still in progress a failure, and report the whole
 * pull request red.
 */
const readCheck = (node: unknown): CheckContext | null => {
  const record = asRecord(node)
  const name = asText(record?.name)
  if (name !== null) {
    const run = readCheckWorkflowRun(record?.checkSuite)
    return {
      name,
      status: asText(record?.status),
      conclusion: asText(record?.conclusion),
      startedAt: asText(record?.startedAt),
      ...(run === null ? {} : { run }),
    }
  }
  // A node that is not a record at all lands here too, and is refused by
  // the same arm. It has neither field, which is what "neither kind of
  // check" means.
  const context = asText(record?.context)
  if (context === null) return null
  const state = asText(record?.state)
  return {
    name: context,
    status: null,
    conclusion: state !== null && Object.hasOwn(UNCONCLUDED, state) ? null : state,
    startedAt: asText(record?.createdAt),
  }
}

/** One pull request's facts, with every reason a list beside them is short.
 *  This is null when the reply is not the shape the query asked for. */
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
  // A null `statusCheckRollup` means a head nothing has reported on yet.
  // That is an answer about the checks, not a read that fell short. Whether
  // it means the run has not started is a question about workflow runs, and
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
  const unresolvedThreads: UnresolvedThread[] = []
  for (const entry of threads) {
    const thread = asRecord(entry)
    if (typeof thread?.isResolved !== 'boolean') return null
    if (thread.isResolved) continue
    const opener = nodesOf(thread.comments)?.[0]
    unresolvedThreads.push({ author: loginOf(opener), bot: isBotAuthor(opener) })
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
      unresolvedThreads,
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
  const id = asInteger(record?.id)
  const workflowId = asInteger(record?.workflow_id)
  const createdAt = asText(record?.created_at)
  if (name === null || event === null || headSha === null) return null
  if (id === null || workflowId === null || createdAt === null) return null
  if (status === null || startedAt === null || updatedAt === null) return null
  // A run that has not concluded reports `conclusion: null`. That null is
  // the difference between "in progress" and "failed".
  return {
    id,
    workflowId,
    createdAt,
    name,
    event,
    headSha,
    status,
    conclusion: asText(record?.conclusion),
    startedAt,
    updatedAt,
  }
}

/** The words GitHub answers with when a plan does not include rulesets
 *  (#414, seen on a private repository of a free organization). */
const PLAN_LIMIT_MESSAGE =
  'Upgrade to GitHub Pro or make this repository public to enable this feature'

/**
 * Whether a branch-rules answer is GitHub's plan-limit refusal.
 *
 * The match is narrow on purpose: the body must be an error body with a
 * status of 403 and the plan-limit words in its message. gh prints the
 * status of a 4xx body as a string (read from a real 404 on 2026-10-13).
 * It is safe to read this as "no rulesets" because the plan lacks the
 * feature. A repository that cannot have rulesets has none that require a
 * check. Any other refusal, such as a 403 for a missing token scope or a
 * rate limit, does not carry these words and stays unavailable (#414).
 */
const isPlanLimit = (value: unknown): boolean => {
  const body = asRecord(value)
  return (
    String(body?.status) === '403' &&
    typeof body?.message === 'string' &&
    body.message.includes(PLAN_LIMIT_MESSAGE)
  )
}

/** What a non-list answer says of itself, as a suffix: its status and
 *  message when it is an error body, or nothing (#414). gh prints the
 *  error body of a 4xx to stdout, with `status` as a string. */
const errorBodyOf = (value: unknown): string => {
  const body = asRecord(value)
  const message = asText(body?.message)
  if (message === null) return ''
  const status = body?.status
  return typeof status === 'string' || typeof status === 'number'
    ? ` (${status}: ${message})`
    : ` (${message})`
}

/**
 * Every context the branch rules require, unioned across the rules, or null
 * when a rule is not the shape the endpoint promises.
 *
 * This returns null for the whole read, not just for the one bad rule, on
 * {@link readRefs}' grounds, one domain over. A required context dropped in
 * silence is a pull request reported green that the ruleset would in fact
 * refuse, and a caller told nothing cannot know it happened.
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

/** Every value {@link CompareStatus} can hold, for {@link ISSUE_STATES}'
 *  reason: a new member with no key here is a `tsc` error. */
const COMPARE_STATUSES: Record<CompareStatus, true> = {
  ahead: true,
  behind: true,
  diverged: true,
  identical: true,
}

const isCompareStatus = (value: unknown): value is CompareStatus =>
  typeof value === 'string' && Object.hasOwn(COMPARE_STATUSES, value)

/** The most files GitHub lists in one compare ("Compare two commits", REST
 *  docs). A list of this length can be short. */
const COMPARE_FILE_LIMIT = 300

/**
 * One compare reply, or the reason it could not be read.
 *
 * A file with no `filename` costs the whole read, on {@link
 * requiredContextsOf}' grounds: a changed file dropped in silence is a
 * change that a caller reads as absent.
 */
const readComparison = (value: unknown, range: string): GhResults['compareCommits'] => {
  const reply = asRecord(value)
  const status = reply?.status
  if (!isCompareStatus(status)) {
    // A refused compare (an unknown commit) still answers JSON, with
    // GitHub's `message` in it.
    const said = asText(reply?.message)
    return {
      comparison: null,
      unavailable: `the compare of ${range} carried no status${said === null ? '' : `: ${said}`}`,
    }
  }
  const entries = reply?.files
  if (!Array.isArray(entries)) {
    return { comparison: null, unavailable: `the compare of ${range} carried no files list` }
  }
  const files: string[] = []
  for (const entry of entries) {
    const file = asRecord(entry)
    const filename = asText(file?.filename)
    if (filename === null) {
      return {
        comparison: null,
        unavailable: `a changed file in the compare of ${range} carried no filename`,
      }
    }
    files.push(filename)
    const previous = asText(file?.previous_filename)
    if (previous !== null) files.push(previous)
  }
  return {
    comparison: { status, files, filesAtLimit: entries.length >= COMPARE_FILE_LIMIT },
    unavailable: null,
  }
}

/**
 * The statuses on one commit node whose context starts with `prefix`, or
 * null when the node is not the shape asked for.
 *
 * A null `status` is a commit with no status at all: an empty list. A
 * status with another prefix is not read past its context, so its shape
 * cannot cost the read. One of this prefix that is short costs the whole
 * commit, on {@link requiredContextsOf}' grounds: a review status dropped
 * in silence reads as a round that did not run.
 */
const readCommitStatuses = (node: unknown, prefix: string): CommitStatus[] | null => {
  const commit = asRecord(asRecord(node)?.commit)
  const oid = asText(commit?.oid)
  if (oid === null) return null
  if (commit?.status === null) return []
  const contexts = asRecord(commit?.status)?.contexts
  if (!Array.isArray(contexts)) return null
  const statuses: CommitStatus[] = []
  for (const entry of contexts) {
    const status = asRecord(entry)
    const context = asText(status?.context)
    if (context === null) return null
    if (!context.startsWith(prefix)) continue
    const createdAt = asText(status?.createdAt)
    const description = status?.description
    if (createdAt === null) return null
    if (description !== null && typeof description !== 'string') return null
    statuses.push({ commit: oid, context, description, createdAt })
  }
  return statuses
}

/** What one page of a paginated read yielded. */
interface Page {
  readonly nodes: readonly unknown[]
  readonly hasNextPage: boolean
  readonly endCursor: string | null
  readonly errors: string | null
}

/**
 * Where one paginated read finds its connection. A repository read finds it
 * at `data.repository.<field>`, with `$owner` and `$name` as variables. A
 * search finds it at `data.search`, and `$q` carries the repository and the
 * search words. `label` names a search in a reason.
 */
type Connection =
  | { readonly kind: 'repository'; readonly field: string }
  | { readonly kind: 'search'; readonly label: string; readonly words: string }

/** The name of a connection in a reason. */
const connectionName = (connection: Connection): string =>
  connection.kind === 'repository' ? connection.field : connection.label

/**
 * One page's reply, or `undefined` when there is nothing to read: stdout that
 * is not JSON, or JSON with no connection where {@link Connection} says. The
 * reason for that `undefined` belongs to the caller, which holds the
 * {@link RunResult} and reports `accountOf` it, exactly as `parseIssueChunk`
 * leaves it.
 *
 * `errors` is every message the reply carried. Unlike `issueStates`, there is
 * no per-alias `NOT_FOUND` to account for separately: a sweep query names no
 * node that may legitimately be absent, so any error at all is a reason the
 * answer is short.
 */
const parseConnection = (stdout: string, connection: Connection): Page | undefined => {
  let reply: Record<string, unknown> | undefined
  try {
    reply = asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
  const data = asRecord(reply?.data)
  const found = asRecord(
    connection.kind === 'search' ? data?.search : asRecord(data?.repository)?.[connection.field],
  )
  if (found === undefined) return undefined
  const nodes = nodesOf(found)
  if (nodes === null) return undefined
  const info = asRecord(found.pageInfo)
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
 * What to say about a failure, chosen between three accounts of it.
 *
 * A child that never started is node's failure to report, not gh's: gh is
 * not on PATH, or is there and will not run. Whatever was on stderr is not
 * an account of that, so node's own message leads. "cannot run gh" is the
 * wording `gh-sync-repo.py:280`, `gh-shepherd-pr.py:415`, and
 * `gh-shepherd-status.py:85` all print. This function keeps that wording,
 * so a reader who has seen the Python's line sees the same one.
 *
 * A child whose pipes failed is a third case. Here the account of the pipe
 * leads, because what reached this process through it is not the whole of
 * what gh wrote. A short transcript, treated as though it were complete, is
 * the silence this file exists to refuse.
 *
 * A child that ran says why on stderr, and that wording travels with the
 * failure, because a caller cannot tell an expired token from a repository
 * that does not exist without it. With stderr empty, the status is all
 * there is: it at least separates a refusal from a crash. A child a signal
 * ended has no status at all to name.
 *
 * `boundMs` names the bound the caller asked for. A timed-out message
 * reports it, not {@link RunResult.elapsedMs}. The measured time differs by
 * a few milliseconds on every call. A caller that dedupes a repeated
 * failure by its exact wording (`watch.ts`) needs the same words each time.
 */
const accountOf = (result: RunResult, boundMs?: number): string => {
  if (result.startFailure !== null) return `cannot run gh: ${result.startFailure.message}`
  // The bound outranks a pipe failure and gh's own words. A child this
  // process killed for running too long did not fail on its own account.
  // A stray line it printed before the kill is not why the call has no
  // answer. `readStatusBatch` checks the same field first, for the same
  // reason (ruling 4, #295).
  if (result.timedOut) return `gh did not answer in ${boundMs ?? result.elapsedMs} ms`
  // A pipe that failed outranks whatever gh managed to say through it. The
  // words in hand may be half the words gh wrote, and a reader given only
  // those would be told a truncated answer with false confidence.
  const broke = result.streamErrors[0]
  if (broke !== undefined) return `gh's output could not be read: ${broke.code}, ${broke.message}`
  const said = result.stderr.trim()
  if (said !== '') return said
  if (result.status === null) return `gh was killed by ${result.signal}`
  return `gh exited ${result.status}`
}

/**
 * A process seam is where untrusted input arrives. So every reply is parsed
 * and checked against the shape the endpoint promises, and never defaulted:
 * an answer that is not what it claims is a failure here, not an empty list
 * a caller reads as "nothing matched".
 *
 * This function carries in the whole {@link RunResult}, not just its
 * stdout. That whole result is what the {@link GhError} thrown here reports
 * as its `cause`, exactly as one thrown for a non-zero exit does. A caller
 * that catches one shape gets one shape, so `error.cause.stderr` and
 * `error.cause.elapsedMs` mean the same thing, whichever of the four throw
 * sites it came from. What gh actually said is the part a reader needs, and
 * it would be lost if the cause carried the `SyntaxError` or the decoded
 * value instead. So those go into the message, where they are read.
 */
const parse = (result: RunResult, what: string): unknown => {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    // The message is already gh's account, with no argv in front of it, so
    // it is its own `detail`. Every throw site here carries one, so a
    // caller reads the same field, whichever it caught.
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
  // `gh repo view` is the one command here with no `--repo`. Its inherited
  // flags are `--help` alone, and the repository is its positional argument
  // instead. gh refuses the flag form outright ("unknown flag: --repo", gh
  // 2.98.0), so this endpoint spells the same fact the other way.
  const repositoryArgument = options.repository === undefined ? [] : [options.repository]

  /** Run gh, and answer with everything the child did. Nothing here decides
   *  whether that is a failure. The watch reports through its own status,
   *  and the other endpoints do not, so each endpoint decides that for
   *  itself.
   *
   *  `boundMs` defaults to `options.boundMs`, the client's own bound. Every
   *  endpoint that reads through this function gets it that way.
   *  `succeeded` is one, and so are `text`, `rows` and `record` beside it,
   *  the three that read through `succeeded`. `restJson`, `queryOnce`,
   *  `collect` and `issueStates` call this function directly, and get the
   *  same default. A
   *  call that already carries its own bound keeps it: `watchChecks` and
   *  `repositoryStatus` both pass one (ruling 4, #295). */
  const invoke = (
    args: readonly string[],
    boundMs: number | undefined = options.boundMs,
  ): Promise<RunResult> =>
    spawn('gh', args, { cwd: options.cwd, env: options.env, timeoutMs: boundMs })

  /** What gh did, once this function has established that gh succeeded. A
   *  non-zero exit, or a gh that never started, becomes a {@link GhError}
   *  that carries the status and gh's own words. */
  const succeeded = async (args: readonly string[]): Promise<RunResult> => {
    const result = await invoke(args)
    // A pipe error is a failure even on status 0. gh exits happily on the
    // bytes it wrote, but the bytes that arrived here are only the ones
    // that got through. To parse a short answer this way would treat a
    // truncated list as a complete one. `rows` and `record` refuse to do
    // that by default.
    if (result.status !== 0 || result.streamErrors.length !== 0) {
      // The account goes on the error as well as into the message. A
      // caller that prints a one-line reason wants gh's words alone, and a
      // tail of the message would hand it this argv instead
      // (`GhError.detail`).
      const detail = accountOf(result, options.boundMs)
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
   * This function reads the repository through `client.viewRepository`, not
   * from `options`. A client built with a `cwd` and no `repository` is the
   * mode `gh-sync-repo.py` used, and the one `scripts/gh.ts` still builds:
   * the repository is whatever gh resolves from that directory. This file
   * finds that out: it asks the endpoint already there (round 6's ruling on
   * #170).
   *
   * `nameWithOwner` is "owner/name" in one string, so reuse of that
   * endpoint costs only this split. There is deliberately no branch for a
   * value of some other shape: `split` never throws, and the query built from
   * whatever it yields fails downstream, where `accountOf` already reports
   * it. `owner`'s cast reflects that `noUncheckedIndexedAccess` is exact
   * about a `string[]` of unknown length; it is erased, and adds no branch.
   * `name` uses `String(parts[1])` instead of the same cast, because a
   * `nameWithOwner` with no `/` leaves `parts[1]` genuinely `undefined`, and
   * a cast there would be a type that lies about the value it holds.
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
      // above), so this is a cast, not a runtime check. An `instanceof`
      // guard here would add an arm no input can reach, and the coverage
      // rule says to restructure that branch away, not exclude it.
      return { unavailable: (error as GhError).detail }
    }
  }

  /**
   * Every page of one paginated GraphQL read, as rows.
   *
   * This function reads through `invoke`, not `succeeded`, for
   * `issueStates`' reason: `gh api graphql` exits 1 on a partial body that
   * is still an answer, so the body is read whatever the status. Nothing
   * here throws. Every reason the answer is short, including a row whose
   * shape could not be read, ends up in `unavailable` beside the rows that
   * were read.
   */
  const collect = async <T>(
    connection: Connection,
    query: string,
    variables: readonly string[],
    read: (node: unknown) => T | null,
  ): Promise<PagedResult<T>> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null) return { rows: [], unavailable: parts.unavailable }
    const field = connectionName(connection)
    const scope =
      connection.kind === 'repository'
        ? ['-f', `owner=${parts.owner}`, '-f', `name=${parts.name}`]
        : ['-f', `q=repo:${parts.owner}/${parts.name} ${connection.words}`]

    const rows: T[] = []
    const reasons: string[] = []
    let unreadable = 0
    let cursor: string | null = null
    for (let page = 0; page < SWEEP_PAGES; page += 1) {
      const args = [
        'api',
        'graphql',
        ...scope,
        ...variables,
        ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
        '-f',
        `query=${query}`,
      ]
      const result = await invoke(args)
      // A bound that fired outranks whatever this page's body looks like. A
      // child this process killed can still have written a whole, valid
      // page before the kill. That page must not read as a real answer
      // (ruling 4, #295; `readStatusBatch` guards the same way).
      if (result.timedOut) {
        reasons.push(accountOf(result, options.boundMs))
        break
      }
      const answer = parseConnection(result.stdout, connection)
      if (answer === undefined) {
        reasons.push(accountOf(result, options.boundMs))
        break
      }
      // A non-null `endCursor` equal to the cursor this page was just asked
      // with is a reply this cannot follow. A second ask would repeat the
      // same question forever, and the page's rows have already been read
      // once. This loop breaks here, before it reads them a second time, so
      // a stuck cursor does not read the same rows more than `SWEEP_PAGES`
      // times.
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
      // An `endCursor` of null with `hasNextPage` true is a reply this
      // cannot follow. To ask again with the same cursor would ask the same
      // question forever. This loop ends here with the short answer, and it
      // is a reason like any other: the rows already read are still an
      // answer, but a caller told nothing would read a truncated set as a
      // complete one.
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
    // One counter and one reason cover two causes: a field that was not the
    // shape the query asked for, and a dependency list at the page ceiling,
    // a well formed row this function refuses to trust. The reported
    // sentence must be true of both, because a distinction between them
    // would mean a second answer from `read`, and three endpoints share
    // `read`. `lib/README.md` lists the causes.
    if (unreadable > 0) {
      reasons.push(`${unreadable} ${field} row(s) could not be read`)
    }
    return { rows, unavailable: joinedReasons(reasons) }
  }

  /**
   * One GraphQL read that is not paginated. It resolves the repository the
   * one way, reads the body through `invoke` whatever gh's exit status (a
   * partial body is still an answer), and returns every reason there is no
   * answer as a sentence, rather than throw. It also names whether the
   * caller's own field, `notFoundField`, is the one GraphQL said does not
   * exist.
   *
   * `data` is the `repository` object, so a caller reads its own field off
   * it, exactly as {@link parseConnection} does for the paginated reads.
   * `data` and `unavailable` are independent: GraphQL answers a `repository`
   * and an `errors` list together for a query that partly succeeded, and to
   * drop either would report half an answer as a whole one.
   */
  const queryOnce = async (
    query: string,
    variables: readonly string[],
    /** The last segment of the one path a NOT_FOUND error must end in for
     *  {@link notFound} to trust it. `notFoundAlias` (above) reads the same
     *  fact for a batched query with an alias per number; a single, plain
     *  field name is this query's version of the same check. */
    notFoundField: string,
  ): Promise<{
    data: Record<string, unknown> | null
    unavailable: string | null
    /** True when `errors` names a `NOT_FOUND` entry whose `path` ends at
     *  `notFoundField`. GraphQL uses this to report that the thing asked
     *  for does not exist. A NOT_FOUND elsewhere in the same reply, for a
     *  field nested under it, does not set this: that reports a different
     *  field missing, not this one. No other reason a read comes back
     *  short sets this flag either. */
    notFound: boolean
  }> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null)
      return { data: null, unavailable: parts.unavailable, notFound: false }
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
    // A bound that fired outranks the body, the same way `collect` guards
    // its own pages (ruling 4, #295).
    if (result.timedOut) {
      return { data: null, unavailable: accountOf(result, options.boundMs), notFound: false }
    }
    let reply: Record<string, unknown> | undefined
    try {
      reply = asRecord(JSON.parse(result.stdout))
    } catch {
      return { data: null, unavailable: accountOf(result, options.boundMs), notFound: false }
    }
    const repository = asRecord(asRecord(reply?.data)?.repository)
    if (repository === undefined) {
      return { data: null, unavailable: accountOf(result, options.boundMs), notFound: false }
    }
    const errorsField = reply?.errors
    const entries = Array.isArray(errorsField) ? errorsField : []
    const messages = entries
      .map((entry) => asRecord(entry)?.message)
      .filter((message): message is string => typeof message === 'string')
    const notFound = entries.some((entry) => {
      const error = asRecord(entry)
      if (error?.type !== 'NOT_FOUND') return false
      const path = error.path
      return Array.isArray(path) && path[path.length - 1] === notFoundField
    })
    return { data: repository, unavailable: joinedReasons(messages), notFound }
  }

  /**
   * One REST read under this repository's path, as whatever JSON it
   * answered, or the reason there is none.
   *
   * This function reads through `invoke`, for `issueStates`' reason: `gh
   * api` exits non-zero on a 404 and on a 403 alike, and the body it
   * printed is still the best account of which one it was. So the status
   * decides nothing here, and `accountOf` reports what gh said.
   */
  const restJson = async (
    path: string,
  ): Promise<{ value: unknown; unavailable: null } | { value: null; unavailable: string }> => {
    const parts = await repositoryParts()
    if (parts.unavailable !== null) return { value: null, unavailable: parts.unavailable }
    const result = await invoke(['api', `repos/${parts.owner}/${parts.name}/${path}`])
    // A bound that fired outranks the body, the same way `collect` guards
    // its own pages (ruling 4, #295).
    if (result.timedOut) return { value: null, unavailable: accountOf(result, options.boundMs) }
    try {
      return { value: JSON.parse(result.stdout), unavailable: null }
    } catch {
      return { value: null, unavailable: accountOf(result, options.boundMs) }
    }
  }

  // This binds a `const` and returns it, rather than write a plain
  // `return`, because `issueStates` reads the repository through
  // `client.viewRepository` (round 6's ruling on #170: "the existing
  // viewRepository()", not a second copy of its argv). That reference
  // resolves when the endpoint is called, and by then `client` is already
  // assigned.
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

    // Text, not JSON. `--log-failed` is the log itself, and the caller
    // reads it as the lines a human would. `--job` narrows it to one job of
    // the run, which is what `gh-shepherd-pr.py:726` asks for: it has
    // followed a check's link to a run and a job, and the whole run's
    // failed steps would be a different question.
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
      ]),

    // The blocking call, and the only one that takes a bound. Round 5's
    // handoff fact 1: #154 left `gh pr checks --watch` unbounded, while the
    // Python wraps the same call in `run_bounded`, for the reasons it
    // records at `gh-shepherd-pr.py:633` to `637`. A watch that cannot
    // return is worse than no watch.
    //
    // gh refuses `--watch` together with `--json`, and refuses `--interval`
    // without `--watch`, both verified against gh 2.98.0. That is why there
    // is no `--json` here: this endpoint is the wait, and the caller reads
    // the rollup afterwards with `viewPullRequest`, exactly as
    // `gh-shepherd-pr.py:668` does.
    //
    // Nothing throws. Every outcome, including gh's failure to start, is
    // reported through {@link WatchResult}, because the status is an answer
    // here. A caller that must tell 1 apart from 8 apart from 127 cannot be
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
        // gh's own words, when gh managed to say any. Otherwise, an account
        // of what happened to it.
        //
        // A watch a signal ended has no status to report, and, unlike the
        // Python, nothing on stderr either. `run_bounded` calls
        // `communicate()` a second time after the kill, specifically to
        // drain stderr (`gh-shepherd-pr.py:286` to `291`), and this
        // transport does not. So a watch killed by anything that is not
        // this process's own bound, such as the OOM killer, a SIGHUP when
        // the terminal closed, or a supervisor, used to arrive as
        // `{ status: null, timedOut: false, problem: '' }`. That gave no
        // status the caller recognised, said nothing about whether it timed
        // out, and stayed silent in the one field whose contract is to be
        // "the only place a watcher that could not reach GitHub says so".
        //
        // The case where the bound fires alone is exempt, because it
        // already says so in `timedOut`, which is what the caller at
        // `gh-shepherd-pr.py:644` reads. `problem` stays empty there
        // instead of repeating `accountOf`'s own timeout wording.
        //
        // `result.stderr` appears WHOLE in the first arm, never
        // `accountOf`'s trimmed copy. The field's own contract, stated
        // above, is "what the watch said on stderr, whole", with the
        // tailing left to the caller. A watch that died with something
        // already on stderr keeps those words, for the same reason: that is
        // the `result.stderr !== ''` clause.
        //
        // A pipe that failed disqualifies the whole transcript. So it falls
        // through to `accountOf`, with everything else that is not gh's
        // own words.
        problem:
          result.startFailure === null &&
          result.streamErrors.length === 0 &&
          (result.signal === null || result.timedOut || result.stderr !== '')
            ? result.stderr
            : accountOf(result, pull.boundMs),
      }
    },

    // Never throws (the interface's own contract). A failure to resolve
    // the repository, to reach gh at all, or to read what gh printed, is
    // folded into `unavailable`, and never rejects the call. The one
    // consumer (tier 0 of the context audit, #164/#170) reports on many
    // numbers at once, and a single bad chunk must not cost it every other
    // answer.
    issueStates: async (query) => {
      // The same two arguments every GraphQL endpoint here needs, resolved
      // the one way. `repositoryParts` carries the reasoning, and the
      // pinned case: "reports a repository whose name has no owner
      // prefix".
      const parts = await repositoryParts()
      if (parts.unavailable !== null) return { states: {}, unavailable: parts.unavailable }
      const { owner, name } = parts

      const states: Record<string, IssueState | 'not_found'> = {}
      const reasons: string[] = []
      for (let i = 0; i < query.numbers.length; i += ISSUE_BATCH) {
        const chunk = query.numbers.slice(i, i + ISSUE_BATCH)
        // `gh api graphql` exits 1 on a partial body that is still an
        // answer (one bad alias fails the whole call). So this reads the
        // body through `invoke`, not `succeeded`, whatever the status.
        const args = ['api', 'graphql', '-f', `query=${buildIssueQuery(owner, name, chunk)}`]
        const result = await invoke(args)
        // A bound that fired outranks the body, the same way `collect`
        // guards its own pages (ruling 4, #295). A child this process
        // killed can still have written a whole, valid body before the
        // kill, and that body must not read as a real answer.
        if (result.timedOut) {
          reasons.push(accountOf(result, options.boundMs))
          continue
        }
        const answer = parseIssueChunk(result.stdout, chunk)
        if (answer === undefined) {
          reasons.push(accountOf(result, options.boundMs))
          continue
        }
        Object.assign(states, answer.states)
        if (answer.errors !== null) reasons.push(answer.errors)
      }
      return { states, unavailable: joinedReasons(reasons) }
    },

    listMilestones: async () =>
      collect({ kind: 'repository', field: 'milestones' }, MILESTONES_QUERY, [], readMilestone),

    // The milestone filter is a variable, not a second query, so the argv
    // differs by two words and the query text does not. Left out, the
    // variable is null, and GitHub applies no milestone filter at all. That
    // is how a caller reads the issues on no milestone (see the interface).
    listIssues: async (query = {}) =>
      collect(
        { kind: 'repository', field: 'issues' },
        ISSUES_QUERY,
        query.milestone === undefined ? [] : ['-f', `milestone=${query.milestone}`],
        readIssue,
      ),

    searchPlanIssues: async () =>
      collect(
        { kind: 'search', label: 'planIssues', words: PLAN_SEARCH },
        PLAN_ISSUES_QUERY,
        [],
        readPlanIssue,
      ),

    readPlanIssues: async (numbers) => {
      const rows: IssueComments[] = []
      const reasons: string[] = []
      // The numbers go into the query as text, so this client checks them
      // itself rather than trust each caller.
      const valid = numbers.filter((number) => Number.isSafeInteger(number) && number > 0)
      for (const number of numbers) {
        if (!valid.includes(number)) reasons.push(`${number} is not an issue number`)
      }
      for (let i = 0; i < valid.length; i += PLAN_PAGE) {
        const chunk = valid.slice(i, i + PLAN_PAGE)
        // No field name is a NOT_FOUND to trust here. A number that is not
        // an issue is a null alias. Its GraphQL error and its number both
        // go into `unavailable`.
        const answer = await queryOnce(buildPlanIssueQuery(chunk), [], '')
        if (answer.unavailable !== null) reasons.push(answer.unavailable)
        const data = answer.data
        if (data === null) continue
        chunk.forEach((number, index) => {
          const row = readPlanIssue(data[`i${index}`])
          if (row === null) reasons.push(`#${number} could not be read as an issue`)
          else rows.push(row)
        })
      }
      return { rows, unavailable: joinedReasons(reasons) }
    },

    listOpenPullRequests: async () =>
      collect(
        { kind: 'repository', field: 'pullRequests' },
        PULL_REQUESTS_QUERY,
        [],
        readPullRequest,
      ),

    listOpenPullRequestHeads: async () =>
      collect(
        { kind: 'repository', field: 'pullRequests' },
        PULL_REQUEST_HEADS_QUERY,
        [],
        readPullRequestHead,
      ),

    listOpenPullRequestLinks: async () =>
      collect(
        { kind: 'repository', field: 'pullRequests' },
        PULL_REQUEST_LINKS_QUERY,
        [],
        readPullRequestLink,
      ),

    // The branch is percent-encoded into the path, because a branch name
    // may carry a `/` (`spike/context-audit`). An unencoded one would name
    // a path segment that is not the branch, and answer 404 for a branch
    // that exists.
    requiredContexts: async (query) => {
      const answer = await restJson(`rules/branches/${encodeURIComponent(query.branch)}`)
      if (answer.unavailable !== null) return { contexts: [], unavailable: answer.unavailable }
      if (isPlanLimit(answer.value)) return { contexts: [], unavailable: null }
      if (!Array.isArray(answer.value)) {
        return {
          contexts: [],
          unavailable: `the rules for ${query.branch} were not a list of rules${errorBodyOf(answer.value)}`,
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
      const answer = await queryOnce(
        PULL_REQUEST_DETAIL_QUERY,
        [
          // `-F`, not `-f`: `number` is an `Int!`. `-f` would send it as the
          // string "178", which GraphQL refuses outright.
          '-F',
          `number=${pull.pullRequest}`,
        ],
        'pullRequest',
      )
      if (answer.data === null) {
        return { pullRequest: null, unavailable: answer.unavailable, missing: false }
      }
      const read = readPullRequestDetail(answer.data.pullRequest)
      if (read === null) {
        const said = `pull request ${pull.pullRequest} could not be read`
        return {
          pullRequest: null,
          // Whatever GraphQL said about it leads. "No such pull request"
          // and "this token may not see it" arrive as the same missing
          // node, and only the error tells them apart.
          unavailable: answer.unavailable === null ? said : `${said}: ${answer.unavailable}`,
          // True only when GraphQL itself named this pull request field
          // NOT_FOUND. `lib/README.md` names every other reason this stays
          // false. A caller then never reports a read failure, or an
          // unrelated nested one, as "no such pull request".
          missing: answer.notFound,
        }
      }
      return {
        pullRequest: read.detail,
        missing: false,
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
        // A row left out is never silence, for `collect`'s reason. A caller
        // that asserts a run exists for a head would read a dropped row as
        // "no run", and close and reopen a pull request over it.
        unavailable:
          unreadable === 0 ? null : `${unreadable} workflow run row(s) could not be read`,
      }
    },

    // `per_page=1` keeps the commit list to one entry. The file list comes
    // on the first page only, with 300 files at most (verified live on
    // 2026-10-03).
    compareCommits: async (query) => {
      const range = `${query.base}...${query.head}`
      const path = `${encodeURIComponent(query.base)}...${encodeURIComponent(query.head)}`
      const answer = await restJson(`compare/${path}?per_page=1`)
      if (answer.unavailable !== null) return { comparison: null, unavailable: answer.unavailable }
      return readComparison(answer.value, range)
    },

    listPullRequestStatuses: async (query) => {
      const answer = await queryOnce(
        PULL_REQUEST_STATUSES_QUERY,
        // `-F`: `number` is an `Int!`, as in `viewPullRequestDetail`.
        ['-F', `number=${query.pullRequest}`],
        'pullRequest',
      )
      if (answer.data === null) return { rows: [], unavailable: answer.unavailable }
      const commits = asRecord(asRecord(answer.data.pullRequest)?.commits)
      const nodes = nodesOf(commits)
      const reasons: string[] = []
      if (nodes === null) {
        reasons.push(`the commits of pull request ${query.pullRequest} could not be read`)
      }
      const rows: CommitStatus[] = []
      let unreadable = 0
      for (const node of nodes ?? []) {
        const statuses = readCommitStatuses(node, query.prefix)
        if (statuses === null) unreadable += 1
        else rows.push(...statuses)
      }
      if (unreadable > 0) {
        reasons.push(
          `the statuses of ${unreadable} commit(s) of pull request ${query.pullRequest} could not be read`,
        )
      }
      // The rows read stay. A status on a later commit is not among them,
      // so a caller must not read the rows as the whole answer.
      if (truncated(commits)) {
        reasons.push(
          `pull request ${query.pullRequest} has more than the ${SWEEP_PAGE} commits this reads, ` +
            'so a status on a later commit is not read',
        )
      }
      if (answer.unavailable !== null) reasons.push(answer.unavailable)
      return { rows, unavailable: joinedReasons(reasons) }
    },

    // A write, so it throws a `GhError` as `addComment` does. `-f` sends
    // each field as a string, which is what each of the three is.
    createCommitStatus: async (status) => {
      const repositoryName = String((await client.viewRepository()).nameWithOwner)
      return record(
        await succeeded([
          'api',
          '--method',
          'POST',
          `repos/${repositoryName}/statuses/${encodeURIComponent(status.sha)}`,
          '-f',
          `state=${status.state}`,
          '-f',
          `context=${status.context}`,
          ...(status.description === undefined ? [] : ['-f', `description=${status.description}`]),
        ]),
        'gh api statuses',
      )
    },

    // Never throws (the interface's own contract). One batch that failed
    // costs only its own repositories.
    repositoryStatus: async (repos, options) => {
      const batches: string[][] = []
      for (let i = 0; i < repos.length; i += STATUS_BATCH) {
        batches.push(repos.slice(i, i + STATUS_BATCH))
      }
      const answers = await Promise.all(
        batches.map(async (batch) => {
          const args = ['api', 'graphql', '-f', `query=${buildStatusQuery(batch)}`]
          return readStatusBatch(await invoke(args, options.boundMs), batch, options.boundMs)
        }),
      )
      const repositories: Record<string, RepositoryStatus> = {}
      const reasons: string[] = []
      for (const answer of answers) {
        Object.assign(repositories, answer.repositories)
        if (answer.reason !== null) reasons.push(answer.reason)
      }
      return { repositories, unavailable: joinedReasons(reasons) }
    },
  }
  return client
}
