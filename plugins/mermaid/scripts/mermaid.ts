// The one entry point for `/mermaid:view`. The floor check is first, and it
// is the only static import: `import` declarations are hoisted and
// evaluated before any statement here runs, so a second static import would
// load its whole module graph on the runtime this guard exists to refuse
// (lib/README.md, lib/node-floor.ts). Everything else is reached by `await
// import` after the check has passed.
//
// This file ships. It holds no decisions: `src/commands/url.ts` is the seam a test
// reaches without a process, and this adapter only turns `process.argv` and
// stdin into its arguments, and its envelope into an exit code and a
// stream, the way its own spawned contract test, `src/bin.test.ts`, exercises
// it (`harness/spawn.ts` is only the runner that test uses).

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { readFileSync } = await import('node:fs')
const { renderText } = await import('../src/lib/envelope.ts')
const { runMermaidUrl, wantsHelp } = await import('../src/commands/url.ts')

// A reader that closes stdout or stderr early (`| head`, `2>&1 | head`, a
// tool call that abandons its child) makes the write below fail with EPIPE.
// With no listener, node treats an 'error' event on a stream as uncaught and
// crashes with a full internals stack trace naming this file, which is
// wiring the adapter is already responsible for, not a decision: the
// diagram (or the refusal) was already built and there is nothing left to
// refuse or report, so this exits quietly rather than letting a broken
// downstream reader surface as a crash in whatever session transcript runs
// this. Registering a listener at all silences node's default crash for
// EVERY error code on that stream, not only EPIPE, so a genuine `ENOSPC` or
// `EIO` is re-thrown rather than swallowed: this guard is deliberately
// narrow to the one error it exists to answer.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0)
    throw err
  })
}

const argv = process.argv.slice(2)

// `--help`/`-h` answers without a diagram, so this must not block on
// descriptor 0 waiting for one: a session asking for `--help` with nothing
// piped in and no heredoc would otherwise hang here forever. `wantsHelp` is
// `url.ts`'s own predicate, the same one `runMermaidUrl` checks first, so
// this only decides whether reading stdin is still necessary, not what help
// means; the empty bytes below are never looked at, since `runMermaidUrl`
// reaches the same check before touching them.
//
// Otherwise, descriptor 0 is read whole and synchronously: the diagram
// source is never streamed, since it has to be complete before it can be
// compressed, and every other seam in this plugin is synchronous too. No
// encoding is given, so this is the raw bytes `runMermaidUrl` decodes
// itself; decoding here would turn an invalid byte into a thrown exception
// this adapter would then have to catch, which is a decision `url.ts`
// already owns.
const stdinBytes = wantsHelp(argv) ? new Uint8Array(0) : readFileSync(0)

const rendered = renderText(runMermaidUrl(argv, stdinBytes))
if (rendered.stdout !== '') process.stdout.write(`${rendered.stdout}\n`)
if (rendered.stderr !== '') process.stderr.write(`${rendered.stderr}\n`)
process.exitCode = rendered.exitCode
