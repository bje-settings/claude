// Sync the current checkout, or every checkout one level down: the port of
// `plugins/gh/scripts/gh-sync.py`.
//
// Scope comes from the target directory, so no caller has to classify it:
//   - the directory is a git repo     -> sync that repo
//   - the directory is not a git repo -> sync every immediate subdirectory
//                                        that is a git repo, non-recursively
//
// **The fan-out is IN-PROCESS** (the design ruling in the approved plan).
// `gh-sync.py` starts one `gh-sync-repo.py` process per repository; here the
// per-repository function is called directly, at most `-j N` at a time,
// because ADR 001 makes the command function the test seam and an injected
// `gh` mock cannot cross a process boundary. Each job buffers its own report,
// so the output order and the bytes are those of today: the reports are
// assembled in directory order, never in the order the jobs finished.
//
// What has no in-process counterpart goes with the child process, and the PR
// body lists each line and the test that pinned it: a child that could not be
// started, a child that exited non-zero, and a child a signal killed were all
// reported in the job's own section. A direct call cannot fail to start, and
// the real job, `syncRepo`, never answers anything but 0 (its own status is
// dead weight in production); `RepoJob`'s status exists for the stand-in a
// test drives, and #81 (round 7) is where a non-zero answer, like a throw,
// makes this command answer `failed` rather than being read by nobody.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; the file and line references below are to what they held at
// `cd0d515`, kept because each says where a rule came from.
import path from 'node:path'
import { discoverRepos, gitUnavailable, toplevel } from '../discover.ts'
import { type Envelope, failed, ok, refused } from '../lib/envelope.ts'
import { createWriter } from '../lib/streams.ts'
import { type Command, REPORT, type SyncRepoOptions, syncRepo } from './sync-repo.ts'

/** At most this many repositories are synced at a time when `-j` says
 *  nothing. */
export const DEFAULT_JOBS = '4'

// A -j that is not a positive integer is refused rather than clamped, which is
// what the shell version did too: it validated with this same pattern and
// exited 2. The reason it validated is that the value reached an arithmetic
// context, where a non-numeric word is 0 and the throttle would never let a
// job start, so an unchecked value hung the run rather than failing it.
// Nothing may quietly reinterpret it here either.
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
 * The in-process counterpart of the three lines `gh-sync.py` prints about a
 * child that failed (`:135`, `:174`, and the newline at `:171`). A direct call
 * cannot fail to start and has no exit status of its own, but it can throw,
 * and `syncRepo` deliberately lets anything that is not a `GhError` out. The
 * wording is this file's rather than the Python's, because the Python's names
 * a script and a status that no longer exist;
 * `fixtures/divergences.json` records it against the line it replaces.
 *
 * The mark is {@link REPORT}'s rather than a literal, because this is a report
 * line like any other and the SessionStart hook classifies it by that constant
 * (#110, `commands/hook-io.ts` `fanOutSummary`, which counts this line as a
 * repository that could not be fully checked). A literal here would let the
 * mark be reworded in one place and leave the hook quietly counting nothing.
 */
export const failureLine = (error: unknown): string =>
  `${REPORT.bad}the sync failed: ${error instanceof Error ? error.message : String(error)}\n`

/**
 * What a job that returned a non-zero status without throwing says, in the
 * same vocabulary {@link failureLine} uses for one that threw (#81, round 7
 * ruling 2, `fixtures/divergences.json` "exitStatus"). `RepoJob` promises a
 * status; the real job, `syncRepo`, never answers anything but 0, so this arm
 * is reachable only through a stand-in a test drives, the way `failureLine`
 * itself is reachable through one that throws.
 */
export const statusLine = (status: number): string =>
  `${REPORT.bad}the sync failed: exited with status ${status}\n`

/** The section a repository's job left, and whether that job counts as
 *  failed: a throw, or a non-zero status with no throw. Data, never a mark
 *  the command re-reads out of the text (round 7 ruling B): a section that
 *  happens to print a `✗` of its own, from a merge-proof lookup that could
 *  not be read, is not this repository's job failing. */
export interface RepoResult {
  readonly section: string
  readonly failed: boolean
}

/**
 * The message `failed(...)` carries on stderr, once every line of the report
 * is already on stdout: how many repositories failed, of how many were
 * tried. A skipped repository is not a failure and is not counted.
 */
export const fanOutFailureMessage = (failedCount: number, total: number): string =>
  `${failedCount} of ${total} repositories failed to sync`

/** The single-repository path has just the one, so it names it rather than
 *  saying "1 of 1". */
export const singleFailureMessage = (repo: string): string =>
  `the sync to ${path.basename(repo)} failed`

/** Append a failure line to a repository's buffered section, heading and
 *  newline handled the same way {@link failureLine}'s own call site always
 *  has: a section with nothing written yet gets the repository's name first,
 *  and a section whose last write did not end in a newline gets one before
 *  the failure line, so the failure never lands mid-line or under the
 *  previous repository's heading. */
const appendFailure = (chunks: string[], repo: string, line: string): void => {
  const written = chunks.join('')
  if (written === '') chunks.push(`${path.basename(repo)}\n`)
  else if (!written.endsWith('\n')) chunks.push('\n')
  chunks.push(line)
}

/** One repository's job, as the fan-out calls it. The seam the Python reaches
 *  by copying a stand-in script beside the orchestrator (`TIMED_JOB`,
 *  `SPLIT_JOB` in `tests/gh/test_gh_sync.py`): with the fan-out in-process,
 *  the stand-in is a function rather than a file, and the throttle and the
 *  section order are asserted the same way. */
export type RepoJob = (options: SyncRepoOptions) => Promise<number>

