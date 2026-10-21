// This file is the entry point for the gh plugin's SessionStart hook.
// `hooks.json` runs it directly. It holds no decisions:
// `src/subcommands/hook-io.ts` is the hook, and it takes the process's own
// edges as arguments. The tests call it there, with no process.
//
// **One static import, and it is the floor guard.** Node evaluates every
// `import` declaration before any statement here runs. A second static
// import would load its whole module graph on the runtime that this guard
// must refuse. This file calls `meetsNodeFloor`, not `assertNodeFloor`: a
// hook that writes to stderr writes into the session. Below the floor, see
// the note below (#245). `hooks.json`'s own guard covers a machine with no
// node, and a hook file that is missing.
//
// **Nothing here may stop a session.** An unexpected error inside the `try`
// block writes its stack to stderr, which Claude Code keeps in its debug
// log, and the exit status stays 0. The usage error returns 2 from inside
// the `try` block, on purpose. A failure in an `await import`, or in
// `createOutput`, is outside the `try` block and exits non-zero. Neither
// writes to stdout, and `hooks.json`'s `; exit 0` absorbs both statuses.
//
// **A read that hangs cannot hold this process (#267).** The command
// answers by its deadline, but a hung read still holds a worker thread,
// and node waits for that thread on every exit path. So once the output
// has left, `endOnceWritten` ends a process that a read still holds, with
// `SIGKILL`. `hooks.json`'s `; exit 0` makes that exit 0 too.
//
// **Below the floor, this writes one line and exits 0 (#245).** A
// `SessionStart` hook runs once, not on every tool call. So it may say so,
// where a per-tool-call hook must stay silent. `belowFloorMessage` builds
// the line. This file writes the `systemMessage` JSON itself, with no
// colour and no further import. So the write does not depend on a module
// graph that the runtime below the floor might not load.
import { belowFloorMessage, meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { createGhClient } = await import('../src/lib/gh.ts')
  const { endOnceWritten } = await import('../src/lib/process.ts')
  const { nodeFileReads } = await import('../src/lib/dependencies.ts')
  const { DEADLINE_MS, END_GRACE_MS, runHookIo } = await import('../src/subcommands/hook-io.ts')

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
      files: nodeFileReads,
      deadlineMs: DEADLINE_MS,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
  endOnceWritten(
    [process.stdout, process.stderr],
    END_GRACE_MS,
    () => process.kill(process.pid, 'SIGKILL'),
    () => process.getActiveResourcesInfo(),
  )
} else {
  // A closed reader makes this write fail asynchronously, as an `error`
  // event, the same failure `lib/streams.ts` guards on every other write
  // in this plugin. This branch cannot import `createOutput`: it must
  // stay inside the one-static-import contract above. So the guard is
  // inline instead, with no import, and it keeps the same rule: only
  // EPIPE is swallowed, and anything else still surfaces.
  process.stdout.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error
  })
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `\ngh: ⚠️ ${belowFloorMessage(process.version)}` })}\n`,
  )
  process.exitCode = 0
}
