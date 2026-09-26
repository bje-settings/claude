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
// **Time is an argument.** `recreate` polls until Dependabot moves the head,
// `wait` is bounded, and `settle` polls until its own bound. The clock and
// the sleep come in through `ShepherdContext`. This lets the tests drive
// every bound to its end, with no real wait. The bounds themselves are the
// Python's numbers, unchanged (#106 measures the settle bound and lands
// after this port).
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
  directoryRefusal,
  isTruthy,
  jobLink,
  missingField,
  oneLine,
  type PullSummary,
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

/** The floor on the recreate poll interval when it was derived rather than
 *  given. */
const POLL_FLOOR = 15

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

/** The exit codes `gh pr checks` uses to report on the checks: 0 means all
 *  passed, 1 means one failed, 8 means still pending. 124 is this command's
 *  own bound. Any other code means gh failed to answer at all (a 502, a
 *  rate limit, an expired token). To report that as `pending` would make
 *  the caller wait it out, one CI cycle at a time, forever. */
const WATCHER_CODES = [0, 1, 8, 124]

/** How much of a failed watcher's stderr travels in the detail. Enough for the
 *  HTTP status and the message under it, not the whole of gh's help text. */
const WATCHER_ERR_LINES = 5

export const HELP = `The deterministic per-pull-request steps of /gh:shepherd.

Usage:
  gh.ts shepherd-pr <path> <number> state
  gh.ts shepherd-pr <path> <number> rebase
  gh.ts shepherd-pr <path> <number> recreate
  gh.ts shepherd-pr <path> <number> wait
  gh.ts shepherd-pr <path> <number> settle
  gh.ts shepherd-pr <path> <number> merged

Every action prints one JSON object: {"action", "ok", "detail", ...}. The
agent running the loop decides which action comes next; this only does the
step, and refuses steps whose preconditions do not hold, so a confused caller
cannot make it act on the wrong pull request.

  state     the pull request as \`summary\` shapes it (see src/shepherd.ts)
  rebase    gh pr update-branch --rebase. Refuses unless the pull request is
            open. Reports the head SHA before and after.
  recreate  comments \`@dependabot recreate\`, then polls until the head SHA
            changes (\`recreated\`). If the pull request leaves OPEN with the
            head unmoved, returns \`result: closed\` or \`merged\` at once; a
            closed one was usually superseded by another pull request.
            Refuses on a pull request Dependabot did not author.
  wait      gh pr checks --watch --fail-fast, bounded (see below). Result is
            one of passed, failed, pending, merged; \`failing\` lists the
            failed checks and \`log_tail\` carries the failed steps' log, with
            \`log_error\` beside it when gh would not hand the log over. A
            watcher that failed for a reason of its own (a 502, an expired
            token) is \`ok: false\`, never \`pending\`.
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
label, and never bypasses a check. The only writes are the rebase and the
one comment, and nothing else.

Environment:
  SHEPHERD_CI_SECONDS    typical CI wall time, from gh.ts shepherd-status
                         (default 300). The wait bound is twice this, clamped
                         to [120, 540] so it fits inside a ten-minute tool
                         call; the caller re-invokes \`wait\` on \`pending\`.
  SHEPHERD_POLL_SECONDS  interval for the recreate head-SHA poll (default: a
                         quarter of SHEPHERD_CI_SECONDS, no lower than 15; an
                         explicit value is honoured down to 1).
  SHEPHERD_LOG_LINES     lines of failed-step log to keep (default 60).
  SHEPHERD_WAIT_BOUND    override the computed wait bound, in seconds. For
                         tests and for repos whose CI is far from typical.
  SHEPHERD_SETTLE_BOUND  how long \`settle\` waits with no evidence either way,
                         in seconds (default 90).
  SHEPHERD_SETTLE_POLL   interval between two settle reads (default 5).

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

/**
 * Seconds between two recreate polls.
 *
 * When nobody gives an interval, this code derives one from the CI cycle
 * and floors it, so a fast repository is not polled every second. When an
 * interval is given, this code honours it even below that floor; the
 * tests rely on this. A value that is not a number at all falls back to
 * the floor, rather than failing the run.
 *
 * A zero interval would spin without ever reaching the bound. That is the
 * one way this loop could fail to stop. The shell version had that gap.
 * Nothing needs a zero interval, so this code floors it at one second
 * instead.
 */
const pollInterval = (env: NodeJS.ProcessEnv, err: Writer, ciSeconds: number): number => {
  const raw = env.SHEPHERD_POLL_SECONDS ?? ''
  const interval =
    raw === ''
      ? Math.max(Math.floor(ciSeconds / 4), POLL_FLOOR)
      : envInt(env, err, 'SHEPHERD_POLL_SECONDS', POLL_FLOOR)
  return Math.max(interval, 1)
}

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
    return summary(pull)
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

  // ------------------------------------------------------------ actions ---

  async state(): Promise<void> {
    const pull = await this.readPr()
    if (pull === null) return this.unreadable()
    this.emit(true, 'read', { pr: pull })
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
    const fresh = await this.readPr()
    if (fresh === null) {
      // The branch update ran. Only the confirmation read failed. If this
      // told the caller `ok: false`, it would decide again and rebase a
      // second time, which costs another CI run for a read that failed.
      this.emit(
        true,
        `update-branch succeeded but the pull request could not be re-read: ${this.readFailure()}`,
        { before, after: '', pr: null, output: out },
      )
      return
    }
    // No `or ""` in front of this, unlike the Python: `missingField` refuses
    // an empty `headRefOid` before `readPr` answers, so a head that reached
    // here is a head gh named.
    const after = fresh.headRefOid
    // `gh pr update-branch` is asynchronous. It returns as soon as GitHub
    // accepts the request. It also prints the same success line when the
    // branch was already current. Either way, the head has not moved. To
    // call that "rebased" would tell the caller a new CI run is coming,
    // when none may be.
    const detail =
      after === before
        ? 'update-branch reported success and the head has not moved: the update is ' +
          'still queued, or the branch was already up to date'
        : 'rebased'
    this.emit(true, detail, { before, after, pr: fresh, output: out })
  }

  async recreate(): Promise<void> {
    const first = await this.readPr()
    if (first === null) return this.unreadable()
    if (!first.is_dependabot) {
      // Deliberately not `is_bot`: renovate and github-actions are bots too,
      // and `@dependabot recreate` on one of their pull requests is a comment
      // nothing will ever answer.
      this.emit(
        false,
        `refused: #${this.options.number} was not authored by Dependabot; recreate only works ` +
          'for its own pull requests',
        { pr: first },
      )
      return
    }
    if (first.state !== 'OPEN') return this.refuseNotOpen(first)
    const before = first.headRefOid
    const [posted, out] = await this.ghText(
      this.options.gh.addComment({
        pullRequest: this.options.number,
        body: '@dependabot recreate',
      }),
    )
    if (!posted) {
      this.emit(false, `could not post the recreate comment: ${out}`)
      return
    }

    // Dependabot answers asynchronously and leaves no signal but a new head
    // SHA. This code polls a few times per typical CI cycle, bounded by two
    // cycles. It never polls less than once per interval. Otherwise a
    // small SHEPHERD_CI_SECONDS would post the comment and then report a
    // read that never happened.
    const interval = pollInterval(
      this.options.context.env,
      this.options.context.output.err,
      this.options.ciSeconds,
    )
    const bound = Math.max(this.options.ciSeconds * 2, interval)
    let waited = 0
    let readsOk = 0
    let readsFailed = 0
    let after: unknown = ''
    // The last read, which is `null` when the last read failed: the Python
    // reports `pr` from the same variable it assigns the failed read to.
    let pull: PullSummary | null = first
    while (waited < bound) {
      await this.options.context.sleep(interval * 1000)
      waited += interval
      pull = await this.readPr()
      // A poll that cannot read the pull request says nothing about it. Count
      // it and keep going; it is reported below if no read ever succeeded.
      if (pull === null) {
        readsFailed += 1
        continue
      }
      readsOk += 1
      // Both are guaranteed by `missingField`, which refuses an empty one
      // before `readPr` answers: the Python's `or ""` guarded a read this one
      // has already refused.
      after = pull.headRefOid
      const state = String(pull.state)
      // A moved head is the answer this action exists for. It wins over any
      // state change seen in the same poll. A recreated branch that already
      // went green and auto-merged is a success. It is not a sign that
      // another pull request replaced it.
      if (after !== before) {
        this.emit(true, 'recreated', { before, after, pr: pull })
        return
      }
      // The head never moved, but the pull request is no longer open.
      // Dependabot closes a pull request rather than recreate it, when
      // another pull request already shipped the same bump or a newer one.
      // A human can also close or merge it. This code reports what it
      // saw, and leaves the attribution to the caller.
      if (state === 'OPEN') continue
      if (state === 'MERGED') {
        this.emit(true, 'pull request merged while waiting for recreate; the head did not move', {
          result: 'merged',
          before,
          after,
          pr: pull,
        })
        return
      }
      if (state === 'CLOSED') {
        this.emit(
          true,
          'pull request closed while waiting for recreate; superseded by another pull ' +
            'request is the usual cause',
          { result: 'closed', before, after, pr: pull },
        )
        return
      }
      this.emit(false, `unexpected pull request state after recreate: '${String(state)}'`, {
        before,
        pr: pull,
      })
      return
    }
    if (readsOk === 0) {
      this.emit(
        false,
        `recreate requested but the pull request could not be re-read in ${bound}s ` +
          `(${readsFailed} attempts): ${this.readErr}`,
        { before, read_failures: readsFailed },
      )
      return
    }
    this.emit(false, `recreate requested but the head did not change within ${bound}s`, {
      before,
      read_failures: readsFailed,
      pr: pull,
    })
  }

  async wait(): Promise<void> {
    const pull = await this.readPr()
    if (pull === null) return this.unreadable()
    if (pull.state === 'MERGED') {
      this.emit(true, 'merged', { result: 'merged', pr: pull })
      return
    }
    if (pull.checks.state === 'none') {
      this.emit(true, 'no checks reported on this head', { result: 'passed', pr: pull })
      return
    }

    // This code watches only while a check is still active. A rollup that
    // is already final is answered from the pull request itself. `gh pr
    // checks --watch` has been seen to watch a fully finished rollup
    // forever, when the rollup contains skipped checks. A watcher that
    // never returns is worse than no watcher.
    const bound = envInt(
      this.options.context.env,
      this.options.context.output.err,
      'SHEPHERD_WAIT_BOUND',
      clamp(this.options.ciSeconds * 2, WAIT_BOUND_MIN, WAIT_BOUND_MAX),
      POSITIVE_RE,
    )
    let watcherRc: number | null = 0
    let waited = 0
    if (pull.checks.state === 'pending') {
      const watch = await this.options.gh.watchChecks({
        pullRequest: this.options.number,
        boundMs: bound * 1000,
        failFast: true,
      })
      // This code uses 124 for the bound, the way coreutils `timeout`
      // publishes it. `run_bounded` made this translation, and `lib/gh.ts`
      // deliberately leaves it to whoever publishes a status. A watch that
      // a signal ended has no status of its own. `null` is outside
      // WATCHER_CODES, so this refuses below.
      watcherRc = watch.timedOut ? 124 : watch.status
      waited = seconds(watch.waitedMs)
      // A watch that a signal ended has no status at all. That is not one
      // of the codes either, so this refuses here with the rest.
      const saidSomething = watcherRc !== null && WATCHER_CODES.includes(watcherRc)
      if (!saidSomething) {
        // gh said nothing about the checks. It could not reach GitHub, or
        // could not start at all. To report this as `pending` would make
        // the caller wait out a broken token, one CI cycle at a time.
        // Instead this is a refusal that carries what gh printed. It
        // checks truthiness on the account, so a watcher that failed
        // silently still names its status.
        const problem = oneLine(tailLines(watch.problem, WATCHER_ERR_LINES))
        this.emit(
          false,
          `watcher failed after ${waited}s: ${problem || `gh exited ${watcherRc}`}`,
          {
            bound,
            watcher_rc: watcherRc,
            pr: pull,
            waited,
          },
        )
        return
      }
    }

    // This code re-reads the pull request afterward, in every case. A
    // rollup that already passed may have let auto-merge fire. This code
    // decides from the rollup, not from the watcher's exit code.
    const fresh = await this.readPr()
    if (fresh === null) {
      this.emit(
        false,
        `checks finished but the pull request could not be re-read: ${this.readFailure()}`,
      )
      return
    }
    if (fresh.state === 'MERGED') {
      this.emit(true, 'merged', { result: 'merged', pr: fresh })
      return
    }
    const state = fresh.checks.state
    if (state === 'passed' || state === 'none') {
      this.emit(true, 'checks passed', { result: 'passed', pr: fresh })
      return
    }
    if (state === 'pending') {
      // This is the time actually spent, not the bound. A watcher that
      // returned early did not wait out the full bound. A caller that
      // sizes its next call reads this number.
      this.emit(true, `checks still running after ${waited}s`, {
        result: 'pending',
        bound,
        watcher_rc: watcherRc,
        pr: fresh,
        waited,
      })
      return
    }

    // Something failed. This code names the checks. It also pulls the
    // failed steps' log for the first Actions job among them, so the
    // agent can classify the failure without another round trip.
    const [logTail, logError] = await this.failedLog(fresh.checks.failing)
    // `log_error` appears only when there is one. "No log" and "gh would
    // not hand the log over" call for different next steps. A reader
    // ignores a field that is always present and almost always empty.
    const extra =
      logError === '' ? { log_tail: logTail } : { log_tail: logTail, log_error: logError }
    this.emit(true, 'checks failed', { result: 'failed', pr: fresh, ...extra })
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
      // this ran. The caller decides again (a rebase, or a recreate). This
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
    while (true) {
      const verdict = this.settleVerdict(pull, blockedBefore)
      if (verdict !== null) {
        const [result, detail] = verdict
        const extra: Record<string, unknown> = {}
        if (result === 'merged') extra.mergeCommit = pull.mergeCommit
        // The agent copies this verbatim into its report, which is the point:
        // a reason it wrote itself is a reason it can speculate in.
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
      if (spent() >= bound) break
      await this.options.context.sleep(interval * 1000)
      const fresh = await this.readPr()
      // A read that failed says nothing about the pull request. This code
      // counts it and continues; the last good read is still what this
      // reports.
      if (fresh === null) {
        readsFailed += 1
        stale = true
        continue
      }
      readsOk += 1
      stale = false
      pull = fresh
    }

    if (stale) {
      // The bound arrived on a read that failed, so the newest thing this
      // knows about the pull request predates that bound. "Nothing was
      // reported against it" would then be a statement about a silence,
      // not about the pull request. This command refuses to do that
      // anywhere else. `recreate` fails closed on the same shape.
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
  recreate: (worker) => worker.recreate(),
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

  const [target = '', number = '', action = ''] = argv
  if (target === '-h' || target === '--help') {
    output.out.write(`${HELP}\n`)
    return 0
  }
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
  const handler = HANDLERS[action]
  if (handler === undefined) {
    output.err.write(`unknown action: ${action}\n`)
    return refuse(HELP, 2)
  }

  // This call resolves from the checkout. It is the one call of the six
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
