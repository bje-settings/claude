// This file has the deterministic per-pull-request steps of `/gh:shepherd`.
// It is the port of `plugins/gh/scripts/gh-shepherd-pr.py`.
//
// Every action prints one JSON object: `{"action", "repo", "number", "ok",
// "detail", ...}`. The keys stay in the order the Python wrote them. An
// agent reads the document by name, and a human reads it in a transcript.
// The agent that runs the loop decides which action comes next. This file
// only does the step. It refuses a step whose preconditions do not hold.
// A confused caller cannot make it act on the wrong pull request.
//
// **Time is an argument.** `rebase`, `wait` and `settle` each poll until
// their own bound. The clock and the sleep come in through `ShepherdContext`.
// This lets the tests drive every bound to its end, with no real wait. The
// wait and settle bounds are the Python's numbers (#106 measures the settle
// bound). The rebase bound and the wait interval are new at #460.
//
// The command function is the seam (ADR 001). Its inputs are the arguments,
// the environment, an injected `gh`, the clock, the sleep, and the output
// writers. Its output is an exit status. Nothing is spawned, and no `gh` is
// on PATH.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from
// the tree. The file and line references below point to what they held at
// `cd0d515`. This file keeps them because each one says where a rule came
// from.
import { GhError } from '../lib/gh.ts'
import { toplevel } from '../lib/git.ts'
import type { Writer } from '../lib/streams.ts'
import {
  type CheckProgress,
  checkProgress,
  directoryRefusal,
  isTruthy,
  jobLink,
  missingField,
  oneLine,
  type PullSummary,
  pendingRuns,
  readReviewRules,
  readUnresolvedThreads,
  type ShepherdContext,
  type ShepherdExit,
  summary,
  tailLines,
} from '../shepherd.ts'

const NUMBER_RE = /^[1-9][0-9]*$/
const DIGITS_RE = /^[0-9]+$/
const POSITIVE_RE = /^[1-9][0-9]*$/

/** The colour codes the log viewer would render. In a JSON string this
 *  is noise, and the agent that reads the tail cannot see it anyway.
 *
 *  This code builds the pattern instead of writing it as a literal. An
 *  escape is a control character. A linter forbids a regular expression
 *  literal from carrying one. The whole point here is to match one. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const DEFAULT_CI_SECONDS = 300
const DEFAULT_LOG_LINES = 60

/** The bound on a single `wait`, so it fits inside a ten-minute tool call. The
 *  caller re-invokes `wait` when it returns `pending`. */
const WAIT_BOUND_MIN = 120
const WAIT_BOUND_MAX = 540

/** How often `wait` reads the pull request and the compare, in seconds. Each
 *  read is three `gh` calls: the pull request, the repository and the
 *  compare. A 540 second bound is 19 reads, so 57 calls. A pending read
 *  adds one call for each Actions run with a pending check, and one for the
 *  date of the head when no check has a stamp (#466). A failed check adds
 *  one call for its log (#460). */
const WAIT_POLL_DEFAULT = 30

/** The least time, in seconds, that the checks of a head may make no
 *  progress before `wait` reports `stalled` (#466). The bound is the
 *  largest of this, twice `ci_seconds`, and the run's own time so far. So
 *  a `ci_seconds` that is too small (#463) cannot make the bound smaller.
 *  1620 seconds is three default `wait` calls at their longest, 540 seconds
 *  each (`WAIT_BOUND_MAX`). That is what the agent's old rule of three
 *  `pending` results allowed, so no healthy long step skips sooner than it
 *  did before #466 (ruling 14). */
const STALL_FLOOR_DEFAULT = 1620

/** Compare statuses that say the head does not contain the tip of its base.
 *  `diverged` is in this list too: the base has commits that the head lacks.
 *  Under a strict up-to-date rule, auto-merge cannot fire on such a head.
 *  So `wait` does not wait for its checks (#460). */
const BEHIND_STATUSES = ['behind', 'diverged']

// How long `settle` continues to read, when GitHub reports nothing either
// way, and how often it reads. This is deliberately a constant, not
// something derived from SHEPHERD_CI_SECONDS. That number is the measured
// median of the repository's own workflow runs. What `settle` waits on is
// GitHub's auto-merge latency, after the checks already show green. The
// length of a CI run says nothing about that latency.
//
// 90 seconds is a guess, the only one here that decides an outcome. It
// does not merely size a bound. This guess is survivable, because `settle`
// rarely reaches it. Every state GitHub can report that decides the
// question ends the poll early. This bound only covers a pull request
// where GitHub has said nothing decisive. #106 measures it; the port
// carries it as it is.
const SETTLE_BOUND_DEFAULT = 90
const SETTLE_POLL_DEFAULT = 5

// How long `rebase` reads the pull request for a moved head, and how often
// (ruling 16 on #460). `gh pr update-branch` returns when GitHub accepts the
// request, and GitHub applies it some seconds later. Without this poll the
// caller reads an unmoved head, calls `wait`, gets `behind` at once, and
// rebases again. The agent passes no timeout on a `rebase` call, so the
// Bash tool cuts it off at 120 seconds. The 60 second bound counts the reads
// too. It leaves time for the branch update and the last read. Five seconds
// is settle's interval: a moved head costs at most five seconds more.
const REBASE_BOUND_DEFAULT = 60
const REBASE_POLL_DEFAULT = 5

/** gh's line for a branch that already holds its base. The head will not
 *  move, so `rebase` does not poll for it. */
const UP_TO_DATE_RE = /already up[- ]to[- ]date/i

/** Merge states that prove auto-merge cannot fire now. BLOCKED means a
 *  required review, or a required check that has not reported. Either way,
 *  GitHub will not merge. This code does not read BLOCKED from a single
 *  sample, though. GitHub reports BLOCKED while it still reconciles a check
 *  that has only just gone green. That is the same window `settle` exists
 *  to wait through. A BLOCKED reading must survive a second poll before it
 *  counts. */
const BLOCKING_MERGE_STATES = ['BLOCKED']

/** Merge states that are not a verdict but a new question: the base moved
 *  under the pull request while settle watched. */
const RECHECK_MERGE_STATES = ['BEHIND', 'DIRTY']

