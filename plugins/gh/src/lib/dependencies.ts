// This file backs `.claude/rules/_design-principles.md`, "Dependencies
// outside a plugin". A plugin declares the tools it needs as a table, once.
// A `SessionStart` hook asks this file which of them are absent, rather
// than keep its own copy of the check.
//
// {@link absentDependencies} is pure. It takes the table and the lookup as
// arguments. So a test proves every answer with no `PATH`, no child
// process, and no filesystem read. {@link which} is the lookup that a hook
// passes to it. It is the one function here that reads the machine.
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

/** One dependency a plugin declares: the name a lookup asks for, and the
 *  name a person reads. */
export interface Dependency {
  readonly tool: string
  readonly label: string
}

/**
 * The entries of `table` that `present` reports as absent, in table order.
 *
 * `present` answers whether one tool is on the machine. A hook passes its
 * own `PATH` walk here; a test passes a plain function over a fixed set.
 * Neither this file nor its caller reads the machine twice for one table.
 */
export const absentDependencies = (
  table: readonly Dependency[],
  present: (tool: string) => boolean,
): readonly Dependency[] => table.filter((dependency) => !present(dependency.tool))

/**
 * The path of `tool` on `env.PATH`, or `null`. This is a PATH walk, not a
 * run, so a `git` that is not executable is not on PATH.
 *
 * A directory is not a match. The executable bit on a directory is its
 * traverse bit, so a PATH entry that holds a directory named `git` would
 * otherwise pass. An empty PATH is no PATH at all. Without that check, the
 * empty string splits into one empty entry, which resolves against the
 * process's own directory.
 */
export const which = (tool: string, env: NodeJS.ProcessEnv): string | null => {
  const listed = env.PATH ?? ''
  if (listed === '') return null
  for (const directory of listed.split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isDirectory()) return candidate
    } catch {
      // Not here, or not executable. Check the next directory.
    }
  }
  return null
}
