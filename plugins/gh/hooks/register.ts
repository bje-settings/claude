// The hooks module of the gh plugin (#488, #496, ADR 007). It draws the
// repo status row under the prompt, and keeps it fresh.
//
// The row is the first row of the prompt hint (`ui.render` on
// `PromptHint`). So it shows under the prompt on the terminal and desktop.
// No render site of the engine sits between the `statusLine` and the
// permission mode line (#496). A surface that never draws the prompt hint,
// such as VS Code or mobile, gets the plain text with `$.ui.status`.
//
// The counts come from `hooks/hook-io.ts status --json <dir>`, which this module
// runs as a host command with `$.process.run`. So no count logic is here.
// The `SessionStart` command hook in `hooks.json` keeps only the dependency
// check (ADR 007, ruling 7).
//
// The module imports no `node:` module and no `src/lib/` copy (ADR 007,
// ruling 6). Its decisions are in `src/status-pin.ts`, which vitest
// measures. A helper that takes `$` is a `function` declaration.
// `claude plugin validate` refused a `const` arrow that took `$` (#392).
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'
import {
  changesCounts,
  failureText,
  outcomeOf,
  plainText,
  REFRESH_MS,
  type Report,
  RUN_TIMEOUT_MS,
  SEGMENT_COLOUR,
  segmentsOf,
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
  /** True after a failed run was logged. A run that gives a report sets
   *  it back, so each run of failures gets one log line. */
  logged: boolean
  /** True after the problems of a report were logged. A report with no
   *  problems sets it back, so each run of problems gets one log line. */
  problemsLogged: boolean
  /** The refresh timer. A second `session.start` in the same module
   *  replaces it, so only one timer runs. */
  timer: Timer | undefined
  /** The last report a run gave, or `undefined` before the first one. */
  report: Report | undefined
  /** True after a run failed. The row then draws dim and with no colour,
   *  with the last good report, until a run gives a report again. */
  stale: boolean
  /** True once the surface drew the prompt hint. The row is there, so no
   *  `$.ui.status` pin is needed. */
  hinted: boolean
}

/**
 * Run `status --json` for `cwd` and draw its report. A failed run keeps
 * the last report, drawn dim, and logs once for each run of failures. A
 * report with problems draws dim, and logs once for each run of problems.
 * No hook waits on this call, so the `catch` turns a run that rejects
 * into a log line.
 */
async function refresh($: EngineInterface, pin: Pin, cwd: string): Promise<void> {
  if (pin.running) {
    pin.again = true
    return
  }
  pin.running = true
  try {
    const ran = await $.process.run(
      ['node', `${$.plugin.root}/hooks/hook-io.ts`, 'status', '--json', cwd],
      {
        cwd,
        timeoutMs: RUN_TIMEOUT_MS,
      },
    )
    const outcome = outcomeOf(ran)
    if (outcome.kind === 'pin') {
      const { problems } = outcome.report
      // A report with problems draws dim, with no problem row. The
      // problems go to the log, once for each run of problems. A failed
      // run has its own log line, so neither hides the other.
      pin.logged = false
      if (problems.length === 0) pin.problemsLogged = false
      else if (!pin.problemsLogged) {
        pin.problemsLogged = true
        $.ui.log(`gh: ${problems.join('; ')}`)
      }
      pin.stale = false
      pin.report = outcome.report
      $.ui.invalidate('ui.render')
      $.ui.status(pin.hinted ? undefined : plainText(outcome.report))
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

/** Draw the row dim, and log `text` once for each run of failures. */
function report($: EngineInterface, pin: Pin, text: string): void {
  if (!pin.stale) {
    pin.stale = true
    $.ui.invalidate('ui.render')
  }
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
  const pin: Pin = {
    running: false,
    again: false,
    logged: false,
    problemsLogged: false,
    timer: undefined,
    report: undefined,
    stale: false,
    hinted: false,
  }

  on('session.start', ($, e, next) => {
    // Not awaited: the check fetches, and the session must not wait on it.
    void refresh($, pin, e.cwd)
    pin.timer?.cancel()
    pin.timer = $.clock.every(REFRESH_MS, () => {
      void refreshHere($, pin)
    })
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!pin.hinted) {
      // This surface draws the row, so the plain pin goes.
      pin.hinted = true
      $.ui.status(undefined)
    }
    const { report } = pin
    if (report === undefined) return next(e)
    const segments = segmentsOf(report)
    if (segments.length === 0) return next(e)
    const { Box, Link, Text } = $.ui.resolve(e)
    // A failed run, or a report with problems, draws the row dim and with
    // no colour. The row shows no problem text.
    const dimColor = pin.stale || report.problems.length > 0
    // One Text for each bracket, in its kind's colour, or with no colour
    // when the row is dim. A bracket with a page is a link.
    const brackets = segments.flatMap((segment) => {
      const body = segment.count === undefined ? segment.label : `${segment.label} ${segment.count}`
      const text = `[${body}]`
      const inner = segment.href === undefined ? text : h(Link, { href: segment.href }, text)
      const color = dimColor ? undefined : SEGMENT_COLOUR[segment.kind]
      return [' ', h(Text, { color, dimColor }, inner)]
    })
    const row = h(Text, { dimColor }, h(Text, { bold: true, dimColor }, 'gh:'), ...brackets)
    return h(Box, { flexDirection: 'column' }, row, await next(e)) as RenderElement
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && changesCounts(e.command)) void refreshHere($, pin)
    return ran
  })
}
