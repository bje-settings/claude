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
// **The dispatch is `load` below and nothing else.** Layers 3 and 4 add
// `shepherd-pr`, `shepherd-status` and the hook's command by adding one line
// each to it. The import inside each arm is dynamic, so a command nobody asked
// for is never loaded, and a new one changes no other line in this file.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: gh.ts <command> [options]

commands:
  sync [--dry-run] [--no-install] [-j N] [path]   sync a checkout, or every
                                                  checkout one level down
  sync-repo [--dry-run] [--no-install] <path>     sync one checkout

gh.ts <command> --help prints that command's own usage.`

/** The command `name` asks for, or `null` when nothing answers to it. */
const load = async (name: string) => {
  if (name === 'sync') return (await import('../src/commands/sync.ts')).runSync
  if (name === 'sync-repo') return (await import('../src/commands/sync-repo.ts')).runSyncRepo
  return null
}

// Both streams are guarded here rather than at each write: a reader that
// closed the pipe (`gh.ts sync | head`) makes the write fail asynchronously,
// as an `error` event, so there is nothing to wrap in a `try`, and with no
// listener node crashes with an internals stack trace. The writer goes quiet
// on a broken pipe and on nothing else: an ENOSPC or an EIO is re-thrown
// (`lib/streams.ts`). stdout and stderr are guarded independently, so a lost
// reader does not take the channel a real failure still has to reach.
const output = createOutput(process.stdout, process.stderr)

const [name = '', ...rest] = process.argv.slice(2)

// Asked before anything is loaded, and answered with a status of 0: a caller
// asking what this can do has not made a mistake. An unknown command has, and
// is exit 2 with the same list on stderr.
const wantsUsage = name === '' || name === '-h' || name === '--help'
const command = wantsUsage ? null : await load(name)
const envelope = wantsUsage
  ? ok(USAGE)
  : command === null
    ? refused(`unknown command: ${name}\n\n${USAGE}`)
    : await command(rest, {
        cwd: process.cwd(),
        env: process.env,
        output,
        // One client per repository, each scoped to that checkout, because
        // the fan-out syncs several in this one process. `gh` resolves the
        // repository from its working directory, which is what the ported
        // scripts rely on after they have changed into the checkout.
        createGh: (cwd: string) => createGhClient({ cwd, env: process.env }),
      })

const rendered = renderText(envelope)
// The renderer adds no trailing newline, so that the entry point decides it;
// a report the command already wrote through `output` leaves an empty string
// here and adds nothing.
if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
process.exitCode = rendered.exitCode
