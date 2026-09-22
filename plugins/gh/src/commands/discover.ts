// Repository discovery as a command: the port of the `__main__` block of
// `plugins/gh/scripts/lib/discover.py` (deleted at #127).
//
// `../discover.ts` is the rule itself and every other command reaches it in
// process. This is the command line onto it, and it exists because one caller
// is not a command at all: the `/gh:shepherd` skill resolves its scope by
// running discovery and reading one path per line, before it knows which
// repositories it is going to ask `shepherd-status` about. That step ran
// `python3 "$S/lib/discover.py" "$PWD"` until this port, so the plugin owes it
// a node form.
//
// `fixtures/python-cli-output.json`'s `discover` rows are what the Python
// printed for each of these states, captured before any of it was ported, and
// `discover.test.ts` compares against them. `fixtures/divergences-discover.json`
// is what this deliberately says instead.
//
// The command function is the seam (ADR 001): arguments and the process's
// edges in, an exit status out, with nothing spawned.
import { discoverRepos } from '../discover.ts'
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
answer. Exit 1 means the target could not be read at all, which is a different
fact and says so on stderr. Exit 2 means the arguments were refused.`

/** The edges this command reads. The same three `scripts/gh.ts` hands every
 *  envelope command, and no `gh`: discovery asks git and nothing else. */
export interface DiscoverContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly output: Output
}

/**
 * Print the checkout roots in scope for `argv[0]`, or for the caller's own
 * directory.
 *
 * Exit 1 rather than 2 for a target that cannot be read, because 1 is what
 * `discover.py` published for both of its refusals and the two captured rows
 * (`not_a_directory`, `unreadable_target`) are that contract. `gh.ts sync`
 * answers 2 for the same two states, and deliberately: it refuses a request
 * where this reports that a question could not be answered.
 */
export const runDiscover = async (
  argv: readonly string[],
  context: DiscoverContext,
): Promise<number> => {
  const { output } = context
  const [first, ...rest] = argv

  if (first === '-h' || first === '--help') {
    output.out.write(`${HELP}\n`)
    return 0
  }
  if (rest.length > 0) {
    // One target or none. A second one would silently be ignored, and a
    // caller that meant two directories would read one answer as both.
    output.err.write(`usage: gh.ts discover [path]\n`)
    return 2
  }

  // The path as typed, or the caller's own directory. `||` and not `??`:
  // `discover.py`'s own two folds are `if target is None or target == "":
  // target = os.getcwd()` and, in both of its error sentences,
  // `target if target else os.getcwd()`, so an empty argument is an absent
  // one to the Python and has to be one here.
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
  for (const root of found.roots) output.out.write(`${root}\n`)
  return 0
}
