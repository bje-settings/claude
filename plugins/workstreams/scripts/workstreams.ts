// The one entry point for the `workstreams` plugin's commands. The floor
// check runs first, and it is the only static import. `import` declarations
// are hoisted and evaluated before any statement here runs. So a second
// static import would load its whole module graph on the runtime this guard
// exists to refuse (`lib/README.md`, `lib/node-floor.ts`). Everything else is
// reached by `await import`, after the check has passed.
//
// This file ships. It holds no decisions. Each command function under
// `src/subcommands/` is the seam a test reaches without a process. This adapter
// only turns `process.argv` and this process's streams into that function's
// arguments, and its answer into an exit code. `tests/plugins/workstreams/bin.test.ts`, through
// `harness/spawn.ts`, is the one spawned test, on the paths that need no
// `gh` at all.
//
// **One dispatcher, not one entry point per command.** RFC 001 "Shape" wrote
// one adapter per command. `plugins/gh/scripts/gh.ts` and
// `plugins/mermaid/scripts/mermaid.ts` both settled on one dispatcher
// instead, and round 8 ruling 6 amended the RFC in place, rather than the
// other way round. The argument is one floor guard and one spawned contract
// test for the whole plugin. The import inside each arm is dynamic, so a
// command nobody asked for is never loaded. A new command changes no other
// line here.
//
// Both arms answer with an envelope. Each one's whole output is one
// payload a caller either gets or does not (`lib/envelope.ts`). A third
// arm, `preflight`, once answered with a status, and wrote its own
// report. That arm is gone: a skill has no preflight step
// (`.claude/rules/_design-principles.md`). The check it ran now runs
// once, from the plugin's `SessionStart` hook (`hooks/session-start.ts`).
import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: workstreams.ts <command> [options]

commands:
  sweep [--milestone 4,5] [--json]   what a round could start on: milestones,
                                     open pull requests, the unblocked set,
                                     what it unlocks, and the blocked count
  pr-state <number> [--round 0|1|2]  where the review loop is on one pull
    [--substantial] [--rot-checked]  request: its required contexts, its
    [--json]                         checks, its unresolved threads and the
                                     state they add up to
  intersect [--json]                 every open pull request's head against
                                     the default branch and against each
                                     other: merge base, changed files and
                                     merge-tree conflicts, with the runs and
                                     the checkouts
  watch [--interval 60] [--ticks 0]  a long poll of every open pull request:
    [--since-head <n>=<sha>,...]     one line for each new head, required
    [--concluded <n>=<sha>,...]      context and CONCLUDED head, and a
                                     heartbeat

workstreams.ts <command> --help prints that command's own usage.`

// Both streams are guarded here, rather than at each write. A reader that
// closed the pipe (`workstreams.ts sweep | head`) makes the write fail
// asynchronously, as an `error` event. There is nothing to wrap in a `try`,
// and with no listener node crashes with an internals stack trace. The
// writer goes quiet on a broken pipe, and on nothing else: it re-throws an
// ENOSPC or an EIO (`lib/streams.ts`). stdout and stderr are guarded
// independently, so a lost reader does not block the channel a real failure
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
    const { runSweep } = await import('../src/subcommands/sweep.ts')
    // One client for the repository the caller stands in, which is what
    // `gh` resolves from its working directory.
    return write(
      await runSweep(argv, { gh: createGhClient({ cwd: process.cwd(), env: process.env }) }),
    )
  }
  if (name === 'pr-state') {
    const { runPrState } = await import('../src/subcommands/pr-state.ts')
    return write(
      await runPrState(argv, { gh: createGhClient({ cwd: process.cwd(), env: process.env }) }),
    )
  }
  if (name === 'watch') {
    const { runWatch } = await import('../src/subcommands/watch.ts')
    // A SIGTERM ends the watch with exit 0. The listener replaces node's
    // default exit, so the watch stops at its next check. It also ends a
    // sleep in progress, so that check comes at once and not up to a minute
    // later. A reader that closed the pipe ends it the same way: the
    // guarded writer goes quiet on EPIPE (`lib/streams.ts`).
    let terminated = false
    let wake = (): void => {}
    process.once('SIGTERM', () => {
      terminated = true
      wake()
    })
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    return write(
      await runWatch(argv, {
        gh: createGhClient({ cwd: process.cwd(), env: process.env }),
        cwd: process.cwd(),
        env: process.env,
        write: (line) => output.out.write(`${line}\n`),
        now: Date.now,
        sleep,
        stopped: () => terminated || output.out.silenced,
      }),
    )
  }
  return null
}

const [name = '', ...rest] = process.argv.slice(2)

// Asked before anything is loaded, and answered with a status of 0. A
// caller that asks what this can do has not made a mistake. An unknown
// command has, and gets exit 2, with the same list on stderr.
const wantsUsage = name === '' || name === '-h' || name === '--help'
const status = wantsUsage ? write(ok(USAGE)) : await run(name, rest)
process.exitCode = status === null ? write(refused(`unknown command: ${name}\n\n${USAGE}`)) : status
