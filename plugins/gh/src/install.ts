// This file picks which package manager a checkout uses, and runs it. It
// is the port of `plugins/gh/scripts/lib/install.py`.
//
// **pnpm only** (the maintainer's ruling on #127, 2026-09-20, and its
// follow-up the same day). The Python knows three lock files and three
// commands. This file knows one of each. This code does not watch or
// report `yarn.lock` or `package-lock.json`, and gives no notice for them:
// "a checkout on another package manager is synced as a repository with no
// dependencies to install". That ruling is the one deliberate behaviour
// change inside a port whose issue body says behaviour stays exact. The PR
// body lists every contract it retires.
//
// With one lock file, the "no recognised lock file remains" answer stays
// reachable for exactly one state. That state is a pull that DELETES
// `pnpm-lock.yaml` (`gh-sync-repo.py:438`). The follow-up ruling says this
// is ported for that case alone.
//
// **The Python this ports was deleted at #127.** `plugins/gh/scripts/*.py`,
// its `lib/`, `plugins/gh/hooks/hook-io.py`, and `tests/gh/` are gone from
// the tree. The file and line references below point to what they held at
// `cd0d515`. Each stays because it says where a rule came from.
import { existsSync } from 'node:fs'
import path from 'node:path'

import { run } from './lib/process.ts'

/** The one lock file this port watches. */
export const LOCKFILE = 'pnpm-lock.yaml'

/** The same name as the pathspec list that `gh-sync-repo.py:422` passes
 *  to `git diff`. A caller does not need to know whether there is one name
 *  or three. */
export const LOCKFILES: readonly string[] = [LOCKFILE]

/** The package manager, and the install that respects the lock file. Frozen,
 *  because a sync installs what the lock file says and never rewrites it. */
export const MANAGER = 'pnpm'
const INSTALL_ARGS: readonly string[] = ['install', '--frozen-lockfile']

/** The command as one list, for a caller (and a test) that wants to read it
 *  whole. */
export const INSTALL_COMMAND: readonly string[] = [MANAGER, ...INSTALL_ARGS]

/** This is not an errno. It is the one value {@link installDeps} can
 *  return that is not a package manager's own exit status. It means
 *  "there was nothing to install". The caller reports this differently
 *  from a failure. */
export const NO_LOCKFILE = 3

/** What an install did: the package manager's own status, or
 *  {@link NO_LOCKFILE}. It also carries the transcript. The caller reads
 *  its one-line reason from that transcript. `null` means a signal ended
 *  the manager. `status` carries this value from the runner. The caller
 *  reports `null` as a failure, like any other non-zero status. */
export interface InstallResult {
  readonly status: number | null
  readonly log: string
}

/** The install command for the lock file in `root`, or `null` when
 *  there is none. This is the port of `install_command`. It stays its own
 *  function because it is the whole of the detection, and a test can call
 *  it directly. */
export const installCommand = (root: string): string[] | null =>
  existsSync(path.join(root, LOCKFILE)) ? [...INSTALL_COMMAND] : null

/**
 * Run the install for `root`.
 *
 * This code reports a missing package manager the way the shell reports
 * it. The caller can put that report in its one-line reason. Status 127
 * means "command not found". Status 126 means the manager is there but
 * will not run.
 *
 * `lib/install.py` lines 58 to 71 argue for both statuses, and the runner
 * already answers with that same pair. This code reads the mapping off
 * {@link RunResult.startFailure}, rather than write it again here.
 *
 * `env` is required, not optional. The install is the one child process in
 * this plugin whose PATH decides which binary answers. A call that names
 * no environment would ask for whatever the process happens to inherit.
 * The caller always has an environment ready to give, at this point.
 */
export const installDeps = async (root: string, env: NodeJS.ProcessEnv): Promise<InstallResult> => {
  if (installCommand(root) === null) return { status: NO_LOCKFILE, log: '' }
  const result = await run(MANAGER, INSTALL_ARGS, { cwd: root, env })
  if (result.startFailure !== null) {
    // Status 127 is the shell's "command not found". The Python prints
    // the shell's own wording for it. Anything else that did not let the
    // child run is 126. Node's own message is the only account of what
    // went wrong.
    const reason = result.status === 127 ? 'command not found' : result.startFailure.message
    return { status: result.status, log: `${MANAGER}: ${reason}` }
  }
  // Both streams appear in arrival order. This is the port of
  // `stderr=subprocess.STDOUT`. Because of this, the last line here is
  // always the package manager's own complaint, whichever stream it wrote
  // to.
  return { status: result.status, log: result.combined }
}