/** What the command line asked for. */
export interface SyncRequest {
  /** The path as typed, which may be empty: the caller's own directory is
   *  substituted later, so that this stays a parse and nothing else. */
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
 * Hand-written rather than `lib/args.ts` `parseArguments` for two reasons that
 * file names itself: it refuses positionals outright ("a command that needs
 * them can widen this with a test rather than inherit an untested path", and
 * `lib/` is not this layer's to edit), and it has no short option that takes a
 * value, which `-j N` and `-j4` both are. The refusal still travels as a
 * `lib/envelope.ts` refusal, exit 2, which is the status the captured contract
 * records for each of these.
 */
export const parseSyncArgs = (argv: readonly string[]): Envelope<SyncArgs> => {
  let dryRun = false
  let noInstall = false
  let jobs = DEFAULT_JOBS
  let target = ''
  // `-j` takes the next token whatever it is, exactly as the Python's
  // `rest.pop(0)` does, and a trailing `-j` names no value at all, which must
  // not become an invalid one: the default stands.
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
 * Every repository's report, at most `jobs` running at a time.
 *
 * The answers come back in the order the repositories were given, which is the
 * order the report is written in, whatever order the jobs finished in. The
 * Python gets that from `pool.map`; here each worker takes the next index and
 * writes its answer into that slot.
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
 * `job` is a parameter with a default rather than an import, so that the
 * throttle, the section order and a job's status can be driven by a stand-in
 * the test writes, which is what `orchestrator_copy(gh, job=...)` does in the
 * Python by copying a script. `runSync` below is this with the real one.
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
    // Asked after discovery and before a line is written, because discovery
    // answers "no repositories" when git cannot be run at all: "without this
    // check a machine with no git on PATH is told it has 'No git
    // repositories', which is a wiring mistake wearing the answer to a
    // different question".
    const unavailable = await gitUnavailable(context.env)
    if (unavailable !== null) return refused(`missing git: ${unavailable}`)

    const repos = found.roots
    const runOne = async (repo: string): Promise<RepoResult> => {
      // Each job collects its own lines. Several run at once, and a
      // repository's lines belong together: an orchestrator that passed a
      // job's output through as it arrived would split a section in half.
      const chunks: string[] = []
      const report = createWriter({
        write(text: string) {
          chunks.push(text)
          return true
        },
        on() {
          // A buffer has no reader to go away, so the EPIPE guard
          // `createWriter` installs has nothing to listen to here. The
          // guarded writer is still what the job is given, so the job holds
          // one kind of writer and not two.
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
        // #81 (round 7 ruling A): a status read by nobody is dead weight. The
        // real job, `syncRepo`, never answers anything but 0; a stand-in a
        // test drives can answer non-zero without throwing, and that counts
        // as this repository's job failing exactly as a throw does.
        if (status !== 0) {
          repoFailed = true
          appendFailure(chunks, repo, statusLine(status))
        }
      } catch (error) {
        // `gh-sync.py:123` to `:135` states the rule: a job that raises "would
        // otherwise raise out of the pool and take every other repository's
        // report with it. It is this repo's answer, not the run's." Left
        // uncaught, `Promise.all` rejects, the header and every finished
        // section are discarded after the work has already been done, and the
        // process dies with a stack trace naming no repository.
        //
        // A job that threw mid-line would otherwise have this appended to the
        // end of that line, as `gh-sync.py:171` to `:173` has it.
        //
        // A job that threw before its FIRST line has written no heading, and
        // a bare cross line then sits under the PREVIOUS repository's, so the
        // report blames a repository that synced cleanly. `gh-sync.py:135`
        // answers that by putting the basename in the string it builds for a
        // child that never ran, and this does the same: the name is the one
        // `sync-repo.ts` would have written itself
        // (`path.basename` of the checkout root, which is what discovery
        // hands in), so a section written either way reads alike.
        repoFailed = true
        appendFailure(chunks, repo, failureLine(error))
      }
      return { section: chunks.join(''), failed: repoFailed }
    }

    // A target inside a repo yields exactly that repo, and it runs with the
    // report going straight out: no header, no collecting. A directory that
    // merely holds one repo is still a fan-out, and says so.
    const only = repos.length === 1 ? repos[0] : undefined
    if (only !== undefined && (await toplevel(found.resolved, context.env)) !== null) {
      // #81: the status used to be dropped outright, as the shell version
      // dropped it at its lines 72 to 73 (`fixtures/divergences.json`
      // "exitStatus"). A skipped repository is still exit 0 (`sync-repo.ts`
      // always answers 0 for one), and that has not changed; only a job that
      // threw or answered non-zero now makes this path answer `failed`.
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
        // The same account on the path with no section to fold it into, which
        // is what `gh-sync.py:245` to `:251` does with a child it could not
        // start: it is said.
        repoFailed = true
        context.output.out.write(failureLine(error))
      }
      return repoFailed ? failed(singleFailureMessage(only)) : ok('')
    }

    if (repos.length === 0) {
      context.output.out.write(`No git repositories directly inside ${found.resolved}\n`)
      return ok('')
    }

    // The whole fan-out runs before a line of the report is written, as the
    // shell version did: the reports are assembled in directory order, not in
    // the order the jobs finished.
    const results = await runAll(repos, jobs, runOne)
    context.output.out.write(`${found.resolved} (${repos.length} repos)\n\n`)
    for (const result of results) context.output.out.write(result.section)
    // #81: decided only after every section is already on stdout, so the
    // report never changes and the failure is data the command read off each
    // job, never a scan of the text it just wrote (round 7 ruling B).
    const failedCount = results.filter((result) => result.failed).length
    return failedCount > 0 ? failed(fanOutFailureMessage(failedCount, repos.length)) : ok('')
  }

/** The command as `bin/gh.ts` dispatches it. */
export const runSync: Command = createSyncCommand()
