// This file is the entry point for the gh plugin's SessionStart hook.
// `hooks.json` runs this file directly, the way it ran `hook-io.py` before
// #127.
//
// This file ships and holds no decisions. `src/subcommands/hook-io.ts` is the
// hook. It takes the process's own edges as arguments. This is the seam the
// tests call without a process (ADR 001, RFC 001 decision 3).
//
// **One static import, and it is the floor guard.** Node hoists and
// evaluates `import` declarations before any statement here runs. A second
// static import would load its whole module graph on the runtime that this
// guard must refuse. This file calls `meetsNodeFloor`, not
// `assertNodeFloor`. A hook that writes to stderr writes into the session.
// Below the floor, this file exits with status 0 and stays silent. It does
// not explain itself (RFC 001 "Hooks", ADR 001). The other half of that
// guarantee is in `hooks.json`: `command -v node ... ; exit 0`. This covers
// two cases: a machine with no node at all, and a hooks directory where this
// file was never installed.
//
// **Nothing that happens in here may be the reason a session stops.**
// An unexpected error inside the `try` block below writes its record to
// stderr. Claude Code's debug log keeps that record. The exit status stays
// 0 regardless. Two statuses are not 0. `hooks.json`'s `; exit 0` absorbs
// both. The first is the usage error. It is a deliberate `return 2` from
// inside the `try` block, not an error that escapes it. A typo in the
// configuration deserves a clear diagnostic message. The second is a
// failure in one of the four `await import` statements, or in
// `createOutput`. These are the only statements outside the `try` block. A
// failure there is an unhandled top-level rejection, with a non-zero exit
// status from node itself. Neither writes a byte to stdout, so the session
// is unaffected either way. The imports stay outside the `try` block for a
// reason. If they moved inside, the code would need a fallback writer for
// the case where `createOutput` itself fails. No test can reach that code
// path.
import { meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const path = await import('node:path')
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { run } = await import('../src/lib/process.ts')
  const { runHookIo } = await import('../src/subcommands/hook-io.ts')

  // This code guards both streams here, not at each write. A reader that
  // closes the pipe makes the write fail later, as an `error` event. There
  // is nothing to wrap in a `try` block for that failure. With no listener,
  // node crashes and prints an internals stack trace. The writer stays
  // quiet on a broken pipe, and on nothing else (`lib/streams.ts`). This is
  // what `silence_output` did before.
  const output = createOutput(process.stdout, process.stderr)

  // This code computes the entry path once, here, and passes it in. The
  // hook sits one directory level across from `scripts/`, the way it did in
  // Python.
  const entry = path.join(import.meta.dirname, '..', 'scripts', 'gh.ts')

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
