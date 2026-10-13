// This file runs one child process with no shell, with a time limit that
// really works. `lib/gh.ts`'s private `execFile` adapter deliberately does
// not do this (see the header of #154). #127 is the first user of this
// file. It has three callers:
//
//   - the `gh` client below it
//   - the git helpers in `git.ts`
//   - the hook's one bounded child (`plugins/gh/hooks/hook-io.py`, lines
//     276 to 313)
//
// All three callers want the same four answers. The Python code writes
// that logic four times.
//
// It is the port of three Python shapes at once:
//
//   - `subprocess.run(..., stdout=PIPE)` as `gh-sync-repo.py:76` and
//     `lib/discover.py:56` call it. It captures output and never raises.
//   - `subprocess.run(..., stderr=STDOUT)` as `lib/install.py:52` and
//     `gh-shepherd-pr.py:438` call it. It merges stdout and stderr into one
//     transcript.
//   - `Popen(..., start_new_session=True)` plus `communicate(timeout=...)`
//     and a process group kill, as `run_bounded` (`gh-shepherd-pr.py:248`)
//     and `hook-io.py:276` call it.
//
// **Failure to start is not failure to succeed.** `lib/install.py`, lines
// 41 to 71, keeps these two cases apart. This port keeps the same split. A
// `FileNotFoundError` gets status 127. Any other unrunnable case gets
// status 126. These are the same statuses a shell uses for the two cases.
// A caller's one-line reason reads the same as before.
//
// {@link RunResult.startFailure} carries the same fact as data, so a
// caller can branch on it without a prose explanation. `gh-sync-repo.py:196`
// to `205` needs this. It must tell "git is not on PATH" apart from "git is
// on PATH and still would not run".
//
// **No shell, ever.** Every argument reaches the child as written. A
// branch name or a comment body with shell metacharacters is one argument.
// A shell never reads it again.
//
// This file ships. It imports nothing outside the root lib, and nothing
// from node beyond `child_process`. It stays inside the erasable subset
// (ADR 001).

//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, and `plugins/gh/hooks/hook-io.py` are gone from the tree.
// The file and line references below point to what they held at
// `cd0d515`. Each reference stays because it says where a rule came from.
// Nothing here changed with the deletion.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { type StreamFailure, streamFailures } from './streams.ts'

/** Why a child never ran at all. */
export interface StartFailure {
  /** node's own error code. Two kinds of code can reach this field. Only
   *  the first kind is worth a branch:
   *
   *   - a libuv errno, for a child node tried to start. `ENOENT` means the
   *     command is not on PATH, or the `cwd` is gone. `EACCES` means the
   *     file exists but is not executable.
   *   - a node `ERR_*` code, `ERR_INVALID_ARG_VALUE` today. node refused the
   *     argv before any child existed: a NUL byte in the command, an
   *     argument, `cwd`, or the environment. The command itself was never
   *     asked to run.
   *
   *  A caller that reads "not ENOENT" as "it is on PATH and still would not
   *  run" gets this wrong. `gh-sync-repo.py:196` to `205` prints exactly
   *  that sentence. It would send the reader to check an install, when the
   *  real bug is in the argv this process built. Branch on
   *  `code.startsWith('ERR_')` for this case, and on `ENOENT` for the other.
   */
  readonly code: string
  /** node's message. It names the command and the code. */
  readonly message: string
}

export interface RunOptions {
  /** Where the child runs. A directory that does not exist is a
   *  {@link StartFailure}, not a throw. */
  readonly cwd?: string
  /** The child's whole environment. When left out, the child inherits this
   *  process's environment. Every ported call site does this. */
  readonly env?: NodeJS.ProcessEnv
  /** Written to the child, then closed. When left out, the child still gets
   *  a pipe, and it closes at once. A child that reads stdin then sees EOF.
   *  It does not block on a descriptor that nobody writes to. */
  readonly stdin?: string | Uint8Array
  /** The time limit, in milliseconds. When it fires, this kills the
   *  child's whole process group (see {@link killGroup}), and
   *  {@link RunResult.timedOut} reports it. When left out, the code waits
   *  for the child as long as it takes. This is what an unbounded
   *  `subprocess.run` does.
   *
   *  This value is not checked here, and `number` allows more than a real
   *  limit. `setTimeout` treats `NaN` and a negative number as 0. It clamps
   *  anything above 2^31-1 down to 1 ms. Either way, the child dies on the
   *  next tick, and the result reports `timedOut: true` after no real wait.
   *
   *  A caller that computes a limit (`gh-shepherd-pr.py:214` to `228` reads
   *  one from the environment) must validate it there. A runtime check here
   *  would have to throw, and {@link run} promises never to throw. */
  readonly timeoutMs?: number
}

