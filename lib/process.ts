// One child process, run with no shell, with a time bound that can be made
// to stick. This is what `lib/gh.ts`'s private `execFile` adapter was
// deliberately not (#154's header says so in as many words), and #127 is the
// first consumer: the `gh` client below it, the git helpers in `git.ts`, and
// the hook's one bounded child (`plugins/gh/hooks/hook-io.py` lines 276 to
// 313) all want the same four answers, and the Python spells them four times.
//
// It is the port of three Python shapes at once:
//
//   - `subprocess.run(..., stdout=PIPE)` as `gh-sync-repo.py:76` and
//     `lib/discover.py:56` call it: capture, never raise.
//   - `subprocess.run(..., stderr=STDOUT)` as `lib/install.py:52` and
//     `gh-shepherd-pr.py:438` call it: one interleaved transcript.
//   - `Popen(..., start_new_session=True)` plus `communicate(timeout=...)` and
//     a process-group kill, as `run_bounded` (`gh-shepherd-pr.py:248`) and
//     `hook-io.py:276` call it.
//
// **Failure to start is not failure to succeed.** `lib/install.py` lines 41
// to 71 separate them and the port keeps that separation: a `FileNotFoundError`
// is reported as 127 and anything else unrunnable as 126, which are the
// statuses a shell uses for exactly those two cases, so a caller's one-line
// reason reads as it always did. {@link RunResult.startFailure} carries the
// same fact in a form a caller can branch on without reading prose, which is
// what `gh-sync-repo.py:196` to `205` needs to tell "git is not on PATH" from
// "git is on PATH and still would not run".
//
// **No shell, ever.** Every argument reaches the child as written, so a
// branch name or a comment body carrying shell metacharacters is an argument
// rather than a word a shell gets to re-read.
//
// This file ships. It imports nothing outside the root lib and nothing from
// node beyond `child_process`, and stays inside the erasable subset (ADR 001).

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

/** Why a child never ran at all. */
export interface StartFailure {
  /** node's own error code: `ENOENT` for a command that is not on PATH or a
   *  `cwd` that is gone, `EACCES` for a file that is there and not
   *  executable. */
  readonly code: string
  /** node's message, which names the command and the code. */
  readonly message: string
}

export interface RunOptions {
  /** Where the child runs. A directory that does not exist is a
   *  {@link StartFailure}, not a throw. */
  readonly cwd?: string
  /** The child's whole environment. Left out, the child inherits this
   *  process's, which is what every ported call site does. */
  readonly env?: NodeJS.ProcessEnv
  /** Written to the child and then closed. Left out, the child still gets a
   *  pipe, closed immediately, so a child that reads stdin sees EOF rather
   *  than blocking on a descriptor nobody will ever write to. */
  readonly stdin?: string | Uint8Array
  /** The bound, in milliseconds. When it fires, the child's whole process
   *  group is killed (see {@link killGroup}) and {@link RunResult.timedOut}
   *  says so. Left out, the child is waited for as long as it takes, which is
   *  what an unbounded `subprocess.run` does. */
  readonly timeoutMs?: number
}

export interface RunResult {
  /** The child's exit status, or `null` when a signal ended it. On a
   *  {@link startFailure} it is the shell's own convention: 127 for a command
   *  that could not be found, 126 for one that could not be run. */
  readonly status: number | null
  /** The signal that ended the child, or `null`. `SIGKILL` here with
   *  {@link timedOut} set is the bound firing. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Both streams in the order their chunks arrived here: the port of
   *  `stderr=subprocess.STDOUT`, which `lib/install.py:56` and
   *  `gh-shepherd-pr.py:441` read as one transcript and take the last line
   *  of. It is the arrival order of two pipes rather than the child's own
   *  write order, which is as close as this gets without a shared descriptor,
   *  and a caller that needs the two apart still has them apart. */
  readonly combined: string
  /** Whether the bound fired. `run_bounded` reports this as status 124, the
   *  way coreutils `timeout` does; that translation belongs to the caller
   *  that publishes a status, not to the transport. */
  readonly timedOut: boolean
  /** How long the child actually took. `gh-shepherd-pr.py:266` measures the
   *  same thing for the same reason: a watcher that returned early did not
   *  wait the bound, and saying it did misleads a caller deciding whether to
   *  wait again. */
  readonly elapsedMs: number
  /** Set only when the child never ran. `null` means the child ran, whatever
   *  it then exited with. */
  readonly startFailure: StartFailure | null
}

/** The shape of {@link run}, for a caller that takes it as an injected seam
 *  rather than importing it (`lib/gh.ts` `GhClientOptions.run`). An interface
 *  and not a class, because every type that crosses the `src/lib` symlink is
 *  seen by `tsc` under two identities and only a structural one survives that
 *  (round 5's rule, reproduced on #156). */
