// The one entry point for the lsp-merge plugin. `.lsp.json` runs
// `lsp-merge.ts serve <project-dir>`, and Claude Code speaks LSP to it on
// stdio.
//
// The floor check runs first. It is the only static import in this file,
// because node evaluates every `import` declaration before any statement
// runs (`.claude/rules/type-ts.md`). This file reaches everything else by
// `await import`, after the check passes.
//
// This file holds no decisions. `src/subcommands/serve.ts` is the seam a
// test reaches without a process. Unlike the other dispatchers here, the
// `serve` arm writes no envelope: stdout is the LSP channel, so only LSP
// messages go to it. Each problem goes to stderr.
import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

// Claude Code closes the pipe when it stops the server. A later write then
// fails with EPIPE, and with no listener node crashes with a stack trace.
// There is nothing left to say to a reader that has gone, so this exits
// quietly. Every other error code still surfaces.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
}

const [command, ...rest] = process.argv.slice(2)

if (command === 'serve') {
  const { EXIT_GRACE_MS, runServe } = await import('../src/subcommands/serve.ts')
  process.exitCode = await runServe(rest, {
    input: process.stdin,
    output: process.stdout,
    err: process.stderr,
    env: process.env,
    exitGraceMs: EXIT_GRACE_MS,
  })
  // stdin stays open after the proxy stops, and keeps node alive.
  process.stdin.destroy()
} else {
  const { USAGE } = await import('../src/subcommands/serve.ts')
  process.stderr.write(USAGE)
  process.exitCode = 2
}
