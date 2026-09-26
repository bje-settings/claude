// This file is repository discovery as a command. It is the port of the
// `__main__` block of `plugins/gh/scripts/lib/discover.py` (deleted at
// #127).
//
// `../discover.ts` is the rule itself, and every other command reaches it
// in process. This is the command line onto it. It exists because one
// caller is not a command at all: the `/gh:shepherd` skill resolves its
// scope. It runs discovery and reads one path per line, before it knows
// which repositories it will ask `shepherd-status` about. That step ran
// `python3 "$S/lib/discover.py" "$PWD"` until this port. The plugin then
// owed it a node form.
//
// `tests/plugins/gh/fixtures/python-cli-output.json`'s `discover` rows are what the Python
// printed for each of these states. The rows were captured before any of
// it was ported. `tests/plugins/gh/subcommands/discover.test.ts` compares against them.
// `tests/plugins/gh/fixtures/divergences-discover.json` is what this file deliberately
// says instead.
//
// The command function is the seam (ADR 001). Arguments and the process's
// edges go in. An exit status comes out, with nothing spawned.
import { discoverRepos, gitUnavailable } from '../discover.ts'
import type { Output } from '../lib/streams.ts'

export const HELP = `The checkout roots in scope for a directory, one per line.

Usage:
  gh.ts discover [path]

Scope comes from the target, so no caller has to classify it:
  - the target is inside a git repo  -> that repo's checkout root
  - the target is not a git repo     -> every immediate subdirectory that is
                                        the root of a checkout, non-recursively

Subdirectories that are not git repos, and subdirectories that are merely
inside a repo rather than its root, are skipped without comment. Nothing is
ever cloned. Paths are symlink-resolved, because git reports resolved paths
and callers compare against them.

A directory with no checkouts in it prints nothing and exits 0: that is an
answer. Exit 1 means the target could not be read at all, or git itself could
not run, which is a different fact and says so on stderr. Exit 2 means the
arguments were refused.`

/** The edges this command reads: the same three `scripts/gh.ts` hands
 *  every envelope command, and no `gh`. Discovery asks git, and nothing
 *  else. */
export interface DiscoverContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
}

/**
 * Print the checkout roots in scope for `argv[0]`, or for the caller's own
 * directory.
 *
 * This uses exit 1, not 2, for a target that cannot be read. `discover.py`
 * published 1 for both of its refusals, and the two captured rows
 * (`not_a_directory`, `unreadable_target`) are that contract. `gh.ts sync`
 * answers 2 for the same two states, deliberately. It refuses a request.
 * This command instead reports that it could not answer a question.
 */
export const runDiscover = async (
  argv: readonly string[],
  context: DiscoverContext,
): Promise<number> => {
  const { output } = context
  // #218 finding 5: this reads help in any position, before the
  // extra-argument refusal below. `sync.ts` and `sync-repo.ts` already
  // read help this way.
  if (argv.includes('-h') || argv.includes('--help')) {
    output.out.write(`${HELP}\n`)
    return 0
  }
  const [first, ...rest] = argv
  if (rest.length > 0) {
    // This code accepts one target or none. It would silently ignore a
    // second one. A caller that meant two directories would read one
    // answer as both.
    output.err.write(`usage: gh.ts discover [path]\n`)
    return 2
  }

  // The path as typed, or the caller's own directory. This uses `||`, not
  // `??`. `discover.py`'s own two folds are `if target is None or target
  // == "": target = os.getcwd()` and, in both of its error sentences,
  // `target if target else os.getcwd()`. An empty argument was an absent
  // one to the Python, so it must be one here too.
  const target = first || context.cwd
  const found = await discoverRepos(target, context.env)

  if (found.outcome === 'not-a-directory') {
    output.err.write(`not a directory: ${target}\n`)
    return 1
  }
  if (found.outcome === 'unreadable') {
    // "An unreadable target is not a target with no repositories in it, and
    // answering the second question when the first one was asked is how an
    // unreadable directory came back as 'No git repositories directly inside'
    // and exit 0."
    output.err.write(`could not read ${target}: ${found.reason}\n`)
    return 1
  }

  // This check runs after discovery, and before this code writes any line.
  // Discovery answers "no checkouts" when git cannot run at all, the same
  // answer a directory with nothing in it gives. Without this check, a
  // machine with no git on PATH would read as one with no checkouts to
  // report. `gh.ts sync` guards against the same fact with the same
  // function, `../discover.ts`'s `gitUnavailable`.
  const unavailable = await gitUnavailable(context.env)
  if (unavailable !== null) {
    output.err.write(`missing git: ${unavailable}\n`)
    return 1
  }

  for (const root of found.roots) output.out.write(`${root}\n`)
  return 0
}
