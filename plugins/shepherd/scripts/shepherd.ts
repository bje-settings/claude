// This file is the one entry point for the `shepherd` plugin's commands.
// The floor check comes first. It is the only static import. Node hoists
// and evaluates `import` declarations before any statement here runs. A
// second static import would load its whole module graph on the runtime
// that this guard must refuse (`lib/README.md`, `lib/node-floor.ts`). This
// file reaches everything else by `await import`, after the check passes.
//
// This file ships. It holds no decisions. Each command function under
// `src/subcommands/` is the seam a test reaches without a process. This
// adapter only turns `process.argv` and this process's streams into that
// function's arguments. It turns the function's answer into an exit code.
// `tests/plugins/shepherd/bin.test.ts`, through `harness/spawn.ts`, is the
// one spawned test. It covers the paths that need no `gh` at all.
//
// **The dispatch is `run` below and nothing else.** The import inside each
// arm is dynamic. A command nobody asked for is never loaded. A new
// command changes no other line in this file. The `/shepherd:merge`
// skill's first step resolves its scope with `discover`: it reads one path
// per line. Its two refusals are exit 1, in the contract that the Python
// capture `python-cli-output.json` holds.
//
// The hook is not here. `hooks/session-start.ts` is its own entry point.
//
// The three shepherd commands answer with an exit status, not an envelope.
// They have a fourth status (3, an internal error) that `lib/envelope.ts`
// deliberately does not know. They write their own JSON document through
// the writers handed to them. `discover` answers with a status for its own
// reason, given in its own file. This is why `run` answers with a number.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { failedOnThrow, ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: shepherd.ts <command> [options]

commands:
  discover [path]                                 the checkout roots in scope
                                                  for a directory, one per line
  shepherd-status [path] [label]                  what /shepherd:merge would
                                                  work on in one repository
  shepherd-pr <path> <number> <action>            one deterministic step
                                                  against one pull request
  shepherd-stack <path> <stack> <action>          one deterministic step
                                                  against one GitHub stack

shepherd.ts <command> --help prints that command's own usage.`

// This code guards both streams here, not at each write. A reader that
// closes the pipe (`shepherd.ts --help | head`) makes the write fail later,
// as an `error` event. There is nothing to wrap in a `try` block for that
// failure. With no listener, node crashes and prints an internals stack
// trace. The writer stays quiet on a broken pipe, and on nothing else: it
// re-throws an ENOSPC or an EIO (`lib/streams.ts`). This code guards stdout
// and stderr independently. A lost reader on one stream does not block the
// channel that a real failure must still reach.
const output = createOutput(process.stdout, process.stderr)

/** What an envelope writes, and its status. The usage and the refusal of
 *  an unknown command are the two envelopes here. The renderer adds no
 *  trailing newline. The entry point decides that instead. */
const write = (envelope: Parameters<typeof renderText>[0]): number => {
  const rendered = renderText(envelope)
  if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/** The process's edges, as the command functions take them. */
const edges = { cwd: process.cwd(), env: process.env, output }

// The shepherd commands name the repository with `--repo` on every call
// except the one that resolves it, so their client takes both forms. They
// also poll, so the clock and the sleep function are arguments, not
// imports. These are the real ones, built here with every other edge of
// the process. `performance` is node's monotonic clock, the same role
// `time.monotonic()` had. `Date` is the wall clock, which `wait` compares
// with GitHub's check stamps (#466). The timer is the one `time.sleep` used.
const shepherdEdges = {
  createGh: (target: { cwd?: string; repository?: string }) =>
    createGhClient({ ...target, env: process.env }),
  now: () => performance.now(),
  clock: () => Date.now(),
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
}

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'discover') {
    const { runDiscover } = await import('../src/subcommands/discover.ts')
    return runDiscover(argv, edges)
  }
  if (name === 'shepherd-status') {
    const { runShepherdStatus } = await import('../src/subcommands/shepherd-status.ts')
    return runShepherdStatus(argv, { ...edges, ...shepherdEdges })
  }
  if (name === 'shepherd-pr') {
    const { runShepherdPr } = await import('../src/subcommands/shepherd-pr.ts')
    return runShepherdPr(argv, { ...edges, ...shepherdEdges })
  }
  if (name === 'shepherd-stack') {
    const { runShepherdStack } = await import('../src/subcommands/shepherd-stack.ts')
    return runShepherdStack(argv, { ...edges, ...shepherdEdges })
  }
  return null
}

const [name = '', ...rest] = process.argv.slice(2)

// A caller can ask this before anything loads. The answer is status 0.
// To ask what this command can do is not a mistake. An unknown command is
// a mistake. It gets exit 2, with the same list on stderr.
const wantsUsage = name === '' || name === '-h' || name === '--help'
// #218 finding 7: a command that throws gets one stderr line and exit 1,
// not node's own stack trace. `lib/envelope.ts` `failedOnThrow` holds the
// rule and its tests.
const status = wantsUsage
  ? write(ok(USAGE))
  : await failedOnThrow(run(name, rest), 'shepherd', output.err)
process.exitCode = status === null ? write(refused(`unknown command: ${name}\n\n${USAGE}`)) : status
