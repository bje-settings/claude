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
// **Two tools find a process's own directory.** `pgrep -f` names the
// processes; the pattern is below. Pid N's own cwd needs `/proc/N/cwd`.
// Linux has that; macOS does not. The fallback, `lsof -a -d cwd -p N`,
// is on both, and it is the slower call.
//
// So this tries `/proc` first for each pid, and asks `lsof` only when
// that read fails. It asks once, for all those pids together: parallel
// `lsof` calls slow each other past the deadline. When a tool is absent, this reads that the same way
// as an absent git. That is one line on stderr, and an allow from
// `decide` (`src/subcommands/guard.ts`). A pid whose cwd neither tool
// answers gets its own line too, so it never disappears from the check
// without a trace, the way every other degraded read here explains
// itself.
//
// **Both cwd paths are resolved with `realpath` before the compare.** On
// macOS `/tmp` and `/var` are links, and a process cwd is the resolved
// form. So this resolves the payload `cwd` (`resolvePayloadCwd`) and each
// process cwd (`readCwds`), and `decide` still compares plain strings. A
// path that `realpath` cannot resolve keeps its own string.
//
// **`pgrep`'s own pattern is narrower than a plain `vitest`.** A plain
// substring match answers a process whose command line merely contains
// the word: measured against a real background process, `cat
// vitest.config.ts` matched `pgrep -f vitest`, and would have been read
// as a running suite. The pattern here, `(^|/)vitest([ /]|$)`, answers
// `vitest` only as a whole path segment, ended by a space, another `/`,
// or the end of the line, so `vitest.config.ts` still fails to match: a
// dot follows, and a dot is none of the three.
//
// The end must allow another `/`, not only a space. This repository's
// own `node_modules/.bin/vitest` shim execs `node .../vitest/vitest.mjs`,
// so the real running process this hook has to find names `vitest`
// twice, both times followed by a `/` or a `.`, never by a space.
// Measured against that real process, a pattern ending only in a space
// or the line's end answered nothing at all, and a false negative here
// is the whole feature silently doing nothing.
import { meetsNodeFloor } from '../src/lib/node-floor.ts'

if (meetsNodeFloor(process.version)) {
  const { readlink, realpath } = await import('node:fs/promises')
  const { createOutput, readStdinText } = await import('../src/lib/streams.ts')
  const { gitOut } = await import('../src/lib/git.ts')
  const { run } = await import('../src/lib/process.ts')
  const { resolvedOrSame, resolvePayloadCwd, runGuard } = await import(
    '../src/subcommands/guard.ts'
  )

  // Both streams are guarded here, rather than at each write. A reader that
  // closed the pipe makes the write fail asynchronously, as an `error`
  // event. There is nothing to wrap in a `try`, and with no listener node
  // crashes with an internals stack trace (`lib/streams.ts`).
  const output = createOutput(process.stdout, process.stderr)

  /** `pgrep -f`'s own pattern. `vitest` as a whole path segment, ended by
   *  a space, another `/`, or the end of the command line: see the
   *  header for the measurement that picked this over a plain
   *  substring, and for the real invocation shape that ruled out ending
   *  the pattern in a space alone. */
  const VITEST_PROCESS_PATTERN = '(^|/)vitest([ /]|$)'

  /** Each pid's cwd from `/proc`, resolved. A pid that `/proc` cannot
   *  answer is left out of the map. */
  const readProcCwds = async (pids: readonly number[]): Promise<Map<number, string>> => {
    const found = new Map<number, string>()
    await Promise.all(
      pids.map(async (pid) => {
        try {
          found.set(pid, await resolvedOrSame(await readlink(`/proc/${pid}/cwd`), realpath))
        } catch {
          // No /proc at all (macOS), or no permission to read another
          // user's link. `lsof` is the fallback the header names.
        }
      }),
    )
    return found
  }

  /** Each pid's cwd from ONE `lsof` call, resolved. Parallel `lsof` calls
   *  slow each other. On macOS, four parallel calls each took 3.7 seconds,
   *  past the 3 second deadline. One call for all pids takes the time of
   *  one. `lsof` exits 1 when a pid is gone, and still lists the others.
   *  So this reads the output whatever the status. A pid that the output
   *  does not name is left out of the map. */
  const readLsofCwds = async (pids: readonly number[]): Promise<Map<number, string>> => {
    const found = new Map<number, string>()
    if (pids.length === 0) return found
    const listed = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], {
      timeoutMs: 3_000,
    })
    let pid: number | null = null
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n') && pid !== null && !found.has(pid)) {
        found.set(pid, await resolvedOrSame(line.slice(1), realpath))
      }
    }
    return found
  }

  /** Each pid's own cwd, or `null` for a pid that neither tool answered.
   *  Writes one stderr line for each such pid, so a pid this cannot place
   *  never drops out of the check in silence. */
  const readCwds = async (pids: readonly number[]): Promise<Map<number, string | null>> => {
    const cwds = new Map<number, string | null>(await readProcCwds(pids))
    const unread = pids.filter((pid) => !cwds.has(pid))
    const fromLsof = await readLsofCwds(unread)
    for (const pid of unread) {
      const named = fromLsof.get(pid)
      if (named === undefined) {
        output.err.write(
          `workstreams guard: pid ${pid}'s cwd could not be read (neither /proc nor lsof ` +
            'answered); it will not be checked for a second vitest run.\n',
        )
      }
      cwds.set(pid, named ?? null)
    }
    return cwds
  }

  /** Every `vitest` process on the machine, or `null` when `pgrep` could
   *  not be asked at all. Status 1 from `pgrep` means "no match", which
   *  answers an empty list, not `null`. No type import names this a
   *  `ProcessReader` (`src/subcommands/guard.ts`); its shape alone does. */
  const readRunningVitest = async () => {
    const listed = await run('pgrep', ['-f', VITEST_PROCESS_PATTERN], { timeoutMs: 3_000 })
    if (listed.startFailure !== null || listed.timedOut) return null
    if (listed.status === 1) return []
    if (listed.status !== 0) return null

    const pids = listed.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    const cwds = await readCwds(pids)
    return pids.map((pid) => ({ pid, cwd: cwds.get(pid) ?? null }))
  }

  try {
    process.exitCode = await runGuard({
      stdin: async () => resolvePayloadCwd(await readStdinText(process.stdin), realpath),
      git: gitOut,
      processes: readRunningVitest,
      output,
    })
  } catch (error) {
    output.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 0
  }
}
