// The one entry point for `/mermaid:view`. The floor check runs first. It
// is the only static import in this file. JavaScript hoists `import`
// declarations and evaluates them before any statement here runs. A second
// static import would load its whole module graph on the runtime this
// guard exists to refuse. See `lib/README.md` and `lib/node-floor.ts`.
//
// This file reaches everything else by `await import`, after the check
// passes.
//
// This file ships. It holds no decisions. `src/subcommands/url.ts` is the
// seam a test reaches without a process. This adapter only turns
// `process.argv` and stdin into its arguments. It turns its envelope into
// an exit code and a stream.
//
// Its own spawned contract test, `src/bin.test.ts`, exercises it this way.
// `harness/spawn.ts` is only the runner that test uses.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { readFileSync } = await import('node:fs')
const { renderText } = await import('../src/lib/envelope.ts')
const { runMermaidUrl, wantsHelp } = await import('../src/subcommands/url.ts')

// A reader can close stdout or stderr early. Examples are `| head`,
// `2>&1 | head`, or a tool call that abandons its child. This makes the
// write below fail with EPIPE. With no listener, node treats an 'error'
// event on a stream as uncaught. It crashes with a full internals stack
// trace that names this file.
//
// But that is only wiring the adapter already owns, not a decision. The
// diagram, or the refusal, was already built. There is nothing left to
// refuse or report. So this exits quietly. It does not let a broken
// downstream reader surface as a crash in whatever session transcript runs
// this.
//
// A listener silences node's default crash for EVERY error code on that
// stream, not only EPIPE. So the code re-throws a genuine `ENOSPC` or
// `EIO` instead. It never swallows those errors. This guard is
// deliberately narrow to the one error it exists to answer.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0)
    throw err
  })
}

const argv = process.argv.slice(2)

// `--help`/`-h` answers without a diagram. So this must not block on
// descriptor 0 to wait for one. A session that asks for `--help`, with
// nothing piped in and no heredoc, would otherwise hang here forever.
// `wantsHelp` is `url.ts`'s own predicate, the same one `runMermaidUrl`
// checks first. So this only decides whether it still needs to read
// stdin, not what help means. The empty bytes below are never used,
// because `runMermaidUrl` reaches the same check before it touches them.
//
// Otherwise, descriptor 0 is read whole and synchronously. The diagram
// source is never streamed. It must be complete before it can be
// compressed, and every other seam in this plugin is synchronous too. No
// encoding is given, so this is the raw bytes that `runMermaidUrl` decodes
// itself. If this decoded here, an invalid byte would become a thrown
// exception. This adapter would then have to catch it, but that decision
// already belongs to `url.ts`.
const stdinBytes = wantsHelp(argv) ? new Uint8Array(0) : readFileSync(0)

const rendered = renderText(runMermaidUrl(argv, stdinBytes))
if (rendered.stdout !== '') process.stdout.write(`${rendered.stdout}\n`)
if (rendered.stderr !== '') process.stderr.write(`${rendered.stderr}\n`)
process.exitCode = rendered.exitCode
