// This file backs `.claude/rules/_design-principles.md`, "Dependencies
// outside a plugin". A plugin declares the tools it needs as a table, once.
// A `SessionStart` hook asks this file which of them are absent, rather
// than keep its own copy of the check.
//
// This file is pure. It takes the table AND the lookup as arguments, so a
// test proves every answer with no `PATH`, no child process, and no
// filesystem read.

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
): Dependency[] => table.filter((dependency) => !present(dependency.tool))