/** Review decisions that prove auto-merge cannot fire. `""` (no review
 *  required) and APPROVED are not among them. Neither one gives `settle` a
 *  reason to stop. */
const BLOCKING_REVIEW_DECISIONS = ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']

/** Checks states that `settle` will act on. Anything else is `wait`'s job.
 *  `settle` refuses instead. It does not quietly wait out a run it should
 *  have watched. */
const SETTLED_CHECK_STATES = ['passed', 'none']

/** A pull request as `state` and `wait` report it: the summary, and whether
 *  the head is behind its base. `true` and `false` come from the compare.
 *  `null` means the compare could not be read, so the caller decides from
 *  `mergeStateStatus`. */
type PullState = PullSummary & { readonly behind: boolean | null }

/** Whether the head of a pull request is the commit its branch points at
 *  (#467). Only `state` reads the ref, so only its `pr` carries this.
 *  `branchRefOid` is the commit of the branch ref. `inSync` is `false` when
 *  it differs from `headRefOid`. Both are `null` for a pull request from
 *  another repository, which has no branch here to read, and for a read
 *  that failed. stderr then says why. */
type BranchSync =
  | { readonly branchRefOid: string; readonly inSync: boolean }
  | { readonly branchRefOid: null; readonly inSync: null }

const NO_SYNC: BranchSync = { branchRefOid: null, inSync: null }

export const HELP = `The deterministic per-pull-request steps of /gh:shepherd.

Usage:
  gh.ts shepherd-pr <path> <number> state
  gh.ts shepherd-pr <path> <number> rebase
  gh.ts shepherd-pr <path> <number> wait
  gh.ts shepherd-pr <path> <number> settle
  gh.ts shepherd-pr <path> <number> merged

Every action prints one JSON object: {"action", "ok", "detail", ...}. The
agent running the loop decides which action comes next; this only does the
step, and refuses steps whose preconditions do not hold, so a confused caller
cannot make it act on the wrong pull request.

  state     the pull request as \`summary\` shapes it (see src/shepherd.ts),
            plus \`pr.behind\`. It is true when the compare of baseRefName
            and the head is behind or diverged. It is false when the compare
            is ahead or identical. It is null when the compare could not be
            read (stderr says why). Then \`pr.branchRefOid\`, the commit of
            the ref of headRefName, and \`pr.inSync\`. \`inSync\` is false
            when that commit is not headRefOid: GitHub has not moved the
            pull request to the newest push of its branch. The detail then
            names both commits. Both are null for a pull request from
            another repository (no read), and for a ref that could not be
            read (stderr says why). \`pr.approval\` (met, missing,
            not_required) and \`pr.threads\` (resolved, unresolved,
            not_required) come from the review rules of baseRefName,
            reviewDecision and the reviews. The threads are read only when
            the rules ask for resolved threads. \`approval\` is null when the
            rules could not be read and reviewDecision is empty. \`threads\`
            is null when the rules or the threads could not be read. stderr
            says why.
            The other actions read neither, so their \`pr.approval\` rests
            on reviewDecision alone, and \`pr.threads\` is null.
  rebase    gh pr update-branch --rebase. Refuses unless the pull request is
            open. Then reads the pull request every SHEPHERD_REBASE_POLL
            seconds until the head moves, or until SHEPHERD_REBASE_BOUND.
            The bound includes the time of each read. \`result\` is one of:
            \`moved\`; \`unmoved\` (the update is still queued at the bound);
            \`up_to_date\` (gh said the branch holds its base, so one read).
            Reports the head SHA before and after, with \`waited\`,
            \`reads_ok\`, \`read_failures\` and \`read_error\`. The LAST read
            decides. When it failed, the report is still \`ok: true\`,
            because the update ran. It then has \`after\` empty and no
            \`result\`.
  wait      reads the pull request and the compare until it can answer, or
            until its bound (see below). A head that is behind returns
            \`behind\` at once, with no poll. Otherwise it reads again every
            SHEPHERD_WAIT_POLL seconds. Result is one of: merged; behind;
            failed (on the first failed rollup); passed; stalled; pending
            (at the bound). \`stalled\` and \`pending\` carry \`progress\`:
            \`finished\` and \`checks\` (rows done, and all rows), \`started\`
            and \`newest\` (the oldest and newest stamp), \`idle\` (seconds
            from \`newest\` to the wall clock), \`stall_bound\` and \`source\`.
            The stamps are the startedAt and completedAt of each rollup row,
            and of each job and step of each Actions run with a pending
            check (one read of the jobs of each such run, per poll).
            \`stalled\` means \`idle\` reached \`stall_bound\`: no check, job
            or step started or finished for that long. The bound is the
            largest of SHEPHERD_STALL_FLOOR, twice ci_seconds, and the run's
            own time from \`started\` to \`newest\`. So a long run gets a long
            bound, and a ci_seconds that is too small cannot make the bound
            smaller. A poll whose jobs read fails, in full or in part, is
            never \`stalled\`: the steps it missed may have moved (stderr says
            why). With no stamp at all, the newer of the head commit's date
            and the pull request's updatedAt is the one stamp, and \`source\`
            is \`head commit\`. So a check that never starts still ends in
            \`stalled\`, and a commit made long before its push does not stall
            at once. With neither date, \`idle\` is null (stderr says why).
            Each call decides from what it reads, so a caller counts nothing.
            On failed, \`failing\` lists the failed checks, and \`log_tail\`
            carries the failed steps' log.
            \`log_error\` is beside it when gh would not hand the log over.
            \`waited\` is measured. \`reads_ok\`, \`read_failures\` and
            \`read_error\` say how the reads went. As in settle, the LAST
            read decides. A bound that arrives on a failed read is
            \`ok: false\`, never \`pending\`.
  settle    the grace between "checks passed" and "auto-merge did not fire".
            Reads the pull request until GitHub answers one way or the other:
            \`merged\`; \`closed\` when it was closed while settling; \`blocked\`
            when a read proves auto-merge cannot fire (a BLOCKED merge state
            seen on two reads, or a reviewDecision of REVIEW_REQUIRED or
            CHANGES_REQUESTED on one), naming the fields it read; \`changed\`
            when the merge state moved to BEHIND or DIRTY, so the caller
            decides again; \`open\` when the bound passed with GitHub saying
            nothing either way. \`waited\` is measured, and \`reads_ok\`,
            \`read_failures\` and \`read_error\` say how the reading itself went.
            The LAST read decides: a bound that arrives on a read that failed
            is \`ok: false\` rather than \`open\`, while a failure that a later
            successful read followed is counted and nothing more.
            Refuses a pull request that is CLOSED, has no auto-merge, or whose
            checks are neither passed nor absent; an already MERGED one is
            answered, not refused. Never watches checks (that is \`wait\`),
            never comments, and never merges.
  merged    whether the pull request is MERGED, and its merge commit.

This command never merges, never enables or disables auto-merge, never edits a
label, and never bypasses a check. The only write is the rebase, and nothing
else.

Environment:
  SHEPHERD_CI_SECONDS    typical CI wall time, from gh.ts shepherd-status
                         (default 300). The wait bound is twice this, clamped
                         to [120, 540] so it fits inside a ten-minute tool
                         call; the caller re-invokes \`wait\` on \`pending\`.
  SHEPHERD_LOG_LINES     lines of failed-step log to keep (default 60).
  SHEPHERD_WAIT_BOUND    override the computed wait bound, in seconds. For
                         tests and for repos whose CI is far from typical.
  SHEPHERD_WAIT_POLL     interval between two wait reads (default 30).
  SHEPHERD_STALL_FLOOR   the least \`stall_bound\`, in seconds, when twice
                         ci_seconds is not larger (default 1620).
  SHEPHERD_SETTLE_BOUND  how long \`settle\` waits with no evidence either way,
                         in seconds (default 90).
  SHEPHERD_SETTLE_POLL   interval between two settle reads (default 5).
  SHEPHERD_REBASE_BOUND  how long \`rebase\` reads for a moved head, in
                         seconds (default 60).
  SHEPHERD_REBASE_POLL   interval between two rebase reads (default 5).

Exits 0 when the action ran and reported (including ok:false refusals), 2 on
a usage error, 1 when gh could not answer at all, and 3 on an internal error,
which is outside the documented set so a caller cannot mistake it for an
answer.`

