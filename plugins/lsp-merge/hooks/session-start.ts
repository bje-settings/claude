// The entry point for the lsp-merge plugin's `SessionStart` hook.
// `hooks.json` runs it directly. It holds no decisions:
// `src/subcommands/session-start.ts` is the hook, and it takes the
// process's own edges as arguments. This file follows
// `plugins/workstreams/hooks/session-start.ts`.
//
// One static import, and it is the floor guard. Below the floor, this writes
// one `systemMessage` line and exits 0. Nothing here may stop a session: an
// unexpected error goes to stderr, which Claude Code keeps in its debug log,
// and the status stays 0.
import { belowFloorMessage, meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { readFileSync } = await import('node:fs')
  const { createOutput } = await import('../src/lib/streams.ts')
  const { run } = await import('../src/lib/process.ts')
  const { DEADLINE_MS, runSessionStart } = await import('../src/subcommands/session-start.ts')

  const output = createOutput(process.stdout, process.stderr)

  try {
    process.exitCode = await runSessionStart({
      env: process.env,
      output,
      run,
      deadlineMs: DEADLINE_MS,
      cwd: process.cwd(),
      readFile: (file) => readFileSync(file, 'utf8'),
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
} else {
  // This branch stays inside the one-static-import rule, so its EPIPE guard
  // is inline: it swallows EPIPE only.
  process.stdout.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error
  })
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `\nlsp-merge: ⚠️ ${belowFloorMessage(process.version)}` })}\n`,
  )
  process.exitCode = 0
}
