// This file is the entry point for the workstreams plugin's `SessionStart`
// hook. `hooks.json` runs it directly. It holds no decisions:
// `src/subcommands/session-start.ts` is the hook, and it takes the
// process's own edges as arguments. The tests call it there, with no
// process (`plugins/gh/hooks/hook-io.ts` sets the shape this follows).
//
// **One static import, and it is the floor guard.** Node evaluates every
// `import` declaration before any statement here runs. A second static
// import would load its whole module graph on the runtime that this guard
// must refuse. This file calls `meetsNodeFloor`, not `assertNodeFloor`: a
// hook that writes to stderr writes into the session. Below the floor, see
// the note below. `hooks.json`'s own guard covers a machine with no node
// at all, and a hook file that is missing.
//
// **Nothing here may stop a session.** An unexpected error inside the
// `try` block writes its stack to stderr. Claude Code keeps that stack in
// its debug log, and the exit status stays 0. A failure in an `await
// import` is outside the `try` block, and exits non-zero from node
// itself. Neither writes to stdout, and `hooks.json`'s `; exit 0` absorbs
// both statuses.
//
// **Below the floor, this writes one line and exits 0.** A `SessionStart`
// hook runs once, not on every tool call. So it may say so, where a
// per-tool-call hook must stay silent. `belowFloorMessage` builds the
// line. This file writes the `systemMessage` JSON itself, with no colour
// and no further import. So the write does not depend on a module graph
// that the runtime below the floor might not load.
import { belowFloorMessage, meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { createOutput } = await import('../src/lib/streams.ts')
  const { run } = await import('../src/lib/process.ts')
  const { DEADLINE_MS, runSessionStart } = await import('../src/subcommands/session-start.ts')

  // Both streams are guarded here, not at each write. A reader that closes
  // the pipe makes a later write fail as an `error` event, and with no
  // listener node crashes with a stack trace. The writer ignores a broken
  // pipe, and nothing else (`lib/streams.ts`).
  const output = createOutput(process.stdout, process.stderr)

  try {
    process.exitCode = await runSessionStart({
      env: process.env,
      output,
      run,
      deadlineMs: DEADLINE_MS,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
} else {
  // A closed reader makes this write fail asynchronously, as an `error`
  // event. This is the same failure `lib/streams.ts` guards on every
  // other write in this plugin. This branch cannot import
  // `createOutput`: it must stay inside the one-static-import contract
  // above. So the guard is inline instead, with no import, and it keeps
  // the same rule: only EPIPE is swallowed, and anything else still
  // surfaces.
  process.stdout.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error
  })
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `\nworkstreams: ⚠️ ${belowFloorMessage(process.version)}` })}\n`,
  )
  process.exitCode = 0
}
