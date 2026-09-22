// The one entry point for the `workstreams` plugin's commands. The floor
// check is first, and it is the only static import: `import` declarations are
// hoisted and evaluated before any statement here runs, so a second static
// import would load its whole module graph on the runtime this guard exists
// to refuse (`lib/README.md`, `lib/node-floor.ts`). Everything else is
// reached by `await import` after the check has passed.
//
// This file ships. It holds no decisions: each command function under
// `src/commands/` is the seam a test reaches without a process, and this
// adapter only turns `process.argv` and this process's streams into that
// function's arguments, and its answer into an exit code. `src/bin.test.ts`,
// through `harness/spawn.ts`, is the one spawned test, on the paths that need
// no `gh` at all.
//
// **One dispatcher, not one `bin` per command.** RFC 001 "Shape" writes
// `bin/<command>.ts`; `plugins/gh/bin/gh.ts` and
// `plugins/mermaid/bin/mermaid.ts` both settled on one dispatcher instead,
// and round 8 ruling 6 amended the RFC in place rather than the other way
// round. The argument is one floor guard and one spawned contract test for
// the whole plugin. The import inside each arm is dynamic, so a command
// nobody asked for is never loaded, and a new one changes no other line here.
//
// The arms answer differently on purpose: `sweep` and `pr-state` answer with
// an envelope, because each one's whole output is one payload a caller either
// gets or does not, and `preflight` answers with a status and writes its own
// report, because its findings belong on stdout even when the answer is 1 and
// `lib/envelope.ts` deliberately writes nothing to stdout for a failure.
import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')
// Named for what it is here, because `run` below is the dispatcher.
const { run: runChild } = await import('../src/lib/process.ts')

const USAGE = `usage: workstreams.ts <command> [options]

commands:
  sweep [--milestone 4,5] [--json]   what a round could start on: milestones,
                                     open pull requests, the unblocked set,
                                     the next tier, and what is further out
  pr-state <number> [--round 0|1|2]  where the review loop is on one pull
    [--substantial] [--rot-checked]  request: its required contexts, its
    [--json]                         checks, its unresolved threads and the
                                     state they add up to
  preflight [--json]                 what the workstreams skills depend on,
                                     and what of it is missing

workstreams.ts <command> --help prints that command's own usage.`

// Both streams are guarded here rather than at each write: a reader that
// closed the pipe (`workstreams.ts sweep | head`) makes the write fail
// asynchronously, as an `error` event, so there is nothing to wrap in a
// `try`, and with no listener node crashes with an internals stack trace. The
// writer goes quiet on a broken pipe and on nothing else: an ENOSPC or an EIO
// is re-thrown (`lib/streams.ts`). stdout and stderr are guarded
// independently, so a lost reader does not take the channel a real failure
// still has to reach.
const output = createOutput(process.stdout, process.stderr)

/** What a command that answers with an envelope writes, and its status. The
 *  renderer adds no trailing newline, so that the entry point decides it. */
const write = (envelope: Parameters<typeof renderText>[0]): number => {
  const rendered = renderText(envelope)
  if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'sweep') {
    const { runSweep } = await import('../src/commands/sweep.ts')
    // One client for the repository the caller is standing in, which is what
    // `gh` resolves from its working directory.
    return write(
      await runSweep(argv, { gh: createGhClient({ cwd: process.cwd(), env: process.env }) }),
    )
  }
  if (name === 'pr-state') {
    const { runPrState } = await import('../src/commands/pr-state.ts')
    return write(
      await runPrState(argv, { gh: createGhClient({ cwd: process.cwd(), env: process.env }) }),
    )
  }
  if (name === 'preflight') {
    const { runPreflight } = await import('../src/commands/preflight.ts')
    return runPreflight(argv, { env: process.env, output, run: runChild })
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
