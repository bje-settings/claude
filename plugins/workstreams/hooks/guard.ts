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
// it, and the status is 0 all the same.
//
// The statements outside the try are the `await import`s and
// `createOutput`. Two reader functions are outside it too; `runGuard`
// calls them only once it is inside the try. A failure among the
// imports or `createOutput` is an unhandled top-level rejection and a
// non-zero status from node itself. `hooks.json`'s `; exit 0` absorbs
// that, and stdout stays empty.
//
// **It reads stdin inside the guard.** A `PreToolUse` payload arrives on
// stdin (hooks.md, "Hook input and output"). Reading it is a promise that
// can reject like any other, so the code calls it from inside the try,
// rather than await it on the way in.
//
// **Two tools find a process's own directory.** `pgrep -f vitest` names
// the processes. Pid N's own cwd needs `/proc/N/cwd`. Linux has that;
// macOS does not. The fallback, `lsof -a -d cwd -p N`, is on both, and
// it is the slower call.
//
// So this tries `/proc` first for each pid, and asks `lsof` only when
// that read fails. When a tool is absent, this reads that the same way
// as an absent git. That is one line on stderr, and an allow from
// `decide` (`src/subcommands/guard.ts`).
import { meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { readlink } = await import('node:fs/promises')
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { gitOut } = await import('../src/lib/git.ts')
  const { run } = await import('../src/lib/process.ts')
  const { runGuard } = await import('../src/subcommands/guard.ts')

  // Both streams are guarded here, rather than at each write. A reader that
  // closed the pipe makes the write fail asynchronously, as an `error`
  // event. There is nothing to wrap in a `try`, and with no listener node
  // crashes with an internals stack trace (`lib/streams.ts`).
  const output = createOutput(process.stdout, process.stderr)

  /** pid's own cwd, or `null` when neither tool answered. */
  const readCwd = async (pid: number): Promise<string | null> => {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch {
      // No /proc at all (macOS), or no permission to read another
      // user's link. Either way, lsof is the fallback the header names.
    }
    const listed = await run('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      timeoutMs: 3_000,
    })
    if (listed.status !== 0) return null
    const named = listed.stdout.split('\n').find((line) => line.startsWith('n'))
    return named === undefined ? null : named.slice(1)
  }

  /** Every `vitest` process on the machine, or `null` when `pgrep` could
   *  not be asked at all. Status 1 from `pgrep` means "no match", which
   *  answers an empty list, not `null`. No type import names this a
   *  `ProcessReader` (`src/subcommands/guard.ts`); its shape alone does. */
  const readRunningVitest = async () => {
    const listed = await run('pgrep', ['-f', 'vitest'], { timeoutMs: 3_000 })
    if (listed.startFailure !== null || listed.timedOut) return null
    if (listed.status === 1) return []
    if (listed.status !== 0) return null

    const pids = listed.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return Promise.all(pids.map(async (pid) => ({ pid, cwd: await readCwd(pid) })))
  }

  try {
    process.exitCode = await runGuard({
      stdin: () => readStdinText(process.stdin),
      git: gitOut,
      processes: readRunningVitest,
      output,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
}
