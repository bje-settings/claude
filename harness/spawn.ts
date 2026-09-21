// Run a plugin's entry point as its own process, the way Claude Code runs it:
// the port of `run_script` and `Result` in tests/conftest.py.
//
// This is the only place the TypeScript suite spawns anything (ADR 001). A
// command function is tested by calling it with injected clients; `bin/` is a
// thin adapter over it, and the one thing an in-process call cannot cover is
// the process boundary itself, so each entry point gets one spawned contract
// test: argv in, exit code and streams out.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'

/** status, stdout and stderr of one run.
 *
 *  The raw bytes are kept beside the decoded text for the assertions that are
 *  about bytes rather than about text; `stdout` is what almost every test
 *  wants.
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
 *  `process.execPath`, not `node`: it is the interpreter the suite itself is
 *  running under, so a run on the 22.18 floor leg genuinely exercises 22.18
 *  rather than whatever `node` happens to resolve to on PATH.
 *
 *  Throws when the child could not be started at all (a cwd that does not
 *  exist, say), because there is no status or output to assert on in that
 *  case and a result full of empty strings would read as a command that ran
 *  and said nothing.
 */
export function runScript(entry: string, options: SpawnOptions = {}): SpawnResult {
  const { args = [], stdin, env, cwd } = options
  const result = spawnSync(process.execPath, [entry, ...args], { input: stdin, env, cwd })
  if (result.error) {
    throw result.error
  }
  return {
    status: result.status,
    // Replacement rather than strict decoding: a command that emits a stray
    // byte would otherwise throw here and lose the status and the rest of the
    // output, turning a legible assertion failure into a decoding error.
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    stdoutBytes: result.stdout,
    stderrBytes: result.stderr,
  }
}

/** One running child, with its pipes still open.
 *
 *  {@link runScript} is `spawnSync` and drains both streams before it
 *  returns, so nothing it runs can have its reader taken away part-way: the
 *  EPIPE guard every entry point carries is unpinnable through it (round 5's
 *  handoff note from #156). This is the variant that can, and it is a variant
 *  rather than a replacement because every other spawned test wants the
 *  simple thing.
 */
export interface SpawnedScript {
  /** The child itself, for a test that needs something these three do not
   *  give it. */
  readonly child: ChildProcessWithoutNullStreams
  /** The first line the child writes to stdout, without its newline.
   *
   *  Resolves with what arrived when the stream ends without one, which is
   *  what a caller reading a single line off a short answer gets. */
  firstLine(): Promise<string>
  /** Close this end of the child's stdout, as `| head -1` does once head has
   *  had enough. The child's next write to it fails with EPIPE. */
  closeStdout(): void
  /** status, signal and stderr, once the child has ended. stdout is not
   *  collected: the point of this variant is that the reader stops reading,
   *  and a buffer of everything would be the thing that cannot happen. */
  ended(): Promise<EndedResult>
}

export interface EndedResult {
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

/** Start `entry` under this same node binary and hand back its pipes.
 *
 *  Same argv, environment and working directory as {@link runScript}, and the
 *  same `process.execPath` for the same reason; what differs is only that the
 *  child is still running when this returns.
 */
export function startScript(entry: string, options: SpawnOptions = {}): SpawnedScript {
  const { args = [], stdin, env, cwd } = options
  const child = spawn(process.execPath, [entry, ...args], { env, cwd })
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
        child.stdout.on('data', take)
        child.stdout.once('end', () => {
          child.stdout.off('data', take)
          resolve(seen)
        })
      })
    },

    closeStdout(): void {
      child.stdout.destroy()
    },

    ended(): Promise<EndedResult> {
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      return new Promise<EndedResult>((resolve) => {
        child.on('close', (status, signal) => {
          resolve({ status, signal, stderr })
        })
      })
    },
  }
}
