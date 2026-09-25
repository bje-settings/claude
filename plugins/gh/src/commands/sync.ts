// This command syncs the current checkout, or every checkout one level
// down. It is the port of `plugins/gh/scripts/gh-sync.py`.
//
// Scope comes from the target directory, so no caller has to classify it:
//   - the directory is a git repo     -> sync that repo
//   - the directory is not a git repo -> sync every immediate subdirectory
//                                        that is a git repo, non-recursively
//
// **The fan-out is IN-PROCESS** (the design ruling in the approved plan).
// `gh-sync.py` started one `gh-sync-repo.py` process per repository. Here,
// this code calls the per-repository function directly, at most `-j N` at a
// time. ADR 001 makes the command function the test seam. An injected `gh`
// mock cannot cross a process boundary. Each job buffers its own report.
// This keeps the output order and the bytes the same as before. The
// reports come out in directory order, never in the order the jobs
// finished.
//
// Anything with no in-process counterpart went away with the child
// process. The PR body lists each such line and the test that pinned it.
// The job's own section reported three cases. A child could fail to
// start. A child could exit non-zero. Or a signal could kill a child.
//
// A direct call cannot fail to start. The real job, `syncRepo`, never
// answers anything but 0 (its own status is dead weight in production).
// `RepoJob`'s status exists for the stand-in a test drives. #81 (round 7)
// decided this: a non-zero answer, like a throw, now makes this command
// answer `failed`. Before, nobody read that answer.
//
// **#127 deleted the Python this ports.** `plugins/gh/scripts/*.py`, its
// `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree. The file and line references below point to what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.
import path from 'node:path'
import { discoverRepos, gitUnavailable, toplevel } from '../discover.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import { createWriter } from '../lib/streams.ts'
import { type Command, REPORT, type SyncRepoOptions, syncRepo } from './sync-repo.ts'

/** At most, this command syncs this many repositories at a time when
 *  `-j` gives no value. */
export const DEFAULT_JOBS = '4'

// This code refuses a `-j` value that is not a positive integer. It does
// not clamp it. The shell version did the same: it validated with this
// same pattern and exited 2. The shell validated for a reason.
//
// The value reached an arithmetic context there, where a non-numeric word
// equals 0. In that context, the throttle would never let a job start. An
// unchecked value would hang the run, rather than fail it. Nothing may
// quietly reinterpret it here either.
const JOBS_RE = /^[1-9][0-9]*$/

export const HELP = `Sync the current checkout, or every checkout one level down.

Usage:
  gh.ts sync [--dry-run] [--no-install] [-j N] [path]

Scope comes from the target directory, so no caller has to classify it:
  - the directory is a git repo     -> sync that repo
  - the directory is not a git repo -> sync every immediate subdirectory that
                                       is a git repo, non-recursively

Subdirectories that are not git repos are skipped without comment. Nothing is
ever cloned: only checkouts that already exist locally are touched.

The per-repo work runs in this process, at most -j N repositories at a time.
Each repository's output is collected on its own and printed in directory
order, never in the order the jobs happened to finish.`

/**
 * What a job that threw says, in this repository's own section.
 *
 * This is the in-process match for the three lines `gh-sync.py` prints
 * about a child that failed. Those lines are `:135`, `:174`, and the
 * newline at `:171`. A direct call cannot fail to start, and it has no
 * exit status of its own. It can still throw. `syncRepo` deliberately
 * lets anything that is not a `GhError` escape. The wording here is this
 * file's own, not the Python's, because the Python names a script and a
 * status that no longer exist. `fixtures/divergences.json` records this
 * wording against the line it replaces.
 *
 * The mark comes from {@link REPORT}, not a literal string, because this
 * is a report line like any other. The SessionStart hook classifies it by
 * that constant (#110, `commands/hook-io.ts` `fanOutSummary`). That
 * function counts this line as a repository that no check could fully
 * cover. A literal here would let someone reword the mark in one place.
 * The hook would then silently count nothing.
 */
