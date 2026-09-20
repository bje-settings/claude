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
  /** The checks, read once the watch has returned. */
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
 * What node hands the callback when the child did not succeed.
 *
 * `code` is the whole reason this is not narrowed to a bare `Error`: node
 * sets it to gh's own exit status when gh ran, and to an error name when gh
 * never produced one (`ENOENT` for a `gh` that is not on PATH or a working
 * directory that is gone, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` for a reply
 * that overran {@link MAX_OUTPUT_BYTES}). Narrowing it away would leave the
 * adapter unable to tell an answer gh gives through its status from a failure
 * to answer at all, and unable to say which of the two it is reporting.
 * node's `ExecFileException` carries it as `string | number | null`, spelled
 * the same way here so the real `execFile` still satisfies this type; `null`
 * is what a child killed by a signal carries in place of a status.
 */
export type ExecFileFailure = Error & { readonly code?: string | number | null }

/**
 * `node:child_process`'s own `execFile`, narrowed to the four arguments the
 * adapter passes it.
 *
 * It is a parameter rather than a hardcoded import so that the adapter, the
 * only thing here that would start a process, is exercised in this suite by
 * driving it with a stand-in: every endpoint, and every arm of the failure
 * the adapter reports, are covered in-process with nothing spawned and no
 * `gh` on PATH. The alternative, a default nothing can substitute, is a file
 * that can only reach 100% by spawning a binary a machine may not have, or by
 * an exclusion the coverage rule does not offer.
 *
 * `encoding: 'utf8'` is a literal rather than a `string` because it is what
 * selects node's string-returning overload: without it the real `execFile`
 * would only match the overload whose `stdout` is `string | Buffer`, which
 * this type refuses, so the type check is what holds "stdout is text" rather
 * than a convention.
 */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: 'utf8'
    readonly maxBuffer: number
    readonly cwd: string | undefined
  },
  callback: (error: ExecFileFailure | null, stdout: string, stderr: string) => void,
) => void

export interface GhClientOptions {
  /**
   * Where `gh` runs. `gh` resolves the repository from the working directory,
   * and none of the endpoints above carries one, so this is the only way a
   * caller addresses a repository the process did not start in. The scripts
   * being ported name it with `--repo` instead; adding that as a second
   * option belongs with the command that needs it (#127), since an optional
   * option can be added later without breaking a caller.
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

/**
 * The exit statuses `gh pr checks` uses to report on the checks rather than
 * on itself: 1 a check failed, 8 still pending. This is
 * `plugins/gh/scripts/gh-shepherd-pr.py` line 177's `WATCHER_CODES` without
 * 0, which is not an error at all here, and without 124, which is that
 * script's own bound. Reading them as transport failures is how a red rollup
 * gets reported as a broken token. Every other status from that subcommand,
 * and every status from every other one, stays a failure.
 *
 * 1 is also gh's generic non-zero, so an unresolvable pull request or a
 * transient error during the watch is accepted here too (measured against gh
 * 2.98.0: `gh pr checks <absent> --watch` exits 1). Nothing is lost by that
 * today, because the read below carries no accepted statuses and repeats a
 * real failure with gh's own words. What it cannot catch is a watch that
 * fails early while the read then succeeds, which reads as a rollup nobody
 * waited for. Telling those apart needs the status in this endpoint's answer,
 * and that lands with the caller that branches on it (#127).
 */
const CHECK_ANSWERS = [1, 8]

/** An optional filter, as the two argv words gh wants or as nothing at all. */
const filter = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}`, String(value)]

/**
 * What to say about a failure, chosen between the two accounts of it.
 *
 * A numeric `code` is gh's own exit status: gh ran, and gh says why on
 * stderr. That wording travels with the failure because a caller cannot tell
 * an expired token from a repository that does not exist without it, which is
 * the reasoning `gh-sync-repo.py` already carries.
 *
 * Any other `code` is node's failure to report rather than gh's: gh never
 * started, or the child was killed, whether for overrunning `maxBuffer` or by
 * a signal, which is the `null` {@link ExecFileFailure} admits. Whatever gh
 * had already written to stderr is not an account of that, so node's message
 * leads instead of being replaced by a warning with nothing to do with the
 * failure. Replacing it is how a truncated reply gets reported as a
 * deprecation notice, which is the defect class {@link MAX_OUTPUT_BYTES}
 * exists to close.
 */
const accountOf = (error: ExecFileFailure, stderr: string): string => {
  const said = stderr.trim()
  if (typeof error.code === 'number') return said === '' ? error.message : said
  return said === '' ? error.message : `${error.message}: ${said}`
}

/**
 * Run `gh` and answer with its stdout, throwing when it fails.
 *
 * `answering` names the non-zero exit statuses that are an answer rather than
 * a failure. It is empty for every endpoint but the checks watch, which is
 * the one subcommand that reports through its status (see `watchChecks`).
 */
const runGh = (
  spawn: ExecFile,
  cwd: string | undefined,
  args: readonly string[],
  answering: readonly number[] = [],
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
        if (error === null || (typeof error.code === 'number' && answering.includes(error.code))) {
          resolve(stdout)
          return
        }
        reject(new Error(`gh ${args.join(' ')} failed: ${accountOf(error, stderr)}`))
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
  const gh = (args: readonly string[], answering?: readonly number[]): Promise<string> =>
    runGh(spawn, options.cwd, args, answering)

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

    // Two invocations, because gh has no single one that does both: it
    // refuses `--watch` together with `--json` ("cannot use `--watch` with
    // `--json` flag") and refuses `--interval` without `--watch`, both
    // verified against gh 2.98.0. The watch blocks, and the read that follows
    // is what the caller is answered with.
    //
    // `plugins/gh/scripts/gh-shepherd-pr.py` lines 668 to 672 settles the
    // half of that which is a judgement rather than a flag: it re-reads after
    // the watch and decides "from the rollup rather than the watcher's exit
    // code". Its second read is `gh pr view`, because that script already
    // holds a pull request; here the endpoint is about the checks, so the
    // second read is the checks. The two bounds it also carries, watching
    // only an already-pending rollup and `--fail-fast`, belong with the
    // command that decides to watch (#127), not with the transport.
    //
    // The watch answers through its exit status, so {@link CHECK_ANSWERS} is
    // passed to it. The read carries `--json`, which gh exits 0 from whatever
    // the checks say (verified against a pull request with failing checks),
    // so its rows are the answer either way and it needs none.
    //
    // Nothing bounds the watch. The Python wraps it in `run_bounded` for
    // reasons it records at `gh-shepherd-pr.py` lines 633 to 637, and a
    // timeout on the seam lands with the command that needs one (#127),
    // rather than as an option no caller in this round passes.
    watchChecks: async (pull) => {
      const pullRequest = String(pull.pullRequest)
      await gh(
        ['pr', 'checks', pullRequest, '--watch', ...filter('interval', pull.interval)],
        CHECK_ANSWERS,
      )
      return rows(await gh(['pr', 'checks', pullRequest, '--json', CHECK_FIELDS]), 'gh pr checks')
    },
  }
}
