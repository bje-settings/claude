// This file backs `.claude/rules/_design-principles.md`, "Dependencies
// outside a plugin". A plugin declares the tools it needs as a table, once.
// A `SessionStart` hook asks this file which of them are absent, rather
// than keep its own copy of the check.
//
// {@link absentDependencies} is pure. It takes the table and the lookup as
// arguments. So a test proves every answer with no `PATH`, no child
// process, and no filesystem read. {@link which} is the lookup that a hook
// passes to it. It reads the machine only through {@link FileReads}.
//
// **No read here is sync (#267).** A sync read that hangs on a slow
// filesystem stops the event loop, so no timer can fire, and the hook
// misses its 3 s limit. An async read holds a worker thread instead. So
// {@link withinDeadline} can still answer at the deadline, with "could not
// be checked".
import { access, constants, readFile, stat } from 'node:fs/promises'
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
 * The filesystem reads a `SessionStart` hook makes. A hook gets
 * {@link nodeFileReads}. A test gets a read that never answers, with no
 * slow filesystem. Each read rejects when the target is not there.
 */
export interface FileReads {
  readonly readText: (file: string) => Promise<string>
  /** Whether `target` is a directory or some other kind of entry. */
  readonly kindOf: (target: string) => Promise<'directory' | 'other'>
  /** Resolves when `target` is there and this process can run it. */
  readonly canRun: (target: string) => Promise<void>
}

/** {@link FileReads} over `node:fs/promises`. */
export const nodeFileReads: FileReads = {
  readText: (file) => readFile(file, 'utf8'),
  kindOf: async (target) => ((await stat(target)).isDirectory() ? 'directory' : 'other'),
  canRun: (target) => access(target, constants.X_OK),
}

/** Whether `target` is there. Every reason a read fails answers `false`,
 *  as `existsSync` does. */
export const exists = (files: FileReads, target: string): Promise<boolean> =>
  files.kindOf(target).then(
    () => true,
    () => false,
  )

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
export const which = async (
  tool: string,
  env: NodeJS.ProcessEnv,
  files: FileReads,
): Promise<string | null> => {
  const listed = env.PATH ?? ''
  if (listed === '') return null
  for (const directory of listed.split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      await files.canRun(candidate)
      if ((await files.kindOf(candidate)) !== 'directory') return candidate
    } catch {
      // Not here, or not executable. Check the next directory.
    }
  }
  return null
}

/**
 * What `task` answers, or `late` when it does not settle within `ms`. The
 * timer stops when `task` settles, so it holds no process open.
 *
 * A late task is not stopped: no read can be stopped. Its answer is
 * dropped. The caller names `late`, so "could not be checked" stays apart
 * from every answer `task` can give.
 */
export const withinDeadline = <T, L>(task: Promise<T>, ms: number, late: L): Promise<T | L> =>
  new Promise<T | L>((resolve, reject) => {
    const timer = setTimeout(resolve, ms, late)
    task.then(
      (answer) => {
        clearTimeout(timer)
        resolve(answer)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/** Whether `tool` is on `env.PATH`, or `null` when the walk did not finish
 *  within `ms`. A walk that did not finish is never an absent tool. */
export const onPath = (
  tool: string,
  env: NodeJS.ProcessEnv,
  files: FileReads,
  ms: number,
): Promise<boolean | null> =>
  withinDeadline(
    which(tool, env, files).then((found) => found !== null),
    ms,
    null,
  )

/**
 * A function that gives the milliseconds left of `deadlineMs`, counted from
 * this call, and never less than 1. Each step of a hook asks it just before
 * it starts. So a slow early step leaves less time to the later steps, and
 * the whole hook stays inside one deadline.
 */
export const deadlineClock = (deadlineMs: number): (() => number) => {
  const started = performance.now()
  return () => Math.max(1, deadlineMs - (performance.now() - started))
}
