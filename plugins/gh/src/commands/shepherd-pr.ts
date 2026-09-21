// The deterministic per-pull-request steps of `/gh:shepherd`: the port of
// `plugins/gh/scripts/gh-shepherd-pr.py`.
//
// Every action prints ONE JSON object, `{"action", "repo", "number", "ok",
// "detail", ...}`, with the keys in the order the Python wrote them, because
// the document is read by an agent by name AND by a human in a transcript.
// The agent running the loop decides which action comes next; this only does
// the step, and refuses steps whose preconditions do not hold, so a confused
// caller cannot make it act on the wrong pull request.
//
// **Time is an argument.** `recreate` polls until Dependabot moves the head,
// `wait` is bounded, and `settle` polls until its own bound. The clock and the
// sleep come in through `ShepherdContext`, so the tests drive every bound to
// its end without waiting for any of it, and the bounds themselves are the
// Python's numbers unchanged (#106 measures the settle bound and lands after
// this port).
//
// The command function is the seam (ADR 001): arguments, the environment, an
// injected `gh`, the clock, the sleep and the output writers in, an exit
// status out. Nothing is spawned and no `gh` is on PATH.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
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

/** Colour the log viewer would render. In a JSON string it is noise, and the
 *  agent reading the tail cannot see it anyway.
 *
 *  Built rather than written as a literal: an escape is a control character,
 *  which a regular expression literal is linted against carrying, and the
 *  whole point here is to match one. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const URL_RE = /https:\/\/[^ \n]+/g

const DEFAULT_CI_SECONDS = 300
const DEFAULT_LOG_LINES = 60

/** The bound on a single `wait`, so it fits inside a ten-minute tool call. The
 *  caller re-invokes `wait` when it returns `pending`. */
const WAIT_BOUND_MIN = 120
const WAIT_BOUND_MAX = 540

/** The floor on the recreate poll interval when it was derived rather than
 *  given. */
const POLL_FLOOR = 15

// How long `settle` keeps reading when GitHub reports nothing either way, and
// how often it reads. Deliberately constants rather than something derived
// from SHEPHERD_CI_SECONDS: that number is the measured median of the
// repository's own workflow runs, and what settle waits on is GitHub's
// auto-merge latency AFTER the checks are already green, which the length of a
// CI run says nothing about.
//
// 90 seconds is a guess, and the only one here that decides an outcome rather
// than sizing a bound. It is survivable because settle rarely reaches it:
// every state GitHub can report that decides the question ends the poll early,
// and this bound covers only the pull request GitHub has said nothing decisive
// about. #106 measures it; the port carries it as it is.
const SETTLE_BOUND_DEFAULT = 90
const SETTLE_POLL_DEFAULT = 5

/** Merge states that prove auto-merge cannot fire now. BLOCKED is a required
 *  review or a required check that has not reported; either way GitHub will
 *  not merge. It is not read from a single sample, though: GitHub reports
 *  BLOCKED while it is still reconciling a check that has only just gone
 *  green, which is the same window settle exists to sit through, so it has to
 *  survive a poll before it counts. */
const BLOCKING_MERGE_STATES = ['BLOCKED']

/** Merge states that are not a verdict but a new question: the base moved
 *  under the pull request while settle watched. */
const RECHECK_MERGE_STATES = ['BEHIND', 'DIRTY']

/** Review decisions that prove auto-merge cannot fire. `""` (no review
 *  required) and APPROVED are not among them; neither is a reason to stop
 *  waiting. */
const BLOCKING_REVIEW_DECISIONS = ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']

/** Checks states settle will act on. Anything else is `wait`'s job, and settle
 *  refuses rather than quietly waiting out a run it should have watched. */
const SETTLED_CHECK_STATES = ['passed', 'none']

/** The exit codes `gh pr checks` uses to say something about the checks: 0 all
 *  passed, 1 one failed, 8 still pending. 124 is this command's own bound. Any
 *  other code is gh failing to answer at all (a 502, a rate limit, an expired
 *  token) and reporting that as `pending` would have the caller wait it out
 *  one CI cycle at a time forever. */
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
  gh.ts shepherd-pr <path> <number> skip <reason-file>
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
  skip      posts the comment in <reason-file> and reports its URL. Refuses
            an empty file: a skip without a reason is not a skip.
  merged    whether the pull request is MERGED, and its merge commit.

