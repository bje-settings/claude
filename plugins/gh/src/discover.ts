// Repository discovery: the port of `plugins/gh/scripts/lib/discover.py`.
//
// Scope comes from the target, so no caller has to classify it:
//   - the target is inside a git repo  -> that repo's checkout root
//   - the target is not a git repo     -> every immediate subdirectory that is
//                                         the root of a checkout, non-recursively
//
// Subdirectories that are not git repos, and subdirectories that are merely
// inside a repo rather than its root, are skipped without comment. Nothing is
// ever cloned.
//
// Paths are symlink-resolved, because git reports resolved paths and callers
// compare against them. On macOS /tmp and /var are symlinks, so a logical path
// would never match and every repository beneath one would be skipped.
//
// **Two answers that are not a list of roots.** The Python raises
// `NotADirectoryError` for a target that is not a directory and lets the
// `os.listdir` OSError out for one that cannot be read, and both of its
// callers catch and report them (`discover.py:111` to `122`,
// `gh-sync.py:230`). They are outcomes here instead of exceptions, because the
// caller has a different sentence and a different status for each, and a
// thrown value carries neither in a form a type checker can see. "A target
// that cannot be read is not a target with no repositories in it, and
// answering the second question when the first one was asked is how an
// unreadable directory came back as 'No git repositories directly inside' and
// exit 0."
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; the file and line references below are to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { toplevel as gitToplevel, runGit } from './lib/git.ts'

/** What discovery answers with. */
export type Discovery =
  | {
      readonly outcome: 'ok'
      readonly roots: string[]
      /** The target itself, symlink-resolved. The caller prints it (the
       *  fan-out header and the "No git repositories directly inside" line
       *  both name it), and it has to be the spelling git reports rather than
       *  the one the caller typed, which is what `gh-sync.py:207` resolves it
       *  for. */
      readonly resolved: string
    }
  | { readonly outcome: 'not-a-directory' }
  /** The target exists, is a directory, and could not be listed. `reason` is
   *  node's own account, which names the code and the path. */
  | { readonly outcome: 'unreadable'; readonly reason: string }

/**
 * The checkout root containing `target`, or `null` when there is none.
 *
 * A missing git is the same answer as a directory outside any checkout: no
 * root. "The callers have nothing to do with that distinction, and raising
 * here would turn a degraded environment into a crash" (`discover.py:48`).
 * {@link gitUnavailable} is where a caller that does care asks instead.
 */
export const toplevel = (target: string, env: NodeJS.ProcessEnv): Promise<string | null> =>
  // `discover.py:66` writes this as `return top or None`: a git that exits 0
  // and prints nothing has not named a checkout root, and reading `""` as one
  // puts an empty path in the caller's list. Real git answers with a status
  // instead, but a `git` on PATH is something a caller can choose. That fold
  // is `lib/git.ts`'s own now, for all three of its name questions, so
  // repeating it here would be an arm no test could reach. What is left is
  // the call shape this module's callers have: a path and an environment,
  // rather than a `RepoOptions`.
  gitToplevel({ cwd: target, env })

/**
 * Why git cannot be run at all, or `null` when it can.
 *
 * The port of `gh-sync.py:221`'s `shutil.which("git")` check, and the reason
 * it exists: "Discovery asks git whether a directory is a checkout, and
 * answers 'no' when git cannot be run at all. Without this check a machine
 * with no git on PATH is told it has 'No git repositories', which is a wiring
 * mistake wearing the answer to a different question."
 *
 * It asks git rather than the PATH. A `which` preflight answers a question
 * about a directory listing; running the command answers the question the
 * caller has, and the runner already separates "not there" from "there and
 * unrunnable" for it (`lib/process.ts` `startFailure`, and `lib/README.md` on
 * why no call site in this port preflights with `which`). `--version` because
 * it is git's cheapest subcommand and it needs no repository to answer in.
 */
export const gitUnavailable = async (env: NodeJS.ProcessEnv): Promise<string | null> => {
  const probe = await runGit(['--version'], { env })
  if (probe.startFailure === null) return null
  return probe.startFailure.code === 'ENOENT' ? 'not on PATH' : probe.startFailure.message
}

/** Whether `target` is a directory, reading every reason it is not as the same
 *  answer, the way `os.path.isdir` does: a path that is a file, a path that is
 *  not there, and a path whose parent cannot be searched are all "not a
 *  directory to scan". */
const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Checkout roots in scope for `target`, symlink-resolved. */
export const discoverRepos = async (target: string, env: NodeJS.ProcessEnv): Promise<Discovery> => {
  if (!isDirectory(target)) return { outcome: 'not-a-directory' }
  const realTarget = realpathSync(target)

  const top = await toplevel(realTarget, env)
  if (top !== null) return { outcome: 'ok', roots: [top], resolved: realTarget }

  let names: string[]
  try {
    names = readdirSync(realTarget)
  } catch (error) {
    return { outcome: 'unreadable', reason: (error as Error).message }
  }

  const roots: string[] = []
  for (const name of names.sort()) {
    // The shell glob this replaces was "$target"/*/, which never matches a
    // dotfile: the fan-out fixtures park their bare origins in a hidden
    // directory precisely because of that.
    if (name.startsWith('.')) continue
    const entry = path.join(realTarget, name)
    if (!isDirectory(entry)) continue
    const real = realpathSync(entry)
    const root = await toplevel(entry, env)
    // Only the checkout root counts, never a subdirectory of one.
    if (root === real) roots.push(real)
  }
  return { outcome: 'ok', roots, resolved: realTarget }
}
