// File discovery for the context audit (#164). Tracked `.md` files only, via
// `git ls-files`, so the audit sees what is actually version-controlled
// rather than whatever an editor or a build left on disk. `execFileSync`
// with an argv array and no shell, so a root path holding a space or a quote
// reaches git as one argument instead of being re-read as shell words. The
// filter never goes near git at all: it is a JavaScript predicate applied to
// git's output.
//
// This is the spike's own tooling: node built-ins only, no dependency on the
// rest of the repository.

import { execFileSync } from 'node:child_process'

/** A predicate a caller narrows discovery with, given a path relative to the
 *  `root` discovery was run on. */
export type FileFilter = (relativePath: string) => boolean

/**
 * Tracked `.md` files under `root`, sorted, each path relative to `root`
 * itself. That is the same as repo-relative only when `root` is the top of
 * the repository; run on a subdirectory, git answers relative to that
 * subdirectory, and so does this.
 *
 * `-z` NUL-delimits the list, which is what makes a path containing a space
 * or a newline (rare, but git allows it) split correctly; a plain
 * newline-delimited read would cut such a path into two.
 *
 * `'*.md'` as the pathspec is not anchored to `root`'s own directory: git
 * matches a slash-free glob against the whole tracked tree, so
 * `plugins/gh/README.md` is found from the repository root exactly as
 * `README.md` itself is.
 */
export const discoverFiles = (root: string, filter?: FileFilter): string[] => {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', '*.md'], {
    encoding: 'utf8',
  })
  const files = output.split('\0').filter((path) => path !== '')
  const matched = filter === undefined ? files : files.filter(filter)
  return matched.sort()
}

/**
 * The audit's own scope, for a caller that wants exactly what #164 asks for:
 * `CLAUDE.md`, `README.md` (anywhere in the tree, by basename), and anything
 * under a `.claude/` directory at any depth. Exported as a convenience, not a
 * requirement: {@link discoverFiles} takes any predicate.
 */
export const scopeFilter: FileFilter = (relativePath) => {
  const segments = relativePath.split('/')
  const basename = segments[segments.length - 1] ?? relativePath
  if (basename === 'CLAUDE.md' || basename === 'README.md') return true
  return segments.includes('.claude')
}
