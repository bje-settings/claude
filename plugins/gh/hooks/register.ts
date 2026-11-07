// The hooks module of the gh plugin (#488, ADR 007). It pins the repo
// status line under the prompt with `$.ui.status`, and keeps it fresh.
//
// The counts come from `hooks/hook-io.ts status <dir>`, which this module
// runs as a host command with `$.process.run`. So no count logic is here.
// The `SessionStart` command hook in `hooks.json` keeps only the dependency
// check (ADR 007, ruling 7).
//
// The module imports no `node:` module and no `src/lib/` copy (ADR 007,
// ruling 6). Its decisions are in `src/status-pin.ts`, which vitest
// measures. A helper that takes `$` is a `function` declaration.
// `claude plugin validate` refused a `const` arrow that took `$` (#392).
import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  changesCounts,
  failureText,
  outcomeOf,
  REFRESH_MS,
  RUN_TIMEOUT_MS,
} from '../src/status-pin.ts'

/** What one session of this module keeps between hooks. */
interface Pin {
  /** True while a `status` run is open. A second request then waits in
   *  `again`, so two checks never run at once. */
  running: boolean
  /** True when a request came while a run was open. That run may have
   *  read the counts before the change, so one more run follows it. Any
   *  number of such requests gives one more run. */
  again: boolean
  /** True after a failed run was logged. A run that pins sets it back, so
   *  each run of failures gets one log line. */
  logged: boolean
  /** The refresh timer. A second `session.start` in the same module
   *  replaces it, so only one timer runs. */
  timer: Timer | undefined
}

/**
 * Run `status` for `cwd` and pin what it writes. A failed run keeps the
 * last line, and logs once for each run of failures. No hook waits on this
 * call, so the `catch` turns a run that rejects into a log line.
 */
async function refresh($: EngineInterface, pin: Pin, cwd: string): Promise<void> {
  if (pin.running) {
    pin.again = true
    return
  }
  pin.running = true
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/hooks/hook-io.ts`, 'status', cwd], {
      cwd,
      timeoutMs: RUN_TIMEOUT_MS,
    })
    const outcome = outcomeOf(ran)
    if (outcome.kind === 'pin') {
      pin.logged = false
      $.ui.status(outcome.text)
    } else {
      report($, pin, outcome.text)
    }
  } catch (error) {
    report($, pin, failureText({ error }))
  } finally {
    pin.running = false
  }
  if (pin.again) {
    pin.again = false
    await refreshHere($, pin)
  }
}

/** Log `text` once for each run of failures. */
function report($: EngineInterface, pin: Pin, text: string): void {
  if (pin.logged) return
  pin.logged = true
  $.ui.log(text)
}

/** Refresh for the session's directory now. The directory is read again
 *  each time, because `/cd` or a worktree move can change it. */
async function refreshHere($: EngineInterface, pin: Pin): Promise<void> {
  try {
    await refresh($, pin, await $.session.cwd())
  } catch (error) {
    report($, pin, failureText({ error }))
  }
}

export const register: Register = (on) => {
  const pin: Pin = { running: false, again: false, logged: false, timer: undefined }

  on('session.start', ($, e, next) => {
    // Not awaited: the check fetches, and the session must not wait on it.
    void refresh($, pin, e.cwd)
    pin.timer?.cancel()
    pin.timer = $.clock.every(REFRESH_MS, () => {
      void refreshHere($, pin)
    })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && changesCounts(e.command)) void refreshHere($, pin)
    return ran
  })
}
