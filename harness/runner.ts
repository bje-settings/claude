// A `RunResult` factory and a table-driven `Runner`, for a test that runs a
// command function in process with no child. The workstreams `SessionStart`
// test held the only copy (#324). The types are the shipped ones, in
// `lib/process.ts`.
import type { Runner, RunResult } from '../lib/process.ts'

/** What a child that ran and said `reply` reports. A field that `reply`
 *  leaves out is the field of a child that exited 0 and wrote nothing. */
export const runResult = (reply: Partial<RunResult> = {}): RunResult => ({
  status: 0,
  signal: null,
  stdout: '',
  stderr: '',
  combined: '',
  timedOut: false,
  elapsedMs: 0,
  startFailure: null,
  streamErrors: [],
  ...reply,
})

/** One call a table runner answered. */
export interface Asked {
  readonly key: string
  readonly options: unknown
}

/**
 * A runner that answers each command from `table`, keyed by
 * `<command> <args>`, and records each call it was asked. A call with no
 * entry answers as a child that succeeded and said nothing.
 */
export const tableRunner = (
  table: Record<string, Partial<RunResult>>,
  asked: Asked[] = [],
): Runner & { asked: Asked[] } => {
  const runner: Runner = async (command, args = [], options = {}) => {
    const key = `${command} ${args.join(' ')}`.trim()
    asked.push({ key, options })
    return runResult(table[key] ?? {})
  }
  return Object.assign(runner, { asked })
}
