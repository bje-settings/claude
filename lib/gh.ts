// The `gh` client: the interface the commands are written against, and the
// real implementation of it.
//
// The interface and its query and result types were declared in
// `harness/gh.ts` at #124 and move here now, as both that file and
// `harness/README.md` said they would; the harness imports them back and
// keeps `createGhMock`, which is test code and does not ship. The endpoints
// are named after the operation the caller wants, not after gh's argv, so the
// interface survives gh changing a flag. Inputs and outputs stay plain JSON
// values: #127 refines them against the commands that actually consume them,
// and a domain type invented here would be invented from nothing.
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
// **This is not the process runner.** The adapter below runs one executable,
// `gh`, with no shell, and it is private to this file. The root lib's process
// runner and its git helpers land with #127, their first consumer, which is
// also the round-4 and round-5 ruling: typed code written before anything
// calls it is the argument RFC 001 decision 3 records against itself.
//
// This file ships. It imports nothing outside the root lib and nothing from
// node beyond `child_process`, and stays inside the erasable subset (ADR 001).

import { execFile } from 'node:child_process'

/** Filters `gh pr list` applies server-side, as the plugins pass them today. */
export interface PullRequestQuery {
  state?: string
  base?: string
  head?: string
  limit?: number
}

/** Filters `gh run list` applies server-side. */
export interface RunQuery {
  branch?: string
  status?: string
  limit?: number
}

/** What each endpoint answers with. One entry per operation, so the reply map
 *  and the client cannot drift apart. */
export interface GhResults {
  /** Pull requests matching the query, projected as JSON rows. */
  listPullRequests: unknown[]
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
  /** The checks as they stood when the watch returned. */
  watchChecks: unknown[]
}

export type GhEndpoint = keyof GhResults

/** The operations the plugins ask `gh` for. Implemented by `createGhClient`
 *  below and by `createGhMock` in the harness; a command takes one as an
 *  argument and never constructs it, which is what makes it swappable at
 *  all. */
export interface GhClient {
  listPullRequests(query?: PullRequestQuery): Promise<GhResults['listPullRequests']>
  viewRepository(): Promise<GhResults['viewRepository']>
  listRuns(query?: RunQuery): Promise<GhResults['listRuns']>
  readFailedRunLog(run: { run: string | number }): Promise<GhResults['readFailedRunLog']>
  updateBranch(pull: { pullRequest: number; rebase?: boolean }): Promise<GhResults['updateBranch']>
  addComment(comment: { pullRequest: number; body: string }): Promise<GhResults['addComment']>
  watchChecks(pull: { pullRequest: number; interval?: number }): Promise<GhResults['watchChecks']>
}

/**
 * `node:child_process`'s own `execFile`, narrowed to the four arguments the
 * adapter passes it.
 *
 * It is a parameter rather than a hardcoded import so that the adapter, the
 * only thing here that would start a process, is exercised in this suite by
 * driving it with a stand-in: every endpoint, and both arms of the failure
 * the adapter reports, are covered in-process with nothing spawned and no
 * `gh` on PATH. The alternative, a default nothing can substitute, is a file
 * that can only reach 100% by spawning a binary a machine may not have, or by
 * an exclusion the coverage rule does not offer.
 */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: 'utf8'
    readonly maxBuffer: number
    readonly cwd: string | undefined
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void

export interface GhClientOptions {
  /**
   * Where `gh` runs. `gh` reads the repository from the working directory and
   * none of the endpoints above carries a repository, which is how the
   * scripts being ported address a repository they did not start in.
   */
  readonly cwd?: string
  /** The spawn seam. Defaults to node's own `execFile`. */
  readonly execFile?: ExecFile
}

/**
 * 64 MiB. Node's own default is 1 MiB, which a `gh pr list --limit 100` over
 * a busy repository passes: every row carries `statusCheckRollup`. The
 * failure that produces is a truncated answer read as a complete one, which
 * is the defect class this port exists to close.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * The `--json` field lists, taken from the scripts that ask for them today:
 * `plugins/gh/scripts/lib/shepherd.py`'s `PR_FIELDS` and
 * `gh-shepherd-status.py`'s repository and run queries. The run list adds the
 * run's identity and outcome to the two timestamps that script reads, because
 * a run row with no id cannot be followed to `readFailedRunLog`, which is the
 * next endpoint in this same interface.
 */