/**
 * An integer from the environment, or the default for anything else.
 *
 * A stray value must not decide a run. This is why an unparseable value
 * falls back to the default, rather than failing. The shell version
 * validated with these same patterns, for the same reason. Unlike the
 * shell version, this code reports the fallback on stderr. The JSON on
 * stdout that the caller parses stays untouched. A silent fallback is how
 * a bound nobody meant to use ends up governing a whole run.
 */
const envInt = (
  env: NodeJS.ProcessEnv,
  err: Writer,
  name: string,
  fallback: number,
  pattern: RegExp = DIGITS_RE,
): number => {
  const raw = env[name] ?? ''
  // A variable set to nothing counts as unset. `os.environ.get(name, "")`
  // folds both cases together.
  if (raw === '') return fallback
  if (!pattern.test(raw)) {
    err.write(`${name}=${raw} ignored; using ${fallback}\n`)
    return fallback
  }
  return Number(raw)
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high))

/** What a `gh` failure said, in one line. For anything else, this
 *  re-throws the error. This uses `GhError.detail`, never `message`: the
 *  message carries the whole argv, and these reports quote gh. */
const ghAccount = (error: unknown): string => {
  if (error instanceof GhError) return oneLine(error.detail)
  throw error
}

/** The measured seconds of a duration in milliseconds, as `int()` read the
 *  monotonic clock: truncated, never rounded up. */
const seconds = (milliseconds: number): number => Math.floor(milliseconds / 1000)

interface WorkerOptions {
  readonly repo: string
  readonly number: number
  readonly action: string
  readonly ciSeconds: number
  readonly logLines: number
  readonly context: ShepherdContext
  readonly gh: ReturnType<ShepherdContext['createGh']>
}

/** One action against one pull request. */
class Shepherd {
  readonly options: WorkerOptions
  /** gh's own words from the last read. A caller that polls can then say
   *  why a read failed. It need not treat the silence as a fact about the
   *  pull request. */
  readErr = ''

  constructor(options: WorkerOptions) {
    this.options = options
  }

  // ------------------------------------------------------------- output ---

  /**
   * Print the one JSON object this action reports.
   *
   * The Python went quiet after a broken pipe. This let a rebase that had
   * already run finish its own report, rather than stop half-way through
   * it. The writer here does the same (`lib/streams.ts`: EPIPE and
   * nothing else), for every write in the plugin, not only this one.
   */
  emit(ok: boolean, detail: string, extra: Record<string, unknown> = {}): void {
    const document = {
      action: this.options.action,
      repo: this.options.repo,
      number: this.options.number,
      ok,
      detail,
      ...extra,
    }
    this.options.context.output.out.write(`${JSON.stringify(document, null, 2)}\n`)
  }

  // ----------------------------------------------------------------- gh ---

  /**
   * The pull request as `summary` shapes it, or `null` if gh cannot answer.
   *
   * {@link readErr} is left with the reason, so a caller can report the
   * reason instead of the silence. One such reason is an answer that is
   * missing a field the loop decides from. `summary` shapes whatever it is
   * given. An empty object comes back out of it as a pull request whose
   * checks are `none`, which `wait` then reads as passed.
   */
  async readPr(): Promise<PullSummary | null> {
    const pull = await this.readPull()
    return pull === null ? null : summary(pull)
  }

  /** The pull request as gh answered it, once {@link missingField} has
   *  passed it, or `null` with {@link readErr} set. `state` shapes it with
   *  the review rules of its base. */
  async readPull(): Promise<Record<string, unknown> | null> {
    let pull: Record<string, unknown>
    try {
      pull = await this.options.gh.viewPullRequest({ pullRequest: this.options.number })
    } catch (error) {
      this.readErr = ghAccount(error)
      return null
    }
    const missing = missingField(pull)
    if (missing !== '') {
      this.readErr = `gh answered without ${missing}`
      return null
    }
    this.readErr = ''
    return pull
  }

