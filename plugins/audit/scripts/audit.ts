// The one entry point for the `audit` plugin's commands. The floor check
// runs first. It is the only static import in this file. JavaScript hoists
// `import` declarations and evaluates them before any statement here runs.
// A second static import would load its whole module graph on the runtime
// this guard exists to refuse. See `lib/README.md` and `lib/node-floor.ts`.
//
// This file reaches everything else by `await import`, after the check
// passes.
//
// This file ships. It holds no decisions. `src/subcommands/context.ts` is the
// seam a test reaches without a process. This adapter only turns
// `process.argv` and this process's streams into that function's arguments.
// It turns the function's answer into an exit code. `src/bin.test.ts`,
// through `harness/spawn.ts`, is the one spawned test.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { createJevClient } = await import('../src/lib/jev.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: audit.ts <command> [options]

commands:
  context [root] [options]   the references in a checkout's context files
                             that no longer resolve

audit.ts <command> --help prints that command's own usage.`

// Both streams are guarded here, rather than at each write. A reader can
// close the pipe, for example with `audit.ts context | head`. This makes
// the write fail asynchronously, as an `error` event, so there is nothing
// to wrap in a `try`. Without a listener, node crashes with an internals
// stack trace. The writer stays silent only for a broken pipe, never for
// another error (`lib/streams.ts`).
const output = createOutput(process.stdout, process.stderr)

/** What a command that answers with an envelope writes, and its status. The
 *  renderer adds no trailing newline. This lets the entry point decide it.
 *  A report the command already wrote through `output` leaves an empty
 *  string here. It adds nothing more. */
const write = (envelope: Parameters<typeof renderText>[0]): number => {
  const rendered = renderText(envelope)
  if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/** The process's edges, as the command function takes them. `gh` resolves
 *  the repository from its working directory. So the client is built with
 *  the audited root. `performance.now()` is node's monotonic clock. A
 *  duration should use that clock.
 *
 *  The Jev client is a factory, not a client. Whether there is a key to
 *  spend is the command's decision. This adapter holds no key itself. */
const edges = {
  cwd: process.cwd(),
  env: process.env,
  output,
  createGh: (cwd: string) => createGhClient({ cwd, env: process.env }),
  createJev: (options: { apiKey: string }) => createJevClient(options),
  now: () => performance.now(),
}

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'context') {
    const { runContext } = await import('../src/subcommands/context.ts')
    return write(await runContext(argv, edges))
  }
  return null
}

const [name = '', ...rest] = process.argv.slice(2)

// This check runs before anything loads, and answers with a status of 0. A
// caller that asks what this tool can do has not made a mistake. An unknown
// command is different: it is exit 2, with the same list on stderr.
const wantsUsage = name === '' || name === '-h' || name === '--help'
// The spike this ports ended the same way. A command answers with an
// envelope for everything it decides. So anything that reaches here is a
// defect, not a refusal. Without this guard, node writes its own internals
// stack trace to stderr. It would also give an exit code the envelope
// contract never chose. Exit 1 is what `lib/envelope.ts` calls `failed`:
// this code went wrong.
const status = wantsUsage
  ? write(ok(USAGE))
  : await run(name, rest).catch((error: unknown) => {
      output.err.write(`audit: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    })
process.exitCode = status === null ? write(refused(`unknown command: ${name}\n\n${USAGE}`)) : status