const PULL_REQUEST_FIELDS =
  'number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,' +
  'headRefOid,statusCheckRollup,createdAt,state,mergeCommit,reviewDecision'
const REPOSITORY_FIELDS = 'nameWithOwner,defaultBranchRef'
const RUN_FIELDS = 'databaseId,status,conclusion,createdAt,updatedAt'
const CHECK_FIELDS = 'name,state,bucket,link,workflow'

/** An optional filter, as the two argv words gh wants or as nothing at all. */
const filter = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}`, String(value)]

/**
 * Run `gh` and answer with its stdout, throwing gh's own words when it exits
 * non-zero. gh's wording travels with the failure because a caller cannot
 * tell an expired token from a repository that does not exist without it,
 * which is the reasoning `gh-sync-repo.py` already carries.
 */
const runGh = (
  spawn: ExecFile,
  cwd: string | undefined,
  args: readonly string[],
): Promise<string> =>
  new Promise((resolve, reject) => {
    // No shell: every argument reaches `gh` as written, so a branch name or a
    // comment body carrying shell metacharacters is an argument rather than a
    // word a shell gets to re-read.
    spawn(
      'gh',
      args,
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, cwd },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout)
          return
        }
        // gh that exited non-zero says why on stderr; gh that never started at
        // all (not on PATH, cwd gone) leaves stderr empty and node's own
        // message is the only account of it.
        const detail = stderr.trim() || error.message
        reject(new Error(`gh ${args.join(' ')} failed: ${detail}`))
      },
    )
  })

/**
 * A process seam is where untrusted input arrives, so every reply is parsed
 * and asserted to be the shape the endpoint promises, never defaulted: an
 * answer that is not what it claims is a failure here rather than an empty
 * list a caller reads as "nothing matched".
 */
const parse = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`gh answered ${what} with something that is not JSON`)
  }
}

const rows = (text: string, what: string): unknown[] => {
  const value = parse(text, what)
  if (!Array.isArray(value)) {
    throw new Error(`gh answered ${what} with something that is not a list`)
  }
  return value
}

const record = (text: string, what: string): Record<string, unknown> => {
  const value = parse(text, what)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`gh answered ${what} with something that is not an object`)
  }
  return value as Record<string, unknown>
}

/** A `GhClient` that runs the real `gh`. */
export const createGhClient = (options: GhClientOptions = {}): GhClient => {
  const spawn = options.execFile ?? execFile
  const gh = (args: readonly string[]): Promise<string> => runGh(spawn, options.cwd, args)

  return {
    listPullRequests: async (query = {}) =>
      rows(
        await gh([
          'pr',
          'list',
          ...filter('state', query.state),
          ...filter('base', query.base),
          ...filter('head', query.head),
          ...filter('limit', query.limit),
          '--json',
          PULL_REQUEST_FIELDS,
        ]),
        'gh pr list',
      ),

    viewRepository: async () =>
      record(await gh(['repo', 'view', '--json', REPOSITORY_FIELDS]), 'gh repo view'),

    listRuns: async (query = {}) =>
      rows(
        await gh([
          'run',
          'list',
          ...filter('branch', query.branch),
          ...filter('status', query.status),
          ...filter('limit', query.limit),
          '--json',
          RUN_FIELDS,
        ]),
        'gh run list',
      ),

    // Text, not JSON: `--log-failed` is the log itself, and the caller reads
    // it as the lines a human would.
    readFailedRunLog: (run) => gh(['run', 'view', String(run.run), '--log-failed']),

    updateBranch: (pull) =>
      gh([
        'pr',
        'update-branch',
        String(pull.pullRequest),
        ...(pull.rebase === true ? ['--rebase'] : []),
      ]),

    addComment: (comment) =>
      gh(['pr', 'comment', String(comment.pullRequest), '--body', comment.body]),

    watchChecks: async (pull) =>
      rows(
        await gh([
          'pr',
          'checks',
          String(pull.pullRequest),
          '--watch',
          ...filter('interval', pull.interval),
          '--json',
          CHECK_FIELDS,
        ]),
        'gh pr checks',
      ),
  }
}