  /**
   * Whether the head lacks commits of its base, from GitHub's compare.
   *
   * `mergeStateStatus` cannot answer this. While a required check is
   * pending, GitHub reports BLOCKED in place of BEHIND (#460). A compare
   * that could not be read is `null`, not a failed read. The caller then
   * decides from the merge state, as it did before #460. stderr carries
   * the reason, so the null is never a silence.
   */
  async withBehind(pull: PullSummary): Promise<PullState> {
    // `missingField` refuses an answer without either name, so both are
    // names gh gave.
    const base = String(pull.baseRefName)
    const head = String(pull.headRefOid)
    const answer = await this.options.gh.compareCommits({ base, head })
    if (answer.comparison === null) {
      this.options.context.output.err.write(
        `behind is null: the compare of ${base}...${head} is unavailable: ${answer.unavailable}\n`,
      )
      return { ...pull, behind: null }
    }
    return { ...pull, behind: BEHIND_STATUSES.includes(answer.comparison.status) }
  }

  /** `[succeeded, gh's output on one line]` for a mutating call. */
  async ghText(call: Promise<string>): Promise<[boolean, string]> {
    try {
      return [true, oneLine(await call)]
    } catch (error) {
      return [false, ghAccount(error)]
    }
  }

  /** Why the last read did not answer, for the three reports that quote
   *  it.
   *
   *  This code checks truthiness, not null. A gh call that failed with
   *  nothing to say leaves an empty account. This command refuses to
   *  report that silence anywhere. One function replaces the Python's
   *  three copies of the same `or`, so the three copies cannot drift
   *  apart. */
  readFailure(): string {
    return this.readErr || 'gh returned no JSON object'
  }

  /** Refuse, and state what gh said, rather than report the silence. A
   *  caller that polls, and a human who reads the transcript afterward,
   *  cannot tell a deleted pull request from an expired token without
   *  this. */
  unreadable(): void {
    this.emit(false, `could not read pull request #${this.options.number}: ${this.readFailure()}`)
  }

  refuseNotOpen(pull: PullSummary): void {
    this.emit(false, `refused: pull request is ${String(pull.state)}, not OPEN`, { pr: pull })
  }

  /**
   * Whether the head of the pull request is the commit its branch points
   * at, from the branch ref (#467).
   *
   * GitHub can keep an old `headRefOid` after a push to the branch. Then
   * `update-branch` refuses, or says the branch is up to date, and the
   * compare goes on to read it as behind. A pull request from another
   * repository has no branch here, so it gets no read. Nor does an answer
   * that does not say which repository the head is in: `main` of a fork
   * read as `main` here would differ, and give a false verdict. A read that
   * failed is `null`, and stderr says why.
   */
  async withSync(pull: Record<string, unknown>): Promise<BranchSync> {
    if (pull.isCrossRepository === true) return NO_SYNC
    const err = this.options.context.output.err
    const branch = pull.headRefName
    const missing =
      pull.isCrossRepository !== false
        ? 'isCrossRepository'
        : !isTruthy(branch)
          ? 'headRefName'
          : ''
    if (missing !== '') {
      err.write(`inSync is null: gh answered without ${missing}\n`)
      return NO_SYNC
    }
    const name = String(branch)
    const answer = await this.options.gh.branchRef({ branch: name })
    if (answer.sha === null) {
      err.write(`inSync is null: the ref of ${name} is unavailable: ${answer.unavailable}\n`)
      return NO_SYNC
    }
    return { branchRefOid: answer.sha, inSync: answer.sha === pull.headRefOid }
  }

  /** Each line {@link note} has written in this action, so a poll that
   *  meets the same failure again does not write it again. */
  readonly noted = new Set<string>()

  /** Write `line` to stderr, once per action. */
  note(line: string): void {
    if (this.noted.has(line)) return
    this.noted.add(line)
    this.options.context.output.err.write(`${line}\n`)
  }

  /**
   * The progress of the checks of `pull` now, with `least` as the least
   * stall bound (#466).
   *
   * The stamps of one job do not move until it finishes, so this also
   * reads the steps of each Actions run that has a pending check (ruling
   * 12 on #466). A step that starts or finishes moves `newest`. A run whose
   * jobs could not be read, in full or in part, keeps the steps it read,
   * and stderr says which. `missed` is then true: the steps that were not
   * read may have moved, so that read is no proof of a stall. A check that
   * is not an Actions job has only its own stamps.
   *
   * A rollup with no stamp at all is measured from the newer of the date of
   * the head commit and the last update of the pull request (ruling 13 on
   * #466). So a check that never started still ends in `stalled`. A push
   * moves `updatedAt`, so a commit made long before its push does not stall
   * at once. When neither time can be read, `idle` is null, and stderr says
   * why.
   */
  async progressOf(
    pull: Record<string, unknown>,
    least: number,
  ): Promise<{ readonly progress: CheckProgress; readonly missed: boolean }> {
    const gh = this.options.gh
    const stamps: (string | null)[] = []
    let missed = false
    for (const run of pendingRuns(pull)) {
      const answer = await gh.listRunJobs({ run })
      if (answer.unavailable !== null) {
        missed = true
        this.note(`progress may miss steps of run ${run}: ${answer.unavailable}`)
      }
      for (const job of answer.rows) {
        stamps.push(job.startedAt, job.completedAt)
        for (const step of job.steps) stamps.push(step.startedAt, step.completedAt)
      }
    }
    const wall = this.options.context.clock()
    const progress = checkProgress(pull, wall, least, { stamps })
    if (progress.idle !== null) return { progress, missed }
    // `missingField` refuses an answer without `headRefOid`.
    const sha = String(pull.headRefOid)
    const commit = await gh.commitDate({ sha })
    if (commit.date === null) {
      this.note(`the date of ${sha} is unavailable: ${commit.unavailable}`)
    }
    const since = [commit.date, pull.updatedAt]
    const measured = checkProgress(pull, wall, least, { stamps, since })
    if (measured.idle === null) {
      this.note('idle is null: no check has a stamp, and the head has no date to read')
    }
    return { progress: measured, missed }
  }

  // ------------------------------------------------------------ actions ---

