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
// measures. A helper that takes `$` is a `function` declaration, because
// `claude plugin validate` refused a `const` arrow that took `$` (#392).
import type { EngineInterface, Register } from 'claude-code'
import {
  changesCounts,
  failureText,
  pinnedText,
  REFRESH_MS,
  RUN_TIMEOUT_MS,
} from '../src/status-pin.ts'

/** What one session of this module keeps between hooks. */
interface Pin {
  /** True while a `status` run is open. A second request then does
   *  nothing, so two checks never run at once. */
  running: boolean
  /** True after a failed run was logged. A run that gives a line sets it
   *  back, so each run of failures gets one log line. */
  logged: boolean
  /** The refresh timer. A second `session.start` in the same module
   *  replaces it, so only one timer runs. */
  timer: { cancel: () => void } | undefined
}

/**
 * Run `status` for `cwd` and pin what it writes. A failed run keeps the
 * last line, and logs why once. This never rejects, because no hook waits
 * on it.
 */
async function refresh($: EngineInterface, pin: Pin, cwd: string): Promise<void> {
  if (pin.running) return
  pin.running = true
  try {
    const ran = await $.process.run(['node', `${$.plugin.root}/hooks/hook-io.ts`, 'status', cwd], {
      cwd,
      timeoutMs: RUN_TIMEOUT_MS,
    })
    if (ran.exitCode === 0) {
      pin.logged = false
      $.ui.status(pinnedText(ran.stdout))
    } else {
      report($, pin, failureText({ exitCode: ran.exitCode, stderr: ran.stderr }))
    }
  } catch (error) {
    report($, pin, failureText({ error }))
  } finally {
    pin.running = false
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
  const pin: Pin = { running: false, logged: false, timer: undefined }

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
