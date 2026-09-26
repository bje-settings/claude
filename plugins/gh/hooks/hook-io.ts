// This file is the entry point for the gh plugin's SessionStart hook.
// `hooks.json` runs it directly. It holds no decisions:
// `src/subcommands/hook-io.ts` is the hook, and it takes the process's own
// edges as arguments. The tests call it there, with no process.
//
// **One static import, and it is the floor guard.** Node evaluates every
// `import` declaration before any statement here runs. A second static
// import would load its whole module graph on the runtime that this guard
// must refuse. This file calls `meetsNodeFloor`, not `assertNodeFloor`: a
// hook that writes to stderr writes into the session. Below the floor, this
// file exits 0 and writes nothing. `hooks.json`'s `command -v node ... ;
// exit 0` covers a machine with no node, and a hook file that is missing.
//
// **Nothing here may stop a session.** An unexpected error inside the `try`
// block writes its stack to stderr, which Claude Code keeps in its debug
// log, and the exit status stays 0. The usage error returns 2 from inside
// the `try` block, on purpose. A failure in an `await import`, or in
// `createOutput`, is outside the `try` block and exits non-zero. Neither
// writes to stdout, and `hooks.json`'s `; exit 0` absorbs both statuses.
//
// **Below the floor, this writes one line and exits 0 (#245).** A
// `SessionStart` hook runs once, not on every tool call, so it may say so
// where a per-tool-call hook must stay silent. `belowFloorMessage` builds
// the line; this writes the `systemMessage` JSON itself, with no colour
// and no further import, so the write cannot depend on a module graph the
// runtime below the floor might not load.
import { belowFloorMessage, meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { createGhClient } = await import('../src/lib/gh.ts')
  const { DEADLINE_MS, runHookIo } = await import('../src/subcommands/hook-io.ts')

  // Both streams are guarded here, not at each write. A reader that closes
  // the pipe makes a later write fail as an `error` event, and with no
  // listener node crashes with a stack trace. The writer ignores a broken
  // pipe, and nothing else (`lib/streams.ts`).
  const output = createOutput(process.stdout, process.stderr)

  try {
    process.exitCode = await runHookIo(process.argv.slice(2), {
      cwd: () => process.cwd(),
      env: process.env,
      stdin: () => readStdinText(process.stdin),
      output,
      createGh: (env) => createGhClient({ env }),
      deadlineMs: DEADLINE_MS,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
} else {
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `\ngh: ${belowFloorMessage(process.version)}` })}\n`,
  )
  process.exitCode = 0
}