  async state(): Promise<void> {
    const pull = await this.readPull()
    if (pull === null) return this.unreadable()
    // `missingField` refuses an answer without `baseRefName`, so it is a
    // name gh gave.
    const err = this.options.context.output.err
    const rules = await readReviewRules(this.options.gh, String(pull.baseRefName), err)
    // The threads are read only when the rules ask for them (#465).
    const unresolved =
      rules?.threadResolution === true
        ? await readUnresolvedThreads(this.options.gh, this.options.number, err)
        : null
    const shaped = await this.withBehind(summary(pull, rules, unresolved))
    const sync = await this.withSync(pull)
    // `missingField` refuses an answer without `headRefOid`, so it is a
    // commit gh named.
    const detail =
      sync.inSync === false
        ? `the pull request's head is out of sync with its branch: headRefOid ` +
          `${String(pull.headRefOid)}, ${String(pull.headRefName)} at ${sync.branchRefOid}`
        : 'read'
    this.emit(true, detail, { pr: { ...shaped, ...sync } })
  }

  async merged(): Promise<void> {
    const pull = await this.readPr()
    if (pull === null) return this.unreadable()
    if (pull.state === 'MERGED') {
      this.emit(true, 'merged', { merged: true, mergeCommit: pull.mergeCommit })
      return
    }
    this.emit(true, `not merged: ${String(pull.state)}`, { merged: false })
  }

  async rebase(): Promise<void> {
    const pull = await this.readPr()
    if (pull === null) return this.unreadable()
    if (pull.state !== 'OPEN') return this.refuseNotOpen(pull)
    const before = pull.headRefOid
    const [posted, out] = await this.ghText(
      this.options.gh.updateBranch({ pullRequest: this.options.number, rebase: true }),
    )
    if (!posted) {
      this.emit(false, `rebase failed: ${out}`, { before })
      return
    }
    const upToDate = UP_TO_DATE_RE.test(out)
    const env = this.options.context.env
    const err = this.options.context.output.err
    const bound = envInt(env, err, 'SHEPHERD_REBASE_BOUND', REBASE_BOUND_DEFAULT, POSITIVE_RE)
    const interval = envInt(env, err, 'SHEPHERD_REBASE_POLL', REBASE_POLL_DEFAULT, POSITIVE_RE)
    // Two limits end the loop. The clock includes the time of each read, so
    // slow reads cannot push the call past the bound. A count of polls is
    // the second limit. A sleep that does not move the clock then cannot
    // keep this loop alive.
    const polls = upToDate ? 0 : Math.ceil(bound / interval)
    const started = this.options.context.now()
    const spent = (): number => seconds(this.options.context.now() - started)

    let fresh: PullSummary | null = null
    let readsOk = 0
    let readsFailed = 0
    for (let poll = 0; ; poll += 1) {
      const read = await this.readPr()
      if (read === null) {
        readsFailed += 1
      } else {
        readsOk += 1
      }
      fresh = read
      // `missingField` refuses an empty `headRefOid` before `readPr`
      // answers. So a head here is a head gh named, and needs no `or ""`.
      if (read !== null && read.headRefOid !== before) break
      if (poll >= polls || spent() >= bound) break
      // `spent()` is whole seconds below `bound` here, so this sleep is at
      // least one second. The last sleep stops at the bound.
      await this.options.context.sleep(Math.min(interval, bound - spent()) * 1000)
    }
    const reading = {
      waited: spent(),
      reads_ok: readsOk,
      read_failures: readsFailed,
      read_error: fresh === null ? this.readFailure() : '',
    }
    if (fresh === null) {
      // The branch update ran. Only the last confirming read failed, and
      // the last read decides. So this report has no `result`. With
      // `ok: false`, the caller would rebase a second time. That costs
      // another CI run for a read that failed.
      this.emit(
        true,
        `update-branch succeeded but the pull request could not be re-read: ${this.readFailure()}`,
        { before, after: '', pr: null, output: out, ...reading },
      )
      return
    }
    const after = fresh.headRefOid
    if (after !== before) {
      this.emit(true, 'rebased', {
        before,
        after,
        pr: fresh,
        output: out,
        result: 'moved',
        ...reading,
      })
      return
    }
    // `gh pr update-branch` prints its success line as soon as GitHub
    // accepts the request. An unmoved head is not "rebased": no new CI run
    // may start.
    if (upToDate) {
      this.emit(
        true,
        'update-branch reported the branch already up to date with its base; the head has not moved',
        { before, after, pr: fresh, output: out, result: 'up_to_date', ...reading },
      )
      return
    }
    this.emit(
      true,
      `update-branch reported success and the head has not moved after ${reading.waited}s: the ` +
        'update is still queued',
      { before, after, pr: fresh, output: out, result: 'unmoved', ...reading },
    )
  }

