// Which files the audit reads: tracked `.md` files, via `git ls-files`. So
// it sees what is version-controlled. It does not see whatever an editor or
// a build left on disk.
//
// This is the port of the spike's `discover.ts` (#164). `execFileSync` is
// replaced by `lib/git.ts` `gitOut`. Both use an argv array and no shell.
// So a root that holds a space reaches git as one argument. But the
// failure now comes back as a value, not a throw.

import { gitOut } from './lib/git.ts'

/** A predicate that a caller uses to narrow discovery. It takes a path
 *  relative to the `root` that discovery ran on. */
export type FileFilter = (relativePath: string) => boolean

/**
 * Tracked paths under `root`, sorted, each relative to `root` itself.
 * `null` means git refused to answer. This is not the same as a tree with
 * nothing in it. The caller reports this. It does not audit an empty list.
 *
 * `-z` NUL-delimits the list. This lets a path that contains a space or a
 * newline split correctly (rare, but git allows it). A newline-delimited
 * read would cut such a path in two.
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
 *  This filters here, instead of a `'*.md'` pathspec. Tier 0 needs the
 *  whole tracked list anyway. A path that is not where it is written is
 *  answered against every tracked path (`refs.ts`, `tail_match`). A second
 *  call to git could disagree with the first answer. */
export const markdownFiles = (tracked: readonly string[], filter: FileFilter): string[] =>
  tracked.filter((entry) => entry.endsWith('.md') && filter(entry))

/**
 * The audit's own scope: `CLAUDE.md` and `README.md` anywhere in the tree,
 * by basename. It also includes anything under a `.claude/` directory, at
 * any depth. `--scope all` passes no filter at all instead.
 */
export const scopeFilter: FileFilter = (relativePath) => {
  // This uses `lastIndexOf`, not the last element of a split. A split is
  // never empty. So the fallback an index access would need is a branch
  // nothing can reach. The coverage rule says to restructure that branch
  // away.
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  if (basename === 'CLAUDE.md' || basename === 'README.md') return true
  return relativePath.split('/').includes('.claude')
}