export interface RunResult {
  /** The child's exit status, or `null` when a signal ended it. On a
   *  {@link startFailure}, this follows the shell's own convention. 127
   *  means a command not found. 126 means one that could not run. */
  readonly status: number | null
  /** The signal that ended the child, or `null`. `SIGKILL` here, with
   *  {@link timedOut} set, means the time limit fired. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Both streams, in the order their chunks arrived here. This is the port
   *  of `stderr=subprocess.STDOUT`. `lib/install.py:56` and
   *  `gh-shepherd-pr.py:441` read it as one transcript, and take its last
   *  line.
   *
   *  This is the arrival order of two pipes, not the child's own write
   *  order. It is as close as this gets without a shared descriptor. A
   *  caller that needs the two streams apart still has them apart, in
   *  `stdout` and `stderr`. */
  readonly combined: string
  /** Whether the time limit fired. `run_bounded` reports this as status
   *  124, the way coreutils `timeout` does. That translation is the job of
   *  the caller that publishes a status, not this file. */
  readonly timedOut: boolean
  /** How long the child actually took. `gh-shepherd-pr.py:266` measures the
   *  same thing, for the same reason. A watcher that returns early did not
   *  wait the full time limit. To say it did wait would mislead a caller
   *  that must decide whether to wait again. */
  readonly elapsedMs: number
  /** Set only when the child never ran. `null` means the child did run,
   *  whatever its exit status was. */
  readonly startFailure: StartFailure | null
  /** Every error from the child's three pipes that was not a broken pipe,
   *  in the order they arrived. An empty list is the ordinary case.
   *
   *  A broken pipe is left out. It means the reader left, not that the
   *  write failed, and `communicate()` swallows it too. Any other error
   *  means a write did not land, or a read did not finish. The output
   *  beside it may then be short. {@link status} may still be 0: a child
   *  handed half its stdin can still exit happily on what it got.
   *
   *  This field is the only place that fact gets recorded. That is why it
   *  is a field. It is not a throw, because the runner never rejects. It is
   *  not a listener that swallows the error either.
   *
   *  Round 5's #156 finding explains why. Any listener at all, once in
   *  place, silences node's own crash for every error on that stream.
   *  `lib/gh.ts` turns a non-empty list into a `GhError`. `lib/git.ts`
   *  cannot do this, and says so. */
  readonly streamErrors: readonly StreamFailure[]
}

/** The shape of {@link run}, for a caller that takes it as an injected
 *  seam. This caller reaches it instead of an import
 *  (`lib/gh.ts` `GhClientOptions.run`). This is an interface, not a class.
 *  `tsc` sees each type in `lib/` under two identities: `lib/` and each
 *  copy in `plugins/<p>/src/lib/` (ADR 006). Only a structural type
 *  survives that (round 5's rule, reproduced on #156). */
