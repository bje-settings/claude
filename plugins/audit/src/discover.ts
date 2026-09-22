// Which files the audit reads: tracked `.md` files, through `git ls-files`,
// so it sees what is actually version-controlled rather than whatever an
// editor or a build left on disk. The port of the spike's `discover.ts`
// (#164), with `execFileSync` replaced by `lib/git.ts` `gitOut`: an argv array
// and no shell either way, so a root holding a space reaches git as one
// argument, but the failure now comes back as a value rather than a throw.

import { gitOut } from './lib/git.ts'

/** A predicate a caller narrows discovery with, given a path relative to the
 *  `root` discovery was run on. */
export type FileFilter = (relativePath: string) => boolean

/**
 * Tracked paths under `root`, sorted, each relative to `root` itself.
 * `null` is git refusing to answer, which is not the same as a tree with
 * nothing in it: the caller reports it rather than auditing an empty list.
 *
 * `-z` NUL-delimits the list, which is what makes a path containing a space or
 * a newline (rare, but git allows it) split correctly; a newline-delimited
 * read would cut such a path in two.
 *
 */
export const trackedPaths = async (
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string[] | null> => {
  const output = await gitOut(['ls-files', '-z'], { cwd: root, env })
  if (output === null) return null
  return output
    .split('\0')
    .filter((entry) => entry !== '')
    .sort()
}

/** The tracked `.md` files `filter` keeps.
 *
 *  Filtered here rather than with a `'*.md'` pathspec, because tier 0 needs the
 *  whole tracked list anyway: a path that is not where it is written is
 *  answered against every tracked path (`refs.ts`, `tail_match`), and asking
 *  git twice would be a second answer that could disagree with the first. */
export const markdownFiles = (tracked: readonly string[], filter: FileFilter): string[] =>
  tracked.filter((entry) => entry.endsWith('.md') && filter(entry))

/**
 * The audit's own scope: `CLAUDE.md` and `README.md` anywhere in the tree, by
 * basename, plus anything under a `.claude/` directory at any depth. `--scope
 * all` passes no filter at all instead.
 */
export const scopeFilter: FileFilter = (relativePath) => {
  // `lastIndexOf` rather than the last element of a split: a split is never
  // empty, so the fallback an index access would need is a branch nothing can
  // reach, which the coverage rule says to restructure away.
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  if (basename === 'CLAUDE.md' || basename === 'README.md') return true
  return relativePath.split('/').includes('.claude')
}
