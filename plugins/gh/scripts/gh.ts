// This file is the one entry point for the `gh` plugin's commands. The
// floor check comes first. It is the only static import. Node hoists and
// evaluates `import` declarations before any statement here runs. A second
// static import would load its whole module graph on the runtime that this
// guard must refuse (`lib/README.md`, `lib/node-floor.ts`). This file
// reaches everything else by `await import`, after the check passes.
//
// This file ships. It holds no decisions. Each command function under
// `src/subcommands/` is the seam a test reaches without a process. This
// adapter only turns `process.argv` and this process's streams into that
// function's arguments. It turns the function's answer into an exit code.
// `tests/plugins/gh/bin.test.ts`, through `harness/spawn.ts`, is the one spawned test.
// It covers the paths that need no `gh` at all.
//
// **The dispatch is `run` below and nothing else.** The import inside each
// arm is dynamic. A command nobody asked for is never loaded. A new
// command changes no other line in this file.
//
// The hook is not here. `hooks/hook-io.ts` is its own entry point, the way
// `hooks/hook-io.py` was. `hooks.json` runs one file this way. The three
// seams that build the hook stay reachable by hand.
//
// Each command answers with an envelope, and renders it inside its own
// arm. `run` answers with the status that the render gives.

import { assertNodeFloor } from '../src/lib/node-floor.ts'

assertNodeFloor(process.version)

const { createGhClient } = await import('../src/lib/gh.ts')
const { failedOnThrow, ok, refused, renderText } = await import('../src/lib/envelope.ts')
const { createOutput } = await import('../src/lib/streams.ts')

const USAGE = `usage: gh.ts <command> [options]

commands:
  sync [--dry-run] [--no-install] [-j N] [path]   sync a checkout, or every
                                                  checkout one level down
  sync-repo [--dry-run] [--no-install] <path>     sync one checkout

gh.ts <command> --help prints that command's own usage.`

// This code guards both streams here, not at each write. A reader that
// closes the pipe (`gh.ts sync | head`) makes the write fail later, as an
// `error` event. There is nothing to wrap in a `try` block for that
// failure. With no listener, node crashes and prints an internals stack
// trace. The writer stays quiet on a broken pipe, and on nothing else: it
// re-throws an ENOSPC or an EIO (`lib/streams.ts`). This code guards stdout
// and stderr independently. A lost reader on one stream does not block the
// channel that a real failure must still reach.
const output = createOutput(process.stdout, process.stderr)

/** What a command that answers with an envelope writes, and its status.
 *  The renderer adds no trailing newline. The entry point decides that
 *  instead. When the command already wrote its report through `output`,
 *  this leaves an empty string here and adds nothing. */
const write = (envelope: Parameters<typeof renderText>[0]): number => {
  const rendered = renderText(envelope)
  if (rendered.stdout !== '') output.out.write(`${rendered.stdout}\n`)
  if (rendered.stderr !== '') output.err.write(`${rendered.stderr}\n`)
  return rendered.exitCode
}

/** The process's edges, as the command functions take them. */
const edges = { cwd: process.cwd(), env: process.env, output }

// This code makes one client per repository, each scoped to that checkout,
// because the sync fan-out syncs several repositories in this one process.
// `gh` resolves the repository from its working directory. The ported
// scripts rely on this after they change into the checkout.
const repositoryClient = (cwd: string) => createGhClient({ cwd, env: process.env })

/** The command `name` asks for, run, or `null` when nothing answers to it. */
const run = async (name: string, argv: readonly string[]): Promise<number | null> => {
  if (name === 'sync') {
    const { runSync } = await import('../src/subcommands/sync.ts')
    return write(await runSync(argv, { ...edges, createGh: repositoryClient }))
  }
  if (name === 'sync-repo') {
    const { runSyncRepo } = await import('../src/subcommands/sync-repo.ts')
    return write(await runSyncRepo(argv, { ...edges, createGh: repositoryClient }))
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
  : await failedOnThrow(run(name, rest), 'gh', output.err)
process.exitCode = status === null ? write(refused(`unknown command: ${name}\n\n${USAGE}`)) : status
