// The gh plugin's SessionStart hook entry point: `hooks.json` runs this file
// directly, the way it ran `hook-io.py` before #127.
//
// This file ships and holds no decisions. `src/commands/hook-io.ts` is the
// hook, reached with the process's own edges as arguments, which is the seam
// the tests call without a process (ADR 001, RFC 001 decision 3).
//
// **One static import, and it is the floor guard.** `import` declarations are
// hoisted and evaluated before any statement here runs, so a second static
// import would load its whole module graph on the runtime this guard exists
// to refuse. `meetsNodeFloor` and not `assertNodeFloor`: a hook that writes
// to stderr writes into the session, so under the floor this exits 0 in
// silence rather than explaining itself (RFC 001 "Hooks", ADR 001). The other
// half of that guarantee is `hooks.json`'s `command -v node ... ; exit 0`,
// for a machine with no node at all and for a hooks directory this file was
// never installed into.
//
// **Nothing that happens in here may be the reason a session stops.**
// Anything unforeseen inside the `try` below leaves its account on stderr,
// where Claude Code's debug log keeps it, and the status is 0 all the same.
// Two statuses are not 0, and `hooks.json`'s `; exit 0` absorbs both.
// The first is the usage error, which is a deliberate `return 2` from inside
// the try rather than anything escaping it: a typo in the wiring is worth a
// diagnostic. The second is a failure in the four `await import`s or in
// `createOutput`, which are the only statements outside the try; there it is
// an unhandled top-level rejection and a non-zero status from node itself.
// Neither writes a byte to stdout, so the session is unaffected either way.
// The imports are left outside because bringing them in needs a fallback
// writer for the case where `createOutput` is what failed, and that arm
// cannot be reached by a test.
import { meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const path = await import('node:path')
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { run } = await import('../src/lib/process.ts')
  const { runHookIo } = await import('../src/commands/hook-io.ts')

  // Both streams are guarded here rather than at each write: a reader that
  // closed the pipe makes the write fail asynchronously, as an `error` event,
  // so there is nothing to wrap in a `try`, and with no listener node crashes
  // with an internals stack trace. The writer goes quiet on a broken pipe and
  // on nothing else (`lib/streams.ts`), which is what `silence_output` did.
  const output = createOutput(process.stdout, process.stderr)

  // Derived once, here, and passed in: the hook sits one level across from
  // `bin/`, the way it sat one level across from `scripts/` in Python.
  const entry = path.join(import.meta.dirname, '..', 'bin', 'gh.ts')

  try {
    process.exitCode = await runHookIo(process.argv.slice(2), {
      cwd: () => process.cwd(),
      env: process.env,
      stdin: () => readStdinText(process.stdin),
      output,
      run,
      nodePath: process.execPath,
      entry,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
}
