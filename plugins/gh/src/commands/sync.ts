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
// reported in the job's own section. A direct call has no exit status of its
// own and cannot fail to start.
import { discoverRepos, gitUnavailable, toplevel } from '../discover.ts'
import { type Envelope, ok, refused } from '../lib/envelope.ts'
import { createWriter } from '../lib/streams.ts'
import { type Command, type SyncRepoOptions, syncRepo } from './sync-repo.ts'

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
 */
export const failureLine = (error: unknown): string =>
  `  ✗ the sync failed: ${error instanceof Error ? error.message : String(error)}\n`

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
  run: (repo: string) => Promise<string>,
): Promise<string[]> => {
  const reports = repos.map(() => '')
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
    const runOne = async (repo: string): Promise<string> => {
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
      try {
        await job({
          repo,
          dryRun,
          noInstall,
          env: context.env,
          createGh: context.createGh,
          report,
        })
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
        const written = chunks.join('')
        if (written !== '' && !written.endsWith('\n')) chunks.push('\n')
        chunks.push(failureLine(error))
      }
      return chunks.join('')
    }

    // A target inside a repo yields exactly that repo, and it runs with the
    // report going straight out: no header, no collecting. A directory that
    // merely holds one repo is still a fan-out, and says so.
    const only = repos.length === 1 ? repos[0] : undefined
    if (only !== undefined && (await toplevel(found.resolved, context.env)) !== null) {
      // The status is deliberately dropped, as the shell version dropped it at
      // its lines 72 to 73: a skipped repo and a broken script both answer 0
      // here today. Tracked as issue #81, which lands after this port.
      try {
        await job({
          repo: only,
          dryRun,
          noInstall,
          env: context.env,
          createGh: context.createGh,
          report: context.output.out,
        })
      } catch (error) {
        // The same account on the path with no section to fold it into, which
        // is what `gh-sync.py:245` to `:251` does with a child it could not
        // start: it is said, and the status still does not change, "which is
        // the same reason this is not a `return 2`".
        context.output.out.write(failureLine(error))
      }
      return ok('')
    }

    if (repos.length === 0) {
      context.output.out.write(`No git repositories directly inside ${found.resolved}\n`)
      return ok('')
    }

    // The whole fan-out runs before a line of the report is written, as the
    // shell version did: the reports are assembled in directory order, not in
    // the order the jobs finished.
    const sections = await runAll(repos, jobs, runOne)
    context.output.out.write(`${found.resolved} (${repos.length} repos)\n\n`)
    for (const section of sections) context.output.out.write(section)
    return ok('')
  }

/** The command as `bin/gh.ts` dispatches it. */
export const runSync: Command = createSyncCommand()