  async wait(): Promise<void> {
    let raw = await this.readPull()
    if (raw === null) return this.unreadable()
    const first = summary(raw)
    if (first.state === 'MERGED') {
      this.emit(true, 'merged', { result: 'merged', pr: first })
      return
    }
    // The compare comes before the checks. A head that is behind goes back
    // to the caller at once, whatever the checks say. A green run on it
    // cannot let auto-merge fire, so its CI time would be lost.
    let pull = await this.withBehind(first)
    if (pull.behind !== true && pull.checks.state === 'none') {
      this.emit(true, 'no checks reported on this head', { result: 'passed', pr: pull })
      return
    }

    const env = this.options.context.env
    const err = this.options.context.output.err
    const bound = envInt(
      env,
      err,
      'SHEPHERD_WAIT_BOUND',
      clamp(this.options.ciSeconds * 2, WAIT_BOUND_MIN, WAIT_BOUND_MAX),
      POSITIVE_RE,
    )
    // `POSITIVE_RE` rejects 0, for settle's reason: a zero interval never
    // reaches the deadline.
    const interval = envInt(env, err, 'SHEPHERD_WAIT_POLL', WAIT_POLL_DEFAULT, POSITIVE_RE)
    const floor = envInt(env, err, 'SHEPHERD_STALL_FLOOR', STALL_FLOOR_DEFAULT, POSITIVE_RE)
    // A check with no steps to read, such as one that is not an Actions
    // job, stamps only when it starts and finishes. So a check as long as
    // the median run is not a stall (#466).
    const least = Math.max(floor, this.options.ciSeconds * 2)
    // The progress of the last read that succeeded, at the time of that
    // read. It needs no state between two calls: the stamps are GitHub's.
    // Only pending checks need it, so only a pending read pays its reads.
    let progress: CheckProgress | null = null
    const measure = async (): Promise<{ progress: CheckProgress; missed: boolean }> => {
      const measured = await this.progressOf(raw as Record<string, unknown>, least)
      progress = measured.progress
      return measured
    }
    // Measured, not added up from the sleeps, for settle's reason.
    const started = this.options.context.now()
    const spent = (): number => seconds(this.options.context.now() - started)

    let readsOk = 1
    let readsFailed = 0
    // Whether the most recent read failed. This follows settle's rule. A
    // failed read says nothing about the pull request, so it gets no
    // verdict. A bound that arrives on one is `ok: false`, because `pull`
    // is then older than the bound this would report.
    let stale = false
    while (true) {
      if (!stale) {
        const reading = {
          waited: spent(),
          reads_ok: readsOk,
          read_failures: readsFailed,
          // `readPr` clears its error on each read that succeeds, and a
          // verdict comes only from one. A failure that a later read
          // recovered from is counted, and nothing more.
          read_error: '',
        }
        if (await this.waitVerdict(pull, reading, measure)) return
      }
      const left = bound - spent()
      if (left <= 0) break
      // The last sleep stops at the bound, so no sleep goes past it.
      await this.options.context.sleep(Math.min(interval, left) * 1000)
      const fresh = await this.readPull()
      if (fresh === null) {
        readsFailed += 1
        stale = true
        continue
      }
      readsOk += 1
      stale = false
      raw = fresh
      pull = await this.withBehind(summary(raw))
    }

    if (stale) {
      this.emit(
        false,
        `wait waited ${spent()}s but could not re-read the pull request (${readsFailed} of ` +
          `${readsOk + readsFailed} reads failed, the last among them): ${this.readErr}`,
        {
          bound,
          waited: spent(),
          reads_ok: readsOk,
          read_failures: readsFailed,
          read_error: this.readErr,
          pr: pull,
        },
      )
      return
    }
    // This is the time actually spent, not the bound. A caller that sizes
    // its next call reads this number.
    this.emit(true, `checks still running after ${spent()}s`, {
      result: 'pending',
      bound,
      pr: pull,
      waited: spent(),
      reads_ok: readsOk,
      read_failures: readsFailed,
      read_error: '',
      progress,
    })
  }

  /**
   * Report the read that answers `wait`, and say whether one did.
   *
   * Pending checks answer nothing, so the caller reads again, unless they
   * made no progress for the stall bound (#466). Every other read is final.
   * These are merged, a head behind its base, and a rollup that passed or
   * has no checks. A rollup with a failed check is final too. It does not
   * wait for the rest of the run, as `--fail-fast` did before #460.
   */
  async waitVerdict(
    pull: PullState,
    reading: Record<string, unknown>,
    measure: () => Promise<{ readonly progress: CheckProgress; readonly missed: boolean }>,
  ): Promise<boolean> {
    if (pull.state === 'MERGED') {
      this.emit(true, 'merged', { result: 'merged', pr: pull, ...reading })
      return true
    }
    if (pull.behind === true) {
      this.emit(
        true,
        `the head does not contain the tip of ${String(pull.baseRefName)}; rebase it before ` +
          'waiting on CI',
        { result: 'behind', pr: pull, ...reading },
      )
      return true
    }
    const state = pull.checks.state
    if (state === 'passed' || state === 'none') {
      this.emit(true, 'checks passed', { result: 'passed', pr: pull, ...reading })
      return true
    }
    if (state === 'pending') {
      const { progress, missed } = await measure()
      // A null `idle` is a rollup with no stamp and no date of the head,
      // which proves nothing. Nor does a read that missed steps.
      if (missed || progress.idle === null || progress.idle < progress.stall_bound) return false
      this.emit(
        true,
        `no check started or finished for ${progress.idle}s; the stall bound is ` +
          `${progress.stall_bound}s`,
        { result: 'stalled', pr: pull, ...reading, progress },
      )
      return true
    }

    // Something failed. This code names the checks. It also pulls the
    // failed steps' log for the first Actions job among them, so the
    // agent can classify the failure without another round trip.
    const [logTail, logError] = await this.failedLog(pull.checks.failing)
    // `log_error` appears only when there is one. "No log" and "gh would
    // not hand the log over" call for different next steps. A reader
    // ignores a field that is always present and almost always empty.
    const extra =
      logError === '' ? { log_tail: logTail } : { log_tail: logTail, log_error: logError }
    this.emit(true, 'checks failed', { result: 'failed', pr: pull, ...extra, ...reading })
    return true
  }

  /**
   * `[the failed steps' log for the first Actions job among `failing`, why
   * not]`.
   *
   * Both values are empty when none of the failing checks was an Actions
   * job. That is a fact about the checks, not a problem. The other case is
   * a log that gh would not hand over, and this says so. The agent
   * classifies a failure from this text. An empty tail that looks the
   * same as "the job printed nothing" is the difference between a skip
   * and a fix.
   *
   * One line replaces the Python's two. The Python printed
   * `cannot run gh: ...`, with no prefix, for a gh that never started. It
   * printed `could not read the failed job's log: ...` for a gh that
   * refused. Now the two cases are one `GhError`. To tell them apart
   * would mean a branch on the error's prose.
   */
  async failedLog(failing: readonly { readonly link: unknown }[]): Promise<[string, string]> {
    for (const check of failing) {
      const link = jobLink(check.link)
      if (link === null) continue
      try {
        const text = await this.options.gh.readFailedRunLog({ run: link.run, job: link.job })
        return [tailLines(text.replace(ANSI_RE, ''), this.options.logLines), '']
      } catch (error) {
        return ['', `could not read the failed job's log: ${ghAccount(error)}`]
      }
    }
    return ['', '']
  }

