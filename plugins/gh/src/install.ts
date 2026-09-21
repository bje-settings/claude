// Which package manager a checkout uses, and running it: the port of
// `plugins/gh/scripts/lib/install.py`.
//
// **pnpm only** (the maintainer's ruling on #127, 2026-09-20, and its
// follow-up the same day). The Python knows three lock files and three
// commands; this knows one of each. `yarn.lock` and `package-lock.json` are
// not watched, not reported, and get no notice: "a checkout on another package
// manager is synced as a repository with no dependencies to install". That
// ruling is the one deliberate behaviour change inside a port whose issue body
// says behaviour is kept exactly, and the PR body lists every contract it
// retires.
//
// With one lock file, the "no recognised lock file remains" answer stays
// reachable for exactly one state: a pull that DELETES `pnpm-lock.yaml`
// (`gh-sync-repo.py:438`, and the follow-up ruling says it is ported for that
// case alone).
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py` and `tests/gh/` are gone from the
// tree; every file and line reference below is to what they held at
// `cd0d515`, kept because each says where a rule came from.
import { existsSync } from 'node:fs'
import path from 'node:path'

import { run } from './lib/process.ts'

/** The one lock file this port watches. */
export const LOCKFILE = 'pnpm-lock.yaml'

/** The same name as the pathspec list `gh-sync-repo.py:422` passes to `git
 *  diff`, so a caller does not have to know whether there is one name or
 *  three. */
export const LOCKFILES: readonly string[] = [LOCKFILE]

/** The package manager, and the install that respects the lock file. Frozen,
 *  because a sync installs what the lock file says and never rewrites it. */
export const MANAGER = 'pnpm'
const INSTALL_ARGS: readonly string[] = ['install', '--frozen-lockfile']

/** The command as one list, for a caller (and a test) that wants to read it
 *  whole. */
export const INSTALL_COMMAND: readonly string[] = [MANAGER, ...INSTALL_ARGS]

/** Not an errno: the one value {@link installDeps} answers with that is not a
 *  package manager's own exit status. It says "there was nothing to install",
 *  which the caller reports differently from a failure. */
export const NO_LOCKFILE = 3

/** What an install did: the package manager's own status, or
 *  {@link NO_LOCKFILE}, and the transcript the caller takes its one-line
 *  reason from. `null` is a manager a signal ended, which `status` carries
 *  from the runner and which the caller reports as a failure like any other
 *  non-zero. */
export interface InstallResult {
  readonly status: number | null
  readonly log: string
}

/** The install command for the lock file in `root`, or `null` when there is
 *  none. The port of `install_command`, kept as its own function because it is
 *  the whole of the detection and a test can ask it directly. */
export const installCommand = (root: string): string[] | null =>
  existsSync(path.join(root, LOCKFILE)) ? [...INSTALL_COMMAND] : null

/**
 * Run the install for `root`.
 *
 * A package manager that is not installed is reported the way the shell
 * reported it, as output the caller can put in its one-line reason: 127 with
 * "command not found", and 126 for one that is there and will not run.
 * `lib/install.py` lines 58 to 71 argue both statuses, and the runner already
 * answers with exactly that pair, so the mapping is read off
 * {@link RunResult.startFailure} rather than written a second time here.
 *
 * `env` is required rather than optional: the install is the one child in this
 * plugin whose PATH decides which binary answers, and a call that named no
 * environment would be asking whatever the process happened to inherit at a
 * point where the caller always has one to hand.
 */
export const installDeps = async (root: string, env: NodeJS.ProcessEnv): Promise<InstallResult> => {
  if (installCommand(root) === null) return { status: NO_LOCKFILE, log: '' }
  const result = await run(MANAGER, INSTALL_ARGS, { cwd: root, env })
  if (result.startFailure !== null) {
    // 127 is the shell's "command not found" and the Python prints the shell's
    // wording for it; anything else that kept the child from running is 126,
    // and node's own message is the only account of what went wrong.
    const reason = result.status === 127 ? 'command not found' : result.startFailure.message
    return { status: result.status, log: `${MANAGER}: ${reason}` }
  }
  // Both streams in arrival order: the port of `stderr=subprocess.STDOUT`,
  // which is what makes the last line of this the package manager's own
  // complaint whichever stream it wrote it on.
  return { status: result.status, log: result.combined }
}