This command never merges, never enables or disables auto-merge, never edits a
label, and never bypasses a check. The only writes are the rebase, the two
comments, and nothing else.

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
 * A stray value must not be the thing that decides a run, which is why an
 * unparseable one falls back rather than failing: the shell version validated
 * with these same patterns for the same reason. Unlike the shell version it
 * says so, on stderr, so the JSON on stdout that the caller parses is
 * untouched: a silent fallback is how a bound nobody meant to use gets used
 * for a whole run.
 */
const envInt = (
  env: NodeJS.ProcessEnv,
  err: Writer,
  name: string,
  fallback: number,
  pattern: RegExp = DIGITS_RE,
): number => {
  const raw = env[name] ?? ''
  // The variable set to nothing is the variable unset, which is what
  // `os.environ.get(name, "")` folds them into.
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
 * An interval nobody gave is derived from the CI cycle and floored, so a fast
 * repository is not polled every second. One that was given is honoured below
 * that floor, which is what the tests set; one that is not a number at all
 * falls back to the floor rather than failing the run.
 *
 * A zero interval would spin without ever reaching the bound, which is the one
 * way this loop could fail to terminate. The shell version had that hole;
 * nothing asks for it, so it is floored at a second rather than kept.
 */
const pollInterval = (env: NodeJS.ProcessEnv, err: Writer, ciSeconds: number): number => {
  const raw = env.SHEPHERD_POLL_SECONDS ?? ''
  const interval =
    raw === ''
      ? Math.max(Math.floor(ciSeconds / 4), POLL_FLOOR)
      : envInt(env, err, 'SHEPHERD_POLL_SECONDS', POLL_FLOOR)
  return Math.max(interval, 1)
}

/** What a `gh` failure said, in one line, or the throw for anything that is
 *  not gh failing. `GhError.detail` and never `message`: the message carries
 *  the whole argv, and these reports quote gh. */
const ghAccount = (error: unknown): string => {
  if (error instanceof GhError) return oneLine(error.detail)
  throw error
}

/** Whether a reason file is one a comment can be posted from: the port of
 *  `os.path.isfile(f) and os.path.getsize(f) != 0`. */
const usableReason = (path: string): boolean => {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

/** The measured seconds of a duration in milliseconds, as `int()` read the
 *  monotonic clock: truncated, never rounded up. */
const seconds = (milliseconds: number): number => Math.floor(milliseconds / 1000)

interface WorkerOptions {
  readonly repo: string
  /** The checkout every `git` and `gh` call names, and the directory a
   *  relative path on the command line is resolved against. The Python
   *  `os.chdir`'d to it (`gh-shepherd-pr.py:1007`); nothing here changes
   *  directory, so the resolution is done by hand at the one place that
   *  needs it. */
  readonly target: string
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
  /** gh's own words from the last read, so a caller that polls can say why a
   *  read failed instead of reporting the silence as a fact about the pull
   *  request. */
  readErr = ''

  constructor(options: WorkerOptions) {
    this.options = options
  }

  // ------------------------------------------------------------- output ---

  /**
   * Print the one JSON object this action reports.
   *
   * The Python went quiet after a broken pipe so that a rebase already made
   * was not abandoned half-way through reporting it. The writer does that
   * here (`lib/streams.ts`: EPIPE and nothing else), for every write in the
   * plugin rather than for this one.
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
   * {@link readErr} is left saying why, so a caller reports the reason rather
   * than the silence. An answer missing a field the loop decides from is one
   * of those reasons: `summary` shapes whatever it is given, and an empty
   * object comes back out of it as a pull request whose checks are `none`,
   * which `wait` reads as passed.
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

  /** Why the last read did not answer, for the three reports that quote it.
   *
   *  Truthiness, not a null check: a gh that failed with nothing to say leaves
   *  an empty account, and reporting the silence is the one thing this command
   *  refuses to do anywhere. One function rather than the Python's three
   *  copies of the same `or`, so the three cannot drift. */
  readFailure(): string {
    return this.readErr || 'gh returned no JSON object'
  }

  /** Refuse, saying what gh said, rather than reporting the silence. A caller
   *  that polls, and a human reading the transcript afterwards, cannot tell a
   *  deleted pull request from an expired token without this. */
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
      // The branch update happened; only the confirmation did not. Told
      // `ok: false` the caller would decide again and rebase a second time,
      // which costs another CI run for a read that failed.
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
    // `gh pr update-branch` is asynchronous: it returns as soon as GitHub
    // accepts the request, and prints the same success line when the branch
    // was already current. Either way the head has not moved, and calling
    // that "rebased" tells the caller a new CI run is coming when none may be.
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
    // SHA. Poll a few times per typical CI cycle, bounded by two cycles, but
    // never by less than one interval, or a small SHEPHERD_CI_SECONDS would
    // post the comment and then report a read that never happened.
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
      // A moved head is the answer this action exists for, so it wins over any
      // state change seen in the same poll: a recreated branch that already
      // went green and auto-merged is a success, not a supersession.
      if (after !== before) {
        this.emit(true, 'recreated', { before, after, pr: pull })
        return
      }
      // The head never moved but the pull request is no longer open.
      // Dependabot closes a pull request instead of recreating it when another
      // one already shipped the same or a newer bump; a human can close or
      // merge it too. This reports what it saw and leaves the attribution to
      // the caller.
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

    // Only watch while something is still running. A rollup that is already
    // terminal is answered from the pull request itself: `gh pr checks
    // --watch` has been seen to keep watching a fully finished rollup that
    // contains skipped checks, and a watcher that cannot return is worse than
    // no watcher.
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
      // 124 for the bound, the way coreutils `timeout` publishes it, which is
      // the translation `run_bounded` made and `lib/gh.ts` deliberately leaves
      // to whoever publishes a status. A watch a signal ended has no status of
      // its own, and `null` is outside WATCHER_CODES, so it refuses below.
      watcherRc = watch.timedOut ? 124 : watch.status
      waited = seconds(watch.waitedMs)
      // A watch a signal ended has no status at all, which is not one of the
      // codes either, so it refuses here with the rest.
      const saidSomething = watcherRc !== null && WATCHER_CODES.includes(watcherRc)
      if (!saidSomething) {
        // gh said nothing about the checks: it could not reach GitHub, or
        // could not start at all. Reported as `pending` this would have the
        // caller wait out a broken token one CI cycle at a time, so it is a
        // refusal carrying what gh printed. Truthiness on the account, so a
        // watcher that failed silently still names its status.
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

    // Re-read the pull request afterwards in every case, since a passing
    // rollup may already have let auto-merge fire, and decide from the rollup
    // rather than from the watcher's exit code.
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
      // The time actually spent, not the bound: a watcher that returned early
      // did not wait it, and a caller sizing its next call reads this number.
      this.emit(true, `checks still running after ${waited}s`, {
        result: 'pending',
        bound,
        watcher_rc: watcherRc,
        pr: fresh,
        waited,
      })
      return
    }

    // Something failed. Name the checks and pull the failed steps' log for the
    // first Actions job among them, so the agent can classify without another
    // round trip.
    const [logTail, logError] = await this.failedLog(fresh.checks.failing)
    // `log_error` only when there is one: "no log" and "gh would not hand the
    // log over" call for different next steps, and a field that is always
    // there and almost always empty stops being read.
    const extra =
      logError === '' ? { log_tail: logTail } : { log_tail: logTail, log_error: logError }
    this.emit(true, 'checks failed', { result: 'failed', pr: fresh, ...extra })
  }

  /**
   * `[the failed steps' log for the first Actions job among `failing`, why
   * not]`.
   *
   * Both empty when nothing failing was an Actions job, which is a fact about
   * the checks rather than a problem. A log gh would not hand over is the
   * other case, and it says so: the agent classifies a failure from this text,
   * so an empty tail it cannot tell apart from "the job printed nothing" is
   * the difference between a skip and a fix.
   *
   * One line rather than the Python's two: it printed `cannot run gh: ...`
   * with no prefix for a gh that never started and
   * `could not read the failed job's log: ...` for one that refused, and the
   * two are one `GhError` now, so telling them apart would mean branching on
   * prose.
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
   * "Decides" is deliberately narrow: only what GitHub actually reported. A
   * pull request that is still OPEN and CLEAN with auto-merge on has not been
   * decided either way, however long it has sat there, and the caller keeps
   * reading rather than inventing a cause for the delay.
   *
   * `corroborated` says whether a BLOCKED merge state has already been seen on
   * an earlier read. GitHub reports BLOCKED while it reconciles a check that
   * has just gone green, so one sample of it is not a verdict; every other
   * signal here is terminal on sight.
   */
  settleVerdict(pull: PullSummary, corroborated: boolean): [string, string] | null {
    if (pull.state === 'MERGED') return ['merged', 'merged']
    if (pull.state === 'CLOSED') return ['closed', 'pull request was closed while settling']
    // Both folds are ports of `gh-shepherd-pr.py:768` and `:769`
    // (`pull.get(...) or ""`) and NEITHER can change an output: the two values
    // are read only by `.includes` against the three constant lists below, and
    // no falsy answer, under any spelling, is in them; `reviewDecision` is
    // inert twice over, because `summary` has already folded falsy to `""`
    // (`shepherd.ts`, porting `lib/shepherd.py:240`), which the Python does
    // too. Kept because they are the lines this ports, and recorded here so
    // that neither is deleted as dead nor given an example that cannot fail.
    const merge = isTruthy(pull.mergeStateStatus) ? String(pull.mergeStateStatus) : ''
    const review = isTruthy(pull.reviewDecision) ? String(pull.reviewDecision) : ''
    // Both are named when both are blocking: the reason is the reader's only
    // account of why, and dropping one of two causes makes the next step look
    // smaller than it is.
    const blocking: string[] = []
    if (BLOCKING_MERGE_STATES.includes(merge)) blocking.push(`mergeStateStatus is ${merge}`)
    if (BLOCKING_REVIEW_DECISIONS.includes(review)) blocking.push(`reviewDecision is ${review}`)
    // A blocking review decision ends it on sight. A BLOCKED merge state ends
    // it only once a previous read saw it too, but if something else is ending
    // it anyway, an uncorroborated BLOCKED is still named, because the reason
    // is the reader's account of the state and this is part of it.
    if (blocking.length > 0 && (BLOCKING_REVIEW_DECISIONS.includes(review) || corroborated)) {
      return ['blocked', `auto-merge cannot fire: ${blocking.join(' and ')}`]
    }
    if (RECHECK_MERGE_STATES.includes(merge)) {
      // Not a verdict: the base moved under the pull request while this ran.
      // The caller decides again (a rebase, or a recreate) rather than
      // recording a block that describes a state that no longer holds.
      return ['changed', `mergeStateStatus is now ${merge}; the base moved while settling`]
    }
    return null
  }

  async settle(): Promise<void> {
    const first = await this.readPr()
    if (first === null) return this.unreadable()
    if (first.state === 'MERGED') {
      // Not a refusal: "it already merged" is the answer this action is asked
      // for, and the caller records the merge from it.
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
        // "this script", the Python's own word, kept: the detail is a string
        // the agent copies into its report, so it is output and not prose this
        // layer renames.
        `refused: auto-merge is not enabled on #${this.options.number}; there is nothing to ` +
          'settle, and this script never enables it',
        { pr: first },
      )
      return
    }
    if (!SETTLED_CHECK_STATES.includes(first.checks.state)) {
      // settle is the grace AFTER a green run. Watching a run that is still
      // going is `wait`, and answering here would waste the bound on a
      // question that was never asked.
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
    // `POSITIVE_RE` is what keeps the loop terminating: it rejects 0, so an
    // interval of zero, which would spin without the deadline ever arriving,
    // falls back to the default rather than being honoured.
    const interval = envInt(env, err, 'SHEPHERD_SETTLE_POLL', SETTLE_POLL_DEFAULT, POSITIVE_RE)
    // Measured, not accumulated. The reads between two sleeps take time of
    // their own, and on the slow gh that also produces the read failures
    // below, counting sleeps alone would report 90s after minutes and run past
    // the caller's tool-call timeout.
    const started = this.options.context.now()
    const spent = (): number => seconds(this.options.context.now() - started)

    let pull = first
    let readsOk = 1
    let readsFailed = 0
    let blockedBefore = false
    // Whether the most recent read attempt failed. That, rather than the
    // total, is what decides whether `open` is sayable: a failure in the
    // middle that a later read recovered from leaves the final snapshot fresh,
    // while a failure at the end leaves `pull` older than the bound this is
    // about to report.
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
      // A read that failed says nothing about the pull request. Count it and
      // keep going; the last good read is still what gets reported.
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
      // knows about the pull request predates it. "Nothing was reported
      // against it" would then be a statement about a silence rather than
      // about the pull request, the one thing this command refuses to do
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
        // Both arms are `''`, always: `readPr` clears `readErr` on every
        // successful read and this line is reached only after one. Ported as
        // the Python writes it (`read_error=self.last_read_error() if
        // reads_failed else ""`), and unobservable for the same reason as the
        // two folds in `settleVerdict`. What the clearing itself depends on IS
        // pinned, by `keeps polling when one read fails and reports the
        // answer that followed`, which asserts `read_failures: 1` together
        // with `read_error: ''`.
        read_error: readsFailed > 0 ? this.readErr : '',
        pr: pull,
      },
    )
  }

  async skip(reasonFile: string): Promise<void> {
    // Resolved ONCE, and then both vetted and sent, because the Python
    // `os.chdir`'d to the target before this check ran
    // (`gh-shepherd-pr.py:1007`, then `:920`) AND before gh read the same
    // relative path through `--body-file` (`:928`), so one directory decided
    // both. Nothing here changes directory: the check runs in this process,
    // whose directory nothing changes, while gh is spawned with the target as
    // its own (`lib/gh.ts` is handed `cwd: target`). Deriving the path twice,
    // lexically here and by the kernel there, is what let them disagree:
    // `chdir` resolves symbolic links and `path.resolve` does not, so for a
    // target that is a symlink and a reason file that climbs out of it with
    // `..` the guard stats one file and gh comments the other. Resolving
    // against `realpathSync(target)` is the path `chdir` gave the Python, and
    // handing gh that same value means the two cannot be derived apart.
    // The refusal still prints the path as the caller wrote it, as the
    // Python's did (`:921`).
    const resolved = path.resolve(realpathSync(this.options.target), reasonFile)
    if (!usableReason(resolved)) {
      this.emit(false, `refused: reason file is missing or empty: ${reasonFile}`)
      return
    }
    const pull = await this.readPr()
    if (pull === null) return this.unreadable()
    if (pull.state !== 'OPEN') return this.refuseNotOpen(pull)
    const [posted, out] = await this.ghText(
      this.options.gh.addComment({ pullRequest: this.options.number, bodyFile: resolved }),
    )
    if (!posted) {
      this.emit(false, `could not post the skip comment: ${out}`)
      return
    }
    const urls = out.match(URL_RE) ?? []
    // The last URL gh printed, because a comment's own URL is the last thing
    // it says; no URL at all is reported as none rather than as a failure.
    this.emit(true, 'skip comment posted', { comment_url: urls[urls.length - 1] ?? '' })
  }
}