export type Runner = (
  command: string,
  args?: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>

/**
 * Kill `pid`'s whole process group.
 *
 * The port of `kill_group` (`hook-io.py:236`, `gh-shepherd-pr.py:234`), and
 * the reason {@link run} starts a bounded child detached: `gh pr checks
 * --watch` polls in a loop and the sync fan-out starts a child per
 * repository, so killing the one child this process holds would leave its
 * children running against the network long after the caller gave up. A
 * detached child is a session leader, so the group signalled here cannot
 * reach this process or the session that started it.
 *
 * A group that is already gone, or a platform with no process groups at all,
 * makes the signal throw. That is caught and not reported, because the
 * caller's next act is to signal the child directly in any case: this is the
 * first of two attempts, not the only one, and "the group is already dead" is
 * the outcome it wanted.
 */
export const killGroup = (pid: number): void => {
  try {
    // The negative pid is the group. SIGKILL rather than SIGTERM, as the
    // Python does: the bound has already expired, and a child that ignores
    // SIGTERM is exactly the child this exists for.
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone, or no group to signal. Nothing to report and nothing to
    // do: the direct kill in `run` follows unconditionally.
  }
}

/** ENOENT is a shell's 127 ("command not found"), everything else that kept
 *  the child from running is its 126 ("cannot execute"). `lib/install.py`
 *  lines 58 to 71 argue both, and both statuses travel into the one-line
 *  reason a caller prints. */
const startStatus = (failure: StartFailure): number => (failure.code === 'ENOENT' ? 127 : 126)

/** A child that never ran, as an answer rather than a throw. There is no
 *  output, no signal and no bound to have fired, because nothing started. */
const refusedToStart = (failure: StartFailure, startedAt: number): RunResult => ({
  status: startStatus(failure),
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: Date.now() - startedAt,
  startFailure: failure,
})

/**
 * Run `command` and answer with everything the child did.
 *
 * Never rejects, including for the argv node refuses to hand to a child at
 * all. A child that fails, is killed, or never starts is an answer here,
 * because every ported call site already has a branch for each of those and
 * none of them wants a `try` around the call. `lib/gh.ts` is where a failure
 * becomes a thrown error, at the seam that has a caller who models one.
 */
export const run: Runner = (command, args = [], options = {}) =>
  new Promise<RunResult>((resolve) => {
    const startedAt = Date.now()
    // `spawn` reports most failures asynchronously, on the `error` event
    // below, but it validates argv **synchronously** and throws for a NUL
    // byte in the command or in any argument (`ERR_INVALID_ARG_VALUE`,
    // verified on node 24). Thrown in this executor that would be a
    // rejection, which is the one thing the doc comment above promises
    // cannot happen and which no caller in `gh.ts` or `git.ts` has a `try`
    // for. It is a child that could not be run, so it is answered as one.
    let child: ChildProcessWithoutNullStreams | null = null
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        // Only a bounded child is detached. An unbounded one stays in this
        // process's group so that a Ctrl-C in the terminal reaches it, which
        // is what the unbounded `subprocess.run` calls in the Python get; the
        // bounded ones are the ones that set `start_new_session=True`.
        detached: options.timeoutMs !== undefined,
        // No `stdio` key: node's default is a pipe on all three, and passing
        // the key selects the overload whose `stdout` and `stderr` are
        // nullable, which would put a `?.` (and so a branch no test can fail)
        // on every read below.
        shell: false,
      })
    } catch (error) {
      // Asserted rather than defaulted, the same trade the `error` listener
      // below makes and for the same reason: node's argv validation throws a
      // `TypeError` that always carries an `ERR_*` code, so a fallback would
      // be an arm no test could produce an input for. The code is not
      // `ENOENT`, so `startStatus` answers 126: this is a command that could
      // not be run rather than one that could not be found.
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

    // A child that exits before it has read what it was given makes this
    // write fail with EPIPE, which with no listener is an uncaught exception
    // that takes the whole process down while the child's own status and
    // output are already in hand. `communicate()` swallows the same
    // BrokenPipeError for the same reason.
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin)

    let timedOut = false
    // The pid is `undefined` exactly when the spawn failed outright, which
    // node reports synchronously for ENOENT and EACCES; there is then no
    // child to bound and the `error` event below is already on its way.
    const pid = child.pid
    const timer =
      options.timeoutMs === undefined || pid === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            killGroup(pid)
            // Unconditional rather than a fallback for a group kill that
            // failed: killing a child that is already dead is a no-op in node
            // (`kill` answers false and throws nothing), so the second signal
            // costs nothing, while a conditional one would be a branch no
            // test could reach on a live child.
            child.kill('SIGKILL')
          }, options.timeoutMs)

    let startFailure: StartFailure | null = null
    child.on('error', (error) => {
      // The assertion rather than a `?? error.name` fallback: every failure
      // node reports on a child process comes from libuv and carries an
      // errno code (ENOENT and EACCES both verified here), so the fallback
      // would be an arm no test could produce an input for. Asserting it is
      // erased at runtime and adds no branch, which is the same trade
      // `node-floor.ts` makes on its own match groups.
      const failed = error as NodeJS.ErrnoException & { code: string }
      startFailure = { code: failed.code, message: failed.message }
    })

    // `close` and not `exit`: it fires once the child has ended **and** its
    // stdio has closed, so the last chunk of output is always already here.
    // A spawn that failed emits `error` and then `close` too (verified on
    // node 24 for both ENOENT and EACCES), so this is the one place the
    // promise settles and there is no second-settle guard to cover.
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const failure: StartFailure | null = startFailure
      resolve({
        // `code` on a failed spawn is the negative errno, which is not a
        // status any caller should see; the shell's convention replaces it.
        status: failure === null ? code : startStatus(failure),
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        combined: Buffer.concat(both).toString('utf8'),
        timedOut,
        elapsedMs: Date.now() - startedAt,
        startFailure: failure,
      })
    })
  })