  /**
   * `[result, detail]` for a read that decides the question, or `null`.
   *
   * "Decides" is deliberately narrow. It means only what GitHub actually
   * reported. A pull request that is still OPEN and CLEAN, with auto-merge
   * on, has not been decided either way, however long it has sat there.
   * The caller reads again, rather than invent a cause for the delay.
   *
   * `corroborated` says whether an earlier read already saw a BLOCKED
   * merge state. GitHub reports BLOCKED while it reconciles a check that
   * has only just gone green, so one sample of it is not a verdict. Every
   * other signal here is final on sight.
   */
  settleVerdict(pull: PullSummary, corroborated: boolean): [string, string] | null {
    if (pull.state === 'MERGED') return ['merged', 'merged']
    if (pull.state === 'CLOSED') return ['closed', 'pull request was closed while settling']
    // Both folds are ports of `gh-shepherd-pr.py:768` and `:769`
    // (`pull.get(...) or ""`). Neither one can change an output. This code
    // reads the two values only with `.includes`, against the three
    // constant lists below, and no falsy answer, under any spelling, is in
    // them. `reviewDecision` is inert twice over: `summary` has already
    // folded a falsy value to `""` (`shepherd.ts`, which ports
    // `lib/shepherd.py:240`), and the Python did the same. This code keeps
    // both folds because they are the lines this file ports. It records
    // this here so nobody deletes them as dead code, or gives them a test
    // case that cannot fail.
    const merge = isTruthy(pull.mergeStateStatus) ? String(pull.mergeStateStatus) : ''
    const review = isTruthy(pull.reviewDecision) ? String(pull.reviewDecision) : ''
    // This code names both when both are blocking. The reason is the
    // reader's only account of why. If this left out one of two causes,
    // the next step would look smaller than it is.
    const blocking: string[] = []
    if (BLOCKING_MERGE_STATES.includes(merge)) blocking.push(`mergeStateStatus is ${merge}`)
    if (BLOCKING_REVIEW_DECISIONS.includes(review)) blocking.push(`reviewDecision is ${review}`)
    // A blocking review decision ends the loop on sight. A BLOCKED merge
    // state ends the loop only once a previous read also saw it. But if
    // something else ends the loop anyway, this still names an
    // uncorroborated BLOCKED. The reason is the reader's account of the
    // state, and this is part of that account.
    if (blocking.length > 0 && (BLOCKING_REVIEW_DECISIONS.includes(review) || corroborated)) {
      return ['blocked', `auto-merge cannot fire: ${blocking.join(' and ')}`]
    }
    if (RECHECK_MERGE_STATES.includes(merge)) {
      // This is not a verdict. The base moved under the pull request while
      // this ran. The caller decides again (a rebase, or a merge of the base). This
      // avoids a block record that describes a state that no longer
      // holds.
      return ['changed', `mergeStateStatus is now ${merge}; the base moved while settling`]
    }
    return null
  }

  async settle(): Promise<void> {
    const first = await this.readPr()
    if (first === null) return this.unreadable()
    if (first.state === 'MERGED') {
      // This is not a refusal. "It already merged" is the answer this
      // action exists to give, and the caller records the merge from it.
      this.emit(true, 'merged', {
        result: 'merged',
        mergeCommit: first.mergeCommit,
        waited: 0,
        reads_ok: 1,
        read_failures: 0,
        read_error: '',
        pr: first,
      })
      return
    }
    if (first.state !== 'OPEN') return this.refuseNotOpen(first)
    if (!first.autoMerge) {
      this.emit(
        false,
        // "this script" is the Python's own word, and this keeps it. The
        // detail is a string the agent copies into its report. It is
        // output, and this layer does not rename it.
        `refused: auto-merge is not enabled on #${this.options.number}; there is nothing to ` +
          'settle, and this script never enables it',
        { pr: first },
      )
      return
    }
    if (!SETTLED_CHECK_STATES.includes(first.checks.state)) {
      // `settle` is the grace period after a green run. To watch a check
      // that is still active is `wait`'s job. To answer here would waste
      // the bound on a question nobody asked.
      this.emit(
        false,
        `refused: checks are ${first.checks.state}; settle acts on ` +
          `${SETTLED_CHECK_STATES.join(' or ')}, and \`wait\` is what watches a run`,
        { pr: first },
      )
      return
    }

    const env = this.options.context.env
    const err = this.options.context.output.err
    const bound = envInt(env, err, 'SHEPHERD_SETTLE_BOUND', SETTLE_BOUND_DEFAULT, POSITIVE_RE)
    // `POSITIVE_RE` rejects 0, which stops an endless loop. An interval of
    // zero would spin forever, because the deadline would never arrive.
    // So this code uses the default value instead.
    const interval = envInt(env, err, 'SHEPHERD_SETTLE_POLL', SETTLE_POLL_DEFAULT, POSITIVE_RE)
    // This code measures elapsed time; it does not add up the sleep
    // intervals. The reads between two sleeps take time of their own. On
    // a slow gh, the same slowness causes the read failures below. If
    // this code counted only sleeps, it would report 90s after several
    // real minutes had passed, past the caller's tool-call timeout.
    const started = this.options.context.now()
    const spent = (): number => seconds(this.options.context.now() - started)

    let pull = first
    let readsOk = 1
    let readsFailed = 0
    let blockedBefore = false
    // Whether the most recent read attempt failed. That fact, not the
    // total count, decides whether this code can report `open`. A failure
    // in the middle, that a later read recovered from, leaves the final
    // snapshot fresh. A failure at the end leaves `pull` older than the
    // bound that this is about to report.
    let stale = false
    // Whether `pull` still needs a verdict against it. A failed re-read
    // says nothing about the pull request (#218 finding 9): it must not be
    // read twice, once as itself and once again as the sample before it.
    // So a failed read turns this false, and the loop then sleeps and reads
    // again. It asks for no verdict, and it does not move `blockedBefore`,
    // against the same stale snapshot a second time.
    let pending = true
    while (true) {
      if (pending) {
        const verdict = this.settleVerdict(pull, blockedBefore)
        if (verdict !== null) {
          const [result, detail] = verdict
          const extra: Record<string, unknown> = {}
          if (result === 'merged') extra.mergeCommit = pull.mergeCommit
          // The agent copies this verbatim into its report, which is the
          // point: a reason it wrote itself is a reason it can speculate in.
          if (result === 'blocked') extra.reason = detail
          this.emit(true, detail, {
            result,
            waited: spent(),
            reads_ok: readsOk,
            read_failures: readsFailed,
            read_error: readsFailed > 0 ? this.readErr : '',
            pr: pull,
            ...extra,
          })
          return
        }
        blockedBefore = BLOCKING_MERGE_STATES.includes(
          isTruthy(pull.mergeStateStatus) ? String(pull.mergeStateStatus) : '',
        )
      }
      if (spent() >= bound) break
      await this.options.context.sleep(interval * 1000)
      const fresh = await this.readPr()
      // A read that failed says nothing about the pull request. This code
      // counts it and continues; the last good read is still what this
      // reports.
      if (fresh === null) {
        readsFailed += 1
        stale = true
        pending = false
        continue
      }
      readsOk += 1
      stale = false
      pull = fresh
      pending = true
    }

    if (stale) {
      // The bound arrived on a read that failed, so the newest thing this
      // knows about the pull request predates that bound. "Nothing was
      // reported against it" would then be a statement about a silence,
      // not about the pull request. This command refuses to do that
      // anywhere else.
      this.emit(
        false,
        `settle waited ${spent()}s but could not re-read the pull request (${readsFailed} of ` +
          `${readsOk + readsFailed} reads failed, the last among them): ${this.readErr}`,
        {
          waited: spent(),
          reads_ok: readsOk,
          read_failures: readsFailed,
          read_error: this.readErr,
          pr: pull,
        },
      )
      return
    }
    this.emit(
      true,
      `still open after ${spent()}s with auto-merge enabled and nothing reported against it`,
      {
        result: 'open',
        waited: spent(),
        reads_ok: readsOk,
        read_failures: readsFailed,
        // Both arms are `''`, always. `readPr` clears `readErr` on every
        // successful read, and this line runs only after one. This is
        // ported as the Python wrote it
        // (`read_error=self.last_read_error() if reads_failed else ""`).
        // It is not observable, for the same reason as the two folds in
        // `settleVerdict`. What this clearing depends on is pinned by the
        // test `keeps polling when one read fails and reports the answer
        // that followed`, which asserts `read_failures: 1` together with
        // `read_error: ''`.
        read_error: readsFailed > 0 ? this.readErr : '',
        pr: pull,
      },
    )
  }
}

