// Run a plugin's entry point as its own process, the way Claude Code runs it:
// the port of `run_script` and `Result` in tests/conftest.py.
//
// This is the only place the TypeScript suite spawns anything (ADR 001). A
// command function is tested by calling it with injected clients; `bin/` is a
// thin adapter over it, and the one thing an in-process call cannot cover is
// the process boundary itself, so each entry point gets one spawned contract
// test: argv in, exit code and streams out.
import { spawnSync } from 'node:child_process'

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