export type Runner = (
  command: string,
  args?: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>

/**
 * Kill `pid`'s whole process group.
 *
 * This is the port of `kill_group` (`hook-io.py:236`,
 * `gh-shepherd-pr.py:234`). It is also why {@link run} starts a bounded
 * child detached. `gh pr checks --watch` polls in a loop, and the sync
 * fan-out starts a child per repository. Suppose this code killed only the
 * one child this process holds. That child's own children would stay
 * active on the network, long after the caller gave up. A detached child
 * is a session leader. So the group signalled here cannot reach this
 * process, or the session that started it.
 *
 * A group that is already gone, or a platform with no process groups at
 * all, makes the signal throw. This is caught, not reported. Either way,
 * the caller's next act is to signal the child directly. This is the first
 * of two attempts, not the only one. "The group is already dead" is the
 * outcome it wanted.
 */
export const killGroup = (pid: number): void => {
  try {
    // The negative pid names the group. This uses SIGKILL, not SIGTERM, as
    // the Python does. The time limit has already expired, and a child that
    // ignores SIGTERM is exactly the child this code exists for.
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group may be gone, or this process may have no group to signal.
    // The signal may also be one this process cannot send (EPERM). EPERM
    // means the group survived, and only the one child below will die.
    // There is nothing to report and nothing to do here either way. The
    // direct kill in `run` always follows, and a refused kill after it
    // becomes a {@link RunResult.streamErrors} entry, not silence.
  }
}

/** ENOENT maps to a shell's 127 ("command not found"). Any other reason the
 *  child could not run maps to 126 ("cannot execute").
 *  `lib/install.py`, lines 58 to 71, argues for both mappings. Both
 *  statuses travel into the one-line reason a caller prints. */
const startStatus = (failure: StartFailure): number => (failure.code === 'ENOENT' ? 127 : 126)

/** A child that never ran, given back as an answer, not a throw. There is
 *  no output, no signal, and no time limit that fired, because nothing
 *  started. */
const refusedToStart = (failure: StartFailure, startedAt: number): RunResult => ({
  status: startStatus(failure),
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: Math.round(performance.now() - startedAt),
  startFailure: failure,
  streamErrors: [],
})

/**
 * Run `command` and report back everything the child did.
 *
 * This never rejects, even for an argv node refuses to hand to a child at
 * all. A child that fails, gets killed, or never starts is still an answer
 * here. Every ported call site already has a branch for each case. None of
 * them wants a `try` around the call. `lib/gh.ts` is where a failure
 * becomes a thrown error, at the one seam whose caller expects one.
 */
export const run: Runner = (command, args = [], options = {}) =>
  new Promise<RunResult>((resolve) => {
    // This uses `performance.now()`, not `Date.now()`. The Python measures
    // this with `time.monotonic()` on purpose (`gh-shepherd-pr.py:266`, "the
    // elapsed time is measured rather than assumed"). A wall clock can step
    // during a ninety second watch. Then it would hand a caller a wrong or
    // negative number, when the caller sizes its next wait.
    // `performance.now()` is a node global, so this file still imports
    // nothing from node beyond `child_process`.
    const startedAt = performance.now()
    // `spawn` reports most failures asynchronously, on the `error` event
    // below. But it checks argv synchronously. It throws for a NUL byte in
    // the command or in any argument (`ERR_INVALID_ARG_VALUE`, verified on
    // node 24).
    //
    // A throw in this executor would be a rejection. The doc comment above
    // promises that cannot happen. No caller in `gh.ts` or `git.ts` has a
    // `try` for it. This is a child that could not run, so it is answered
    // as one.
    let child: ChildProcessWithoutNullStreams | null = null
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        // Only a bounded child is detached. An unbounded one stays in this
        // process's group, so a Ctrl-C in the terminal reaches it. This is
        // what the unbounded `subprocess.run` calls in the Python get. Only
        // the bounded calls set `start_new_session=True`.
        detached: options.timeoutMs !== undefined,
        // This omits the `stdio` key. node's default already pipes all
        // three streams. If this code passed the key, it would select the
        // overload whose `stdout` and `stderr` are nullable. That would put
        // a `?.` (and so a branch no test can fail) on every read below.
        shell: false,
      })
    } catch (error) {
      // This asserts the type. It does not fall back to a default. The
      // `error` listener below makes the same trade, for the same reason.
      // node's argv check always throws a `TypeError` with an `ERR_*` code.
      // So a fallback branch would have no test that could ever reach it.
      //
      // The code here is never `ENOENT`. So `startStatus` answers 126: this
      // is a command that could not run, not one that could not be found.
      const rejected = error as NodeJS.ErrnoException & { code: string }
      resolve(refusedToStart({ code: rejected.code, message: rejected.message }, startedAt))
    }
    if (child === null) return

    const out: Buffer[] = []
    const err: Buffer[] = []
    const both: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
      both.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk)
      both.push(chunk)
    })

    // This uses one listener for all three pipes, with no branch. A child
    // that exits before it reads its input makes the stdin write fail with
    // EPIPE. With no listener, that is an uncaught exception. It crashes
    // the whole process, even though the child's own status and output are
    // already in hand. `communicate()` swallows the same BrokenPipeError,
    // for the same reason.
    //
    // stdout and stderr need the listener just as much, for the opposite
    // failure. With no listener, an error there is an uncaught exception
    // out of the event loop.
    //
    // This does NOT swallow every other error code. An empty listener would
    // silence an ENOSPC or an EIO on all three streams. A child handed half
    // its stdin can still exit 0 on what it got. So the result would then
    // report success for a run that was cut short. {@link streamFailures}
    // is the one place that rule lives. It returns the full account, not a
    // verdict, so this listener adds no branch a real child cannot reach.
    const streamErrors: StreamFailure[] = []
    const noteStreamError = (error: NodeJS.ErrnoException): void => {
      streamErrors.push(...streamFailures(error))
    }
    child.stdin.on('error', noteStreamError)
    child.stdout.on('error', noteStreamError)
    child.stderr.on('error', noteStreamError)
    child.stdin.end(options.stdin)

    let timedOut = false
    // The pid is `undefined` exactly when the spawn failed outright. node
    // reports this synchronously for ENOENT and EACCES. There is then no
    // child to bound, and the `error` event below is already on its way.
    const pid = child.pid
    const timer =
      options.timeoutMs === undefined || pid === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            killGroup(pid)
            // This kill runs unconditionally, not only as a fallback for a
            // group kill that failed. A kill sent to a child that is
            // already dead is a no-op in node. `kill` answers false and
            // throws nothing, so the second signal costs nothing. A
            // conditional call here would be a branch no test could reach
            // on a live child.
            child.kill('SIGKILL')
          }, options.timeoutMs)

    let startFailure: StartFailure | null = null
    // node emits `error` on a child for four different reasons, not one.
    // They are a child that could not be spawned, and a child that could
    // not be killed. They are also a failed message send, and an abort.
    // Only the first is a failure to start.
    //
    // The time limit's own `child.kill('SIGKILL')` above is a live source
    // of the second reason (EPERM). If this code recorded that as a
    // `startFailure`, it would replace a ninety second `gh` call's real
    // status with 126. It would report "cannot run gh" for a child that ran
    // to completion. That would break this field's documented meaning: that
    // the child never ran.
    //
    // node emits `spawn` only for a child that actually started. A reporter
    // swap at that point separates the two cases, with no branch and no
    // flag to read.
    let report = (error: NodeJS.ErrnoException): void => {
      // This asserts the type, rather than a `?? error.name` fallback.
      // Every failure node reports for a child that could not start comes
      // from libuv. It carries an errno code (ENOENT and EACCES both
      // verified here). A fallback branch would have no test that could
      // ever reach it. The assertion is erased at runtime and adds no
      // branch. This is the same trade `node-floor.ts` makes on its own
      // match groups.
      const failed = error as NodeJS.ErrnoException & { code: string }
      startFailure = { code: failed.code, message: failed.message }
    }
    child.on('error', (error) => {
      report(error)
    })
    child.once('spawn', () => {
      report = noteStreamError
    })

    // This listens for `close`, not `exit`. `close` fires only once the
    // child has ended and its stdio has closed. So the last chunk of
    // output is always already here. A spawn that fails also emits `error`
    // and
    // then `close` (verified on node 24 for both ENOENT and EACCES). So
    // this is the one place the promise settles, and no second-settle
    // guard is needed.
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const failure: StartFailure | null = startFailure
      resolve({
        // `code` on a failed spawn is the negative errno. No caller should
        // see that value, so the shell's own convention replaces it.
        status: failure === null ? code : startStatus(failure),
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        combined: Buffer.concat(both).toString('utf8'),
        timedOut,
        elapsedMs: Math.round(performance.now() - startedAt),
        startFailure: failure,
        streamErrors,
      })
    })
  })