/** The action each name runs, which is also the set the usage advertises: a
 *  name with no entry here is the unknown-action refusal, so the two cannot
 *  drift apart. */
const HANDLERS: Record<string, (worker: Shepherd) => Promise<void>> = {
  state: (worker) => worker.state(),
  rebase: (worker) => worker.rebase(),
  wait: (worker) => worker.wait(),
  settle: (worker) => worker.settle(),
  merged: (worker) => worker.merged(),
}

/** The command, with everything it did not expect still to be caught. */
const shepherdPr = async (
  argv: readonly string[],
  context: ShepherdContext,
): Promise<ShepherdExit> => {
  const { output } = context
  const refuse = (line: string, code: ShepherdExit): ShepherdExit => {
    output.err.write(`${line}\n`)
    return code
  }

  // #218 finding 5: this reads help in any position, before the
  // argument-count refusal below. `#231` kept this at `argv[0]` alone.
  if (argv.includes('-h') || argv.includes('--help')) {
    output.out.write(`${HELP}\n`)
    return 0
  }
  const [target = '', number = '', action = ''] = argv
  if (argv.length < 3) return refuse(HELP, 2)

  const refusal = directoryRefusal(target)
  if (refusal !== null) return refuse(refusal, 2)
  if (!NUMBER_RE.test(number)) return refuse(`not a pull request number: ${number}`, 2)
  if ((await toplevel({ cwd: target, env: context.env })) === null) {
    return refuse(`not a git repository: ${target}`, 2)
  }

  // This code reads these values before it checks the action. A caller who
  // set a value that goes unused still hears about anything else it asked
  // for.
  const ciSeconds = envInt(context.env, output.err, 'SHEPHERD_CI_SECONDS', DEFAULT_CI_SECONDS)
  const logLines = envInt(
    context.env,
    output.err,
    'SHEPHERD_LOG_LINES',
    DEFAULT_LOG_LINES,
    POSITIVE_RE,
  )

  // This code checks the action before any gh call. An unknown action is a
  // usage error, and a usage error costs nothing (#218 finding 2).
  //
  // `Object.hasOwn`, not `HANDLERS[action] === undefined`. `HANDLERS` is a
  // plain object literal, so it inherits `Object.prototype`. A plain lookup
  // reads `constructor`, `toString`, `valueOf`, and `hasOwnProperty` as
  // defined, though none names a real action.
  const handler = Object.hasOwn(HANDLERS, action) ? HANDLERS[action] : undefined
  if (handler === undefined) {
    output.err.write(`unknown action: ${action}\n`)
    return refuse(HELP, 2)
  }

  // This call resolves from the checkout. It is the one call of the five
  // that names no repository, because it answers what the repository is.
  let view: Record<string, unknown>
  try {
    view = await context.createGh({ cwd: target }).viewRepository()
  } catch (error) {
    if (error instanceof GhError && error.status === 127) return refuse('gh is required', 1)
    return refuse(`could not resolve the repository with gh: ${ghAccount(error)}`, 1)
  }
  const name = view.nameWithOwner
  if (!isTruthy(name)) {
    return refuse('could not resolve the repository with gh: gh answered without nameWithOwner', 1)
  }

  await handler(
    new Shepherd({
      repo: String(name),
      number: Number(number),
      action,
      ciSeconds,
      logLines,
      context,
      gh: context.createGh({ cwd: target, repository: String(name) }),
    }),
  )
  return 0
}

/**
 * `shepherdPr`, with anything it did not expect reported rather than raised.
 *
 * Exit 3 is outside the documented set on purpose. A caller that parses
 * the JSON on stdout must not read a crash as an answer. Instead, the
 * agent gets a line that names what broke, not a stack trace it cannot
 * act on. The line names this command, not the script file that the
 * Python named, because the file is `scripts/gh.ts` for every command
 * now.
 */
export const runShepherdPr = async (
  argv: readonly string[],
  context: ShepherdContext,
): Promise<ShepherdExit> => {
  try {
    return await shepherdPr(argv, context)
  } catch (error) {
    const account =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : `${typeof error}: ${String(error)}`
    context.output.err.write(`gh.ts shepherd-pr: internal error: ${account}\n`)
    return 3
  }
}
