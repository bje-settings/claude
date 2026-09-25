// Run a plugin's entry point as its own process, the way Claude Code runs
// it. This is the port of `run_script` and `Result` in tests/conftest.py
// (deleted at #138).
//
// This is the only place the TypeScript suite spawns anything (ADR 001).
// A test calls a command function directly, with injected clients.
// `scripts/` is a thin adapter over it. An in-process call cannot cover
// one thing: the process boundary itself. So each entry point gets one
// spawned contract test: argv in, exit code and streams out.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'

/** status, stdout and stderr of one run.
 *
 *  The raw bytes sit beside the decoded text, for assertions about bytes,
 *  not text. `stdout` is what almost every test wants.
 */
export interface SpawnResult {
  /** The exit code, or null when a signal killed the child. */
  status: number | null
  stdout: string
  stderr: string
  stdoutBytes: Buffer
  stderrBytes: Buffer
}

export interface SpawnOptions {
  /** Arguments after the entry point, as `process.argv.slice(2)` sees them. */
  args?: string[]
  /** Bytes as well as text, for the commands whose contract is bytes. */
  stdin?: string | Uint8Array
  /** The child's whole environment. A sandbox's `env` is what to pass. */
  env?: NodeJS.ProcessEnv
  /** Run the child from another directory, for a command that reads the
   *  directory it was called in. */
  cwd?: string
}

/** Run `entry` under this same node binary and wait for it.
 *
 *  This uses `process.execPath`, not `node`. It is the interpreter the
 *  suite itself runs under. So a run on the 22.18 floor leg genuinely
 *  tests 22.18, not whatever `node` happens to resolve to on PATH.
 *
 *  This throws when the child could not start at all (a cwd that does not
 *  exist, say). There is no status or output to check in that case, and a
 *  result full of empty strings would read as a command that ran and said
 *  nothing.
 */
export function runScript(entry: string, options: SpawnOptions = {}): SpawnResult {
  const { args = [], stdin, env, cwd } = options
  const result = spawnSync(process.execPath, [entry, ...args], { input: stdin, env, cwd })
  if (result.error) {
    throw result.error
  }
  return {
    status: result.status,
    // This decodes with replacement, not strictly. A command that emits a
    // stray byte would otherwise throw here, and lose the status and the
    // rest of the output. That would turn a legible assertion failure into
    // a decoding error.
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    stdoutBytes: result.stdout,
    stderrBytes: result.stderr,
  }
}

/** One child process, still active, with its pipes still open.
 *
 *  {@link runScript} uses `spawnSync` and drains both streams before it
 *  returns. So nothing it runs can lose its reader part-way through. This
 *  means the EPIPE guard every entry point carries cannot be tested
 *  through {@link runScript} (round 5's handoff note from #156). This
 *  variant can test it. It is a variant, not a replacement, because every
 *  other spawned test wants the simple thing.
 */
export interface SpawnedScript {
  /** The child itself, for a test that needs something these three do not
   *  give it. */
  readonly child: ChildProcessWithoutNullStreams
  /** The first line the child writes to stdout, without its newline.
   *
   *  If the stream ends without a newline, this resolves with whatever
   *  arrived. That is what a caller gets when it reads a single line off a
   *  short answer. */
  firstLine(): Promise<string>
  /** Close this end of the child's stdout, as `| head -1` does once head has
   *  had enough. The child's next write to it fails with EPIPE. */
  closeStdout(): void
  /** status, signal and stderr, once the child has ended. This does not
   *  collect stdout. The point of this variant is that the reader stops,
   *  and a buffer of everything is the one thing that must not happen.
   *
   *  This rejects, instead of answering, when the child could not start at
   *  all. `runScript` throws there for the reason its own docblock gives.
   *  The status of `-2` that follows a failed spawn would otherwise read
   *  here as a command that ran and said nothing. It gives the same
   *  answer every time, however many times a caller asks. */
  ended(): Promise<EndedResult>
}

export interface EndedResult {
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

/** Start `entry` under this same node binary and hand back its pipes.
 *
 *  This uses the same argv, environment, and working directory as
 *  {@link runScript}, and the same `process.execPath`, for the same
 *  reason. Two things differ. The child is still running when this
 *  returns. A start failure surfaces at {@link SpawnedScript.ended},
 *  instead of a throw from here, because `spawn` reports it as an event
 *  several ticks later, while `spawnSync` has the answer before it
 *  returns.
 */
export function startScript(entry: string, options: SpawnOptions = {}): SpawnedScript {
  const { args = [], stdin, env, cwd } = options
  const child = spawn(process.execPath, [entry, ...args], { env, cwd })

  // This function registers every listener below here, not inside
  // `ended()`, because `close` and `error` each fire once. A listener
  // added after the fact hears nothing. So a wait started late, or a
  // second wait, would never settle. It would then present as a bare
  // suite timeout, with nothing that points at this file.
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  // A child that never started arrives as an `error` event, not a throw
  // from `spawn`, and `close` still follows it with a status of -2. With
  // no listener, node raises it as an uncaught exception. Vitest then
  // attributes that exception to whichever example happens to be in
  // flight, and reports it against the node binary, not against the
  // argument that was wrong. This function holds the error here, and
  // raises it at `ended()`, where a caller is already waiting.
  let failure: Error | null = null
  const finished = new Promise<EndedResult>((resolve, reject) => {
    child.on('error', (error: Error) => {
      failure = error
      reject(error)
    })
    child.on('close', (status, signal) => {
      if (failure === null) resolve({ status, signal, stderr })
    })
  })
  // Nobody has awaited it yet, and a rejection with no handler in the same
  // tick is an unhandled rejection. The caller reaches it through `ended()`.
  finished.catch(() => {})
  // The child may exit before it reads its stdin. A payload past the
  // pipe buffer is then still in flight when the reader goes, and this end
  // gets EPIPE. That is the reader's exit, the state this variant exists
  // to stage, not a failure of the run.
  child.stdin.on('error', () => {})
  child.stdin.end(stdin)

  return {
    child,

    firstLine(): Promise<string> {
      return new Promise<string>((resolve) => {
        let seen = ''
        const take = (chunk: Buffer): void => {
          seen += chunk.toString('utf8')
          const newline = seen.indexOf('\n')
          if (newline === -1) return
          child.stdout.off('data', take)
          resolve(seen.slice(0, newline))
        }
        const stop = (): void => {
          child.stdout.off('data', take)
          resolve(seen)
        }
        child.stdout.on('data', take)
        child.stdout.once('end', stop)
        // This listens for `close` as well as `end`, because a destroyed
        // stream never emits `end`. Without this, a line asked for after
        // `closeStdout`, or after a child that never started, would wait
        // out the suite timeout. Both events may fire. If the promise
        // resolves twice, the first answer wins, since it is the one that
        // read something.
        child.stdout.once('close', stop)
      })
    },

    closeStdout(): void {
      child.stdout.destroy()
    },

    ended(): Promise<EndedResult> {
      return finished
    },
  }
}