/** A stream {@link endOnceWritten} can wait on: `write` calls back once
 *  the text, and all text before it, has left this process. */
export interface FlushableStream {
  write(text: string, done: () => void): boolean
}

/** Whether `resources`, the names `process.getActiveResourcesInfo()`
 *  gives, hold a filesystem request that has not answered. node names one
 *  `FSReqPromise` or `FSReqCallback` (measured on node 24). */
export const readPending = (resources: readonly string[]): boolean =>
  resources.some((name) => name.startsWith('FSReq'))

/**
 * Once each of `streams` has flushed, wait `graceMs`. If a filesystem
 * request still holds this process then, call `end`. A hook entry passes a
 * `SIGKILL` of itself as `end`, and `process.getActiveResourcesInfo` as
 * `resources`.
 *
 * A read that hangs on a slow filesystem holds a worker thread. node waits
 * for that thread on every exit path, `process.exit` too (measured on node
 * 24 with a read of a FIFO that no process writes to). So only a signal
 * ends it. Claude Code drops all output of a hook that passes its
 * `timeout` (https://code.claude.com/docs/en/hooks, "Timeouts"). So the
 * output must leave first, and then the process must end. `hooks.json`'s
 * `; exit 0` turns the signal into exit 0 (#267).
 *
 * Only a pending read is a reason. A child that the deadline killed can
 * take longer than `graceMs` to close, and it ends by itself (the gh hook's
 * hung fetch test on Linux CI, run 38409820735). The timer does not hold
 * the process either: a process that nothing holds ends before it fires.
 */
export const endOnceWritten = (
  streams: readonly FlushableStream[],
  graceMs: number,
  end: () => void,
  resources: () => readonly string[],
): void => {
  let waiting = streams.length
  for (const stream of streams) {
    stream.write('', () => {
      waiting -= 1
      if (waiting > 0) return
      setTimeout(() => {
        if (readPending(resources())) end()
      }, graceMs).unref()
    })
  }
}
