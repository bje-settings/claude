// The one entry point for the `audit` plugin's commands. The floor check is
// first, and it is the only static import: `import` declarations are hoisted
// and evaluated before any statement here runs, so a second static import
// would load its whole module graph on the runtime this guard exists to refuse
// (`lib/README.md`, `lib/node-floor.ts`). Everything else is reached by
// `await import` after the check has passed.
//
// This file ships. It holds no decisions: `src/commands/context.ts` is the
// seam a test reaches without a process, and this adapter only turns
// `process.argv` and this process's streams into that function's arguments,
// and its answer into an exit code. `src/bin.test.ts`, through
// `harness/spawn.ts`, is the one spawned test.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: audit.ts <command> [options]

commands:
  context [root] [options]   the references in a checkout's context files
                             that no longer resolve

audit.ts <command> --help prints that command's own usage.`

// Both streams are guarded here rather than at each write: a reader that
// closed the pipe (`audit.ts context | head`) makes the write fail
// asynchronously, as an `error` event, so there is nothing to wrap in a `try`,
// and with no listener node crashes with an internals stack trace. The writer
// goes quiet on a broken pipe and on nothing else (`lib/streams.ts`).
const output = createOutput(process.stdout, process.stderr)

/** What a command that answers with an envelope writes, and its status. The
 *  renderer adds no trailing newline, so that the entry point decides it; a
 *  report the command already wrote through `output` leaves an empty string
 *  here and adds nothing. */
const write = (envelope: Parameters<typeof renderText>[0]): number => {
  const rendered = renderText(envelope)
  if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/** The process's edges, as the command function takes them. `gh` resolves the
 *  repository from its working directory, so the client is built with the
 *  audited root; `performance.now()` is node's monotonic clock, which is what
 *  a duration should be measured on. */
const edges = {
  cwd: process.cwd(),
  env: process.env,
  output,
  createGh: (cwd: string) => createGhClient({ cwd, env: process.env }),
  now: () => performance.now(),
}

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'context') {
    const { runContext } = await import('../src/commands/context.ts')
    return write(await runContext(argv, edges))
  }
  return null
}

const [name = '', ...rest] = process.argv.slice(2)

// Asked before anything is loaded, and answered with a status of 0: a caller
// asking what this can do has not made a mistake. An unknown command has, and
// is exit 2 with the same list on stderr.
const wantsUsage = name === '' || name === '-h' || name === '--help'
const status = wantsUsage ? write(ok(USAGE)) : await run(name, rest)
process.exitCode = status === null ? write(refused(`unknown command: ${name}\n\n${USAGE}`)) : status
