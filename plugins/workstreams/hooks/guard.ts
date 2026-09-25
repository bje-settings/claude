// The workstreams guard's entry point. `hooks.json` runs this file
// directly on every shell tool call, in the main conversation and inside
// every subagent.
//
// This file ships, and holds no decisions. `src/subcommands/guard.ts` is the
// guard. It is reached with this process's own edges as arguments, which is
// the seam the tests call without a process (ADR 001, RFC 001 decision 3).
//
// **One static import, and it is the floor guard.** `import` declarations
// are hoisted and evaluated before any statement here runs. So a second
// static import would load its whole module graph on the runtime this
// guard exists to refuse. This file uses `meetsNodeFloor`, not
// `assertNodeFloor`: a hook that writes to stderr writes into the session,
// so under the floor this exits 0 in silence, rather than explain itself
// (RFC 001 "Hooks", ADR 001, `plugins/gh/hooks/hook-io.ts`). The other half
// of that guarantee is `hooks.json`'s `command -v node ... ; exit 0`, for a
// machine with no node at all, and for a hooks directory this file was
// never installed into.
//
// **Nothing in here may deny a tool call by accident.** A denial is a JSON
// document on stdout, and nothing else writes there. So any failure leaves
// stdout empty, and the tool call proceeds. Anything unforeseen inside the
// `try` leaves its account on stderr, where Claude Code's debug log keeps
// it, and the status is 0 all the same. The only statements outside the try
// are the three `await import`s and `createOutput`. A failure there is an
// unhandled top-level rejection and a non-zero status from node itself.
// `hooks.json`'s `; exit 0` absorbs that, and stdout stays empty.
//
// **It reads stdin inside the guard.** A `PreToolUse` payload arrives on
// stdin (hooks.md, "Hook input and output"). Reading it is a promise that
// can reject like any other, so the code calls it from inside the try,
// rather than await it on the way in.
import { meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { gitOut } = await import('../src/lib/git.ts')
  const { runGuard } = await import('../src/subcommands/guard.ts')

  // Both streams are guarded here, rather than at each write. A reader that
  // closed the pipe makes the write fail asynchronously, as an `error`
  // event. There is nothing to wrap in a `try`, and with no listener node
  // crashes with an internals stack trace (`lib/streams.ts`).
  const output = createOutput(process.stdout, process.stderr)

  try {
    process.exitCode = await runGuard({
      stdin: () => readStdinText(process.stdin),
      git: gitOut,
      output,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
}