export const failureLine = (error: unknown): string =>
  `${REPORT.bad}the sync failed: ${error instanceof Error ? error.message : String(error)}\n`

/**
 * What a job says when it returns a non-zero status and does not throw.
 * It uses the same vocabulary {@link failureLine} uses for a job that
 * threw. See #81, round 7 ruling 2, `fixtures/divergences.json`
 * "exitStatus". `RepoJob` promises a status, but the real job, `syncRepo`,
 * never answers anything but 0. A test can reach this code only through a
 * stand-in it drives. This is the same way a test reaches `failureLine`,
 * through a job that throws.
 */
export const statusLine = (status: number): string =>
  `${REPORT.bad}the sync failed: exited with status ${status}\n`

/** The section a repository's job left, and whether that job counts as
 *  failed. Failed means a throw, or a non-zero status with no throw.
 *  This is data. It is never a mark the command re-reads out of the text
 *  (round 7 ruling B). A section can print its own `✗`, from a
 *  merge-proof lookup that could not be read. That does not mean this
 *  repository's job failed. */
export interface RepoResult {
  readonly section: string
  readonly failed: boolean
}

/**
 * The message `failed(...)` carries on stderr, once every line of the
 * report is already on stdout. It says how many repositories failed, out
 * of how many were tried. A skipped repository is not a failure, and this
 * count leaves it out.
 */
export const fanOutFailureMessage = (failedCount: number, total: number): string =>
  `${failedCount} of ${total} repositories failed to sync`

/** The single-repository path has just one repository. It names that
 *  repository, not "1 of 1". */
export const singleFailureMessage = (repo: string): string =>
  `the sync to ${path.basename(repo)} failed`

/** Append a failure line to a repository's buffered section. This handles
 *  the heading and the newline the same way {@link failureLine}'s own call
 *  site always has. A section with nothing written yet gets the
 *  repository's name first. A section whose last write did not end in a
 *  newline gets a newline before the failure line. This way, the failure
 *  never lands mid-line or under the previous repository's heading. */
const appendFailure = (chunks: string[], repo: string, line: string): void => {
  const written = chunks.join('')
  if (written === '') chunks.push(`${path.basename(repo)}\n`)
  else if (!written.endsWith('\n')) chunks.push('\n')
  chunks.push(line)
}

/** One repository's job, as the fan-out calls it. In the Python, a test
 *  reaches this seam by copying a stand-in script beside the orchestrator
 *  (`TIMED_JOB`, `SPLIT_JOB` in `tests/gh/test_gh_sync.py`). With the
 *  fan-out in-process, the stand-in is a function instead of a file. A
 *  test still asserts the throttle and the section order the same way. */
export type RepoJob = (options: SyncRepoOptions) => Promise<number>

/** What the command line asked for. */
export interface SyncRequest {
  /** The path as typed, which may be empty. This code substitutes the
   *  caller's own directory later, so that this field stays a parse
   *  result and nothing else. */
  readonly target: string
  readonly jobs: number
  readonly dryRun: boolean
  readonly noInstall: boolean
}

export type SyncArgs =
  | { readonly kind: 'run'; readonly request: SyncRequest }
  | { readonly kind: 'help'; readonly text: string }

/**
 * The command line, as `gh-sync.py:86` reads it.
 *
 * This parser is hand-written, not `lib/args.ts` `parseArguments`, for two
 * reasons that file names itself. First, `lib/args.ts` refuses positionals
 * outright: "a command that needs them can widen this with a test rather
 * than inherit an untested path". `lib/` is not this layer's to edit.
 * Second, this parser has no short option that takes a value, which `-j N`
 * and `-j4` both are. The refusal still travels as a `lib/envelope.ts`
 * refusal, exit 2. This is the status the captured contract records for
 * each of these cases.
 */
