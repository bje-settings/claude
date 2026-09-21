// The one entry point for the `gh` plugin's commands. The floor check is
// first, and it is the only static import: `import` declarations are hoisted
// and evaluated before any statement here runs, so a second static import
// would load its whole module graph on the runtime this guard exists to refuse
// (`lib/README.md`, `lib/node-floor.ts`). Everything else is reached by
// `await import` after the check has passed.
//
// This file ships. It holds no decisions: each command function under
// `src/commands/` is the seam a test reaches without a process, and this
// adapter only turns `process.argv` and this process's streams into that
// function's arguments, and its answer into an exit code. `src/bin.test.ts`,
// through `harness/spawn.ts`, is the one spawned test, on the paths that need
// no `gh` at all.
//
// **The dispatch is `run` below and nothing else.** The import inside each
// arm is dynamic, so a command nobody asked for is never loaded, and a new one
// changes no other line in this file. `discover` was added by #127 layer 4:
// the `/gh:shepherd` skill's first step resolves its scope by running
// discovery and reading one path per line, and that step ran
// `python3 "$S/lib/discover.py" "$PWD"` until the Python was deleted, so the
// port owed it a node form. It answers with a status of its own rather than
// an envelope, because its two refusals are exit 1 in the contract
// `fixtures/python-cli-output.json` captured.
//
// The hook is not here: `hooks/hook-io.ts` is its own entry point, the way
// `hooks/hook-io.py` was, so `hooks.json` runs one file and the three seams
// the hook is built from stay reachable by hand.
//
// The two shepherd commands answer with an exit status rather than an
// envelope, because they have a fourth one (3, an internal error) that
// `lib/envelope.ts` deliberately does not know, and they write their own JSON
// document through the writers handed to them. `discover` answers with a
// status for its own reason, given in its file. That is why `run` answers
// with a number and the envelope commands are rendered inside their own arm.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: gh.ts <command> [options]

commands:
  discover [path]                                 the checkout roots in scope
                                                  for a directory, one per line
  sync [--dry-run] [--no-install] [-j N] [path]   sync a checkout, or every
                                                  checkout one level down
  sync-repo [--dry-run] [--no-install] <path>     sync one checkout
  shepherd-status [path]                          what /gh:shepherd would work
                                                  on in one repository
  shepherd-pr <path> <number> <action> [reason]   one deterministic step
                                                  against one pull request

gh.ts <command> --help prints that command's own usage.`

// Both streams are guarded here rather than at each write: a reader that
// closed the pipe (`gh.ts sync | head`) makes the write fail asynchronously,
// as an `error` event, so there is nothing to wrap in a `try`, and with no
// listener node crashes with an internals stack trace. The writer goes quiet
// on a broken pipe and on nothing else: an ENOSPC or an EIO is re-thrown
// (`lib/streams.ts`). stdout and stderr are guarded independently, so a lost
// reader does not take the channel a real failure still has to reach.
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

/** The process's edges, as the command functions take them. */
const edges = { cwd: process.cwd(), env: process.env, output }

// One client per repository, each scoped to that checkout, because the sync
// fan-out syncs several in this one process. `gh` resolves the repository from
// its working directory, which is what the ported scripts rely on after they
// have changed into the checkout.
const repositoryClient = (cwd: string) => createGhClient({ cwd, env: process.env })

// The shepherd commands name the repository with `--repo` on every call but
// the one that resolves it, so their client takes both; and they poll, so the
// clock and the sleep are arguments rather than imports. These are the real
// ones, constructed here with every other edge of the process: `performance`
// is node's monotonic clock, which is what `time.monotonic()` was, and the
// timer is the one `time.sleep` used.
const shepherdEdges = {
  createGh: (target: { cwd?: string; repository?: string }) =>
    createGhClient({ ...target, env: process.env }),
  now: () => performance.now(),
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
}

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'discover') {
    const { runDiscover } = await import('../src/commands/discover.ts')
    return runDiscover(argv, edges)
  }
  if (name === 'sync') {
    const { runSync } = await import('../src/commands/sync.ts')
    return write(await runSync(argv, { ...edges, createGh: repositoryClient }))
  }
  if (name === 'sync-repo') {
    const { runSyncRepo } = await import('../src/commands/sync-repo.ts')
    return write(await runSyncRepo(argv, { ...edges, createGh: repositoryClient }))
  }
  if (name === 'shepherd-status') {
    const { runShepherdStatus } = await import('../src/commands/shepherd-status.ts')
    return runShepherdStatus(argv, { ...edges, ...shepherdEdges })
  }
  if (name === 'shepherd-pr') {
    const { runShepherdPr } = await import('../src/commands/shepherd-pr.ts')
    return runShepherdPr(argv, { ...edges, ...shepherdEdges })
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