/** The action each name runs, which is also the set the usage advertises: a
 *  name with no entry here is the unknown-action refusal, so the two cannot
 *  drift apart. */
const HANDLERS: Record<string, (worker: Shepherd, reason: string) => Promise<void>> = {
  state: (worker) => worker.state(),
  rebase: (worker) => worker.rebase(),
  recreate: (worker) => worker.recreate(),
  wait: (worker) => worker.wait(),
  settle: (worker) => worker.settle(),
  skip: (worker, reason) => worker.skip(reason),
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

  const [target = '', number = '', action = '', ...rest] = argv
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

  // Resolved from the checkout, which is the one call of the seven that names
  // no repository, because it is the call that answers what the repository is.
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

  // Read before the action is checked, as the Python reads them, so a caller
  // who set a value that will not be used is told whatever else it asked for.
  const ciSeconds = envInt(context.env, output.err, 'SHEPHERD_CI_SECONDS', DEFAULT_CI_SECONDS)
  const logLines = envInt(
    context.env,
    output.err,
    'SHEPHERD_LOG_LINES',
    DEFAULT_LOG_LINES,
    POSITIVE_RE,
  )

  const handler = HANDLERS[action]
  if (handler === undefined) {
    output.err.write(`unknown action: ${action}\n`)
    return refuse(HELP, 2)
  }
  const [reason = ''] = rest
  if (action === 'skip' && reason === '') {
    // An empty argument is the same usage error as no argument, which is what
    // the shell version's `[ -z "$4" ]` said: `skip ""` is a caller that lost
    // its variable, not a skip whose reason file is missing.
    return refuse('skip needs a reason file', 2)
  }

  await handler(
    new Shepherd({
      repo: String(name),
      target,
      number: Number(number),
      action,
      ciSeconds,
      logLines,
      context,
      gh: context.createGh({ cwd: target, repository: String(name) }),
    }),
    reason,
  )
  return 0
}

/**
 * `shepherdPr`, with anything it did not expect reported rather than raised.
 *
 * Exit 3 is outside the documented set on purpose: a caller parsing the JSON
 * on stdout must not read a crash as an answer, and the agent gets a line
 * naming what broke instead of a stack trace it cannot act on. The line names
 * this command rather than the script file the Python named, because the file
 * is `bin/gh.ts` for every command now.
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