export const parseSyncArgs = (argv: readonly string[]): Envelope<SyncArgs> => {
  let dryRun = false
  let noInstall = false
  let jobs = DEFAULT_JOBS
  let target = ''
  // `-j` takes the next token, whatever it is, exactly as the Python's
  // `rest.pop(0)` did. A trailing `-j` names no value at all. That must
  // not become an invalid value: the default stands.
  let expectJobs = false
  for (const arg of argv) {
    if (expectJobs) {
      jobs = arg
      expectJobs = false
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--no-install') {
      noInstall = true
    } else if (arg === '-j') {
      expectJobs = true
    } else if (arg.startsWith('-j')) {
      jobs = arg.slice(2)
    } else if (arg === '-h' || arg === '--help') {
      return ok({ kind: 'help', text: HELP })
    } else if (arg.startsWith('-')) {
      return refused(`unknown flag: ${arg}`)
    } else {
      target = arg
    }
  }
  if (!JOBS_RE.test(jobs)) return refused(`invalid -j value: ${jobs}`)
  return ok({ kind: 'run', request: { target, jobs: Number(jobs), dryRun, noInstall } })
}

/**
 * Every repository's report, at most `jobs` active at a time.
 *
 * The answers come back in the order the repositories were given. That is
 * the order the report is written in, whatever order the jobs finished
 * in. The Python got that order from `pool.map`. Here, each worker takes
 * the next index and writes its answer into that slot.
 */
const runAll = async (
  repos: readonly string[],
  jobs: number,
  run: (repo: string) => Promise<RepoResult>,
): Promise<RepoResult[]> => {
  const reports: RepoResult[] = repos.map(() => ({ section: '', failed: false }))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const repo = repos[index]
      if (repo === undefined) return
      reports[index] = await run(repo)
    }
  }
  await Promise.all(repos.slice(0, jobs).map(worker))
  return reports
}

/**
 * The command, over a per-repository job.
 *
 * `job` is a parameter with a default, not an import. A test can then
 * drive the throttle, the section order, and a job's status with a
 * stand-in it writes. This is what `orchestrator_copy(gh, job=...)` did in
 * the Python, by copying a script. `runSync` below is this command with
 * the real job.
 */
export const createSyncCommand =
  (job: RepoJob = syncRepo): Command =>
  async (argv, context) => {
    const parsed = parseSyncArgs(argv)
    if (parsed.outcome !== 'ok') return parsed
    if (parsed.value.kind === 'help') return ok(parsed.value.text)
    const { jobs, dryRun, noInstall } = parsed.value.request
    // With no target the scope is the working directory, as the shell version
    // had it. The substitution is here rather than in the parser so that the
    // parser answers about argv alone.
    const target = parsed.value.request.target === '' ? context.cwd : parsed.value.request.target

    const found = await discoverRepos(target, context.env)
    if (found.outcome === 'not-a-directory') return refused(`not a directory: ${target}`)
    if (found.outcome === 'unreadable') {
      // "An unreadable target used to come back as an empty list, so a
      // directory the user cannot open reported 'No git repositories directly
      // inside' and exit 0. That is the wrong answer to a question that could
      // not be asked."
      return refused(`could not read ${target}: ${found.reason}`)
    }
    // This check runs after discovery, and before this code writes any
    // line. Discovery answers "no repositories" when git cannot run at
    // all: "without this check a machine with no git on PATH is told it
    // has 'No git repositories', which is a wiring mistake wearing the
    // answer to a different question".
    const unavailable = await gitUnavailable(context.env)
    if (unavailable !== null) return refused(`missing git: ${unavailable}`)

    const repos = found.roots
    const runOne = async (repo: string): Promise<RepoResult> => {
      // Each job collects its own lines. Several jobs run at once, and a
      // repository's lines belong together. An orchestrator that passed a
      // job's output through as it arrived would split a section in half.
      const chunks: string[] = []
      const report = createWriter({
        write(text: string) {
          chunks.push(text)
          return true
        },
        on() {
          // A buffer has no reader that can go away. So the EPIPE guard
          // `createWriter` installs has nothing to listen to here. The job
          // still gets the guarded writer. This way the job holds one kind
          // of writer, not two.
          return undefined
        },
      })
      let repoFailed = false
      try {
        const status = await job({
          repo,
          dryRun,
          noInstall,
          env: context.env,
          createGh: context.createGh,
          report,
        })
        // #81 (round 7 ruling A): a status that nobody reads is dead
        // weight. The real job, `syncRepo`, never answers anything but 0.
        // A stand-in that a test drives can answer non-zero and not throw.
        // That counts as a failure of this repository's job, exactly as a
        // throw does.
        if (status !== 0) {
          repoFailed = true
          appendFailure(chunks, repo, statusLine(status))
        }
      } catch (error) {
        // `gh-sync.py:123` to `:135` states the rule for a job that raises:
        // "would otherwise raise out of the pool and take every other
        // repository's report with it. It is this repo's answer, not the
        // run's." If this code leaves the error uncaught, `Promise.all`
        // rejects. This discards the header and every finished section,
        // after the work is already done. The process dies with a stack
        // trace that names no repository.
        //
        // A job that threw mid-line would otherwise get this text at the
        // end of that line. `gh-sync.py:171` to `:173` shows it that way.
        //
        // A job that threw before its FIRST line writes no heading. A bare
        // cross line then sits under the PREVIOUS repository's heading.
        // The report then blames a repository that synced cleanly.
        // `gh-sync.py:135` fixes this: it puts the basename into the
        // string it builds for a child that never ran.
        //
        // This code does the same. The name is the one `sync-repo.ts`
        // would have written itself. It is `path.basename` of the checkout
        // root, which is what discovery hands in. A section reads the
        // same either way.
        repoFailed = true
        appendFailure(chunks, repo, failureLine(error))
      }
      return { section: chunks.join(''), failed: repoFailed }
    }

    // A target inside a repo yields exactly that repo. This code sends the
    // report straight out: no header, no buffered output. A directory
    // that merely holds one repo is still a fan-out, and the output says
    // so.
    const only = repos.length === 1 ? repos[0] : undefined
    if (only !== undefined && (await toplevel(found.resolved, context.env)) !== null) {
      // #81: this code used to drop the status outright, the way the
      // shell version dropped it at its lines 72 to 73. See
      // `fixtures/divergences.json` "exitStatus". A skipped repository
      // is still exit 0 (`sync-repo.ts` always answers 0 for one). That
      // has not changed. Only a job that threw, or answered non-zero, now
      // makes this path answer `failed`.
      let repoFailed = false
      try {
        const status = await job({
          repo: only,
          dryRun,
          noInstall,
          env: context.env,
          createGh: context.createGh,
          report: context.output.out,
        })
        if (status !== 0) {
          repoFailed = true
          context.output.out.write(statusLine(status))
        }
      } catch (error) {
        // This gives the same account, but on a path with no section to
        // fold it into. `gh-sync.py:245` to `:251` did the same for a
        // child it could not start: it stated the error directly.
        repoFailed = true
        context.output.out.write(failureLine(error))
      }
      return repoFailed ? failed(singleFailureMessage(only)) : ok('')
    }

    if (repos.length === 0) {
      context.output.out.write(`No git repositories directly inside ${found.resolved}\n`)
      return ok('')
    }

    // The whole fan-out runs before this code writes a line of the
    // report, the way the shell version did. The reports come out in
    // directory order, not in the order the jobs finished.
    const results = await runAll(repos, jobs, runOne)
    context.output.out.write(`${found.resolved} (${repos.length} repos)\n\n`)
    for (const result of results) context.output.out.write(result.section)
    // #81: this code decides only after every section is already on
    // stdout, so the report never changes. The failure is data that the
    // command read from each job. It is never a scan of the text the
    // command just wrote (round 7 ruling B).
    const failedCount = results.filter((result) => result.failed).length
    return failedCount > 0 ? failed(fanOutFailureMessage(failedCount, repos.length)) : ok('')
  }

/** The command as `scripts/gh.ts` dispatches it. */
export const runSync: Command = createSyncCommand()
