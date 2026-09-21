// A real pnpm project inside a real repository, and the three ways origin can
// move its lock file: the port of the package-manager half of
// `tests/gh/conftest.py` (`js_project`, `remote_update_lock`,
// `remote_break_lock`, `remote_drop_lockfile`), which round 4 deferred to #127
// because #124 had no consumer for it.
//
// **pnpm only** (maintainer's ruling, 2026-09-20). The Python builds the same
// states for Yarn Berry and npm, chosen by a `manager` argument; the port
// watches one lock file and runs one command, so the argument has nothing to
// select and is not ported. `YARN_VERSION`, `has_yarn_berry` and the
// `packageManager` field they exist to drive go with it: the field is what
// corepack reads, and without Berry no fixture needs corepack at all, which is
// why the vitest CI jobs need no `corepack enable` step.
//
// The lock file is written by the real pnpm on PATH, not by hand. A
// hand-written `pnpm-lock.yaml` would let a lock-file diff pass while
// `pnpm install --frozen-lockfile` had never been asked to read one, which is
// the half of the install path these fixtures exist to make real. CI has pnpm
// through `pnpm/action-setup`, which the vitest jobs already run.
//
// Nothing here reaches the network: the only dependency any of these projects
// declares is a directory inside the repository itself.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { GitFixtures } from './git.ts'
import type { Sandbox } from './sandbox.ts'

/** The one lock file the port watches, and the one these builders write. */
export const LOCKFILE = 'pnpm-lock.yaml'

/**
 * Where corepack keeps the package managers it has downloaded: the port of
 * `tests/gh/conftest.py`'s `_real_corepack_home`, and the reason its
 * `corepack_cache` fixture exists.
 *
 * It is needed here for one shape of machine, and not needed at all in CI. On
 * a machine whose `pnpm` is a corepack shim rather than a binary (nvm installs
 * one), corepack resolves the manager against a cache under `HOME`, and the
 * sandbox moves `HOME` for every test. Without this, each install example
 * starts with an empty cache and downloads a pnpm over the network to refill
 * it, which is slow, is a different pnpm from the one the repository pins,
 * and fails outright rather than skipping when the network is unavailable
 * (observed here: pnpm 12.5.1 fetched from the registry inside a sandbox
 * `HOME`). CI installs a real pnpm with `pnpm/action-setup`, so nothing there
 * consults it.
 *
 * A pure function over its three inputs rather than a reader of the ambient
 * process: every platform's answer is then an example rather than a branch
 * only one machine can take. {@link COREPACK_HOME} is the one call that reads
 * the real environment, made at import time, before any sandbox has moved
 * `HOME`.
 */
export function corepackHome(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  // An explicit setting wins, as corepack's own resolution does.
  const explicit = env.COREPACK_HOME
  if (explicit !== undefined && explicit !== '') return explicit
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'node', 'corepack')
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || home, 'node', 'corepack')
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'node', 'corepack')
}

/** The developer's real corepack cache, resolved once, before any test has
 *  moved `HOME`. A test that runs an install passes it in its own `env`:
 *  reading the real cache is a dependency on the machine, so a test that needs
 *  no package manager must not quietly acquire one. */
export const COREPACK_HOME = corepackHome(process.env, process.platform, homedir())

/** What every child that may resolve through corepack is given: the real
 *  cache, and no download prompt, which would otherwise hang a run rather than
 *  fail it. */
export const corepackEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  COREPACK_HOME,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
})

// `--lockfile-only` writes the lock file without linking a `node_modules`,
// which is all a fixture needs: the code under test is the one that runs a
// real install. `--silent` keeps pnpm's progress out of a failure message that
// is already going to be long.
const LOCKFILE_ONLY = ['install', '--lockfile-only', '--silent']

/** How long a fixture's pnpm may take before it is killed and the failure
 *  reported. Only a network that swallows a connection gets anywhere near it:
 *  nothing these builders install comes from a registry. */
const FIXTURE_TIMEOUT_MS = 120_000

export interface PackageFixtures {
  /** A committed, pushed pnpm project: a `package.json` with no dependencies
   *  and the `pnpm-lock.yaml` pnpm wrote for it. */
  jsProject(work: string): void
  /** Origin legitimately regenerates the lock file, so a pull moves it.
   *
   *  The change is a dependency on a directory inside the repository: pnpm
   *  records a real dependency and a `file:` path resolves with no network.
   *  Perturbing a manager-specific field instead does not survive a pnpm
   *  release (the Python's comment records pnpm 10 writing an override that
   *  pnpm 11 drops, which passed locally and failed in CI), and appending to
   *  the lock file, the way `remoteAdvance` appends to a tracked file,
   *  corrupts it. */
  remoteUpdateLock(work: string): void
  /** Origin pushes a lock file that cannot be parsed, so the install fails for
   *  a real and reportable reason while the fast-forward still succeeds. */
  remoteBreakLock(work: string): void
  /** Origin deletes the lock file: a lock-file change with nothing left to
   *  install, which is the one state that still reaches the port's
   *  `NO_LOCKFILE` arm now that only one lock file is recognised. */
  remoteDropLockfile(work: string): void
}

/**
 * The builders, over `git`'s repositories and `sandbox`'s environment.
 *
 * `git` is passed in rather than constructed here so that a test builds one
 * set of repositories and both harnesses act on the same ones, and so that
 * this file owns no git of its own to keep isolated.
 */
export function createPackageFixtures(sandbox: Sandbox, git: GitFixtures): PackageFixtures {
  /**
   * Run pnpm in `directory`, and fail loudly with its own output.
   *
   * A silent failure here surfaces as an unexplained assertion much later, in
   * a test about something else. The developer's own `~/.npmrc` is kept out of
   * it (it may name a registry or a token that is unavailable, which would
   * make an offline install fail for a reason that has nothing to do with the
   * code under test); the sandbox `env` has already moved `HOME`, and naming
   * the user config as well covers the variable that overrides that lookup,
   * exactly as the sandbox pins `GIT_CONFIG_GLOBAL` beside a moved `HOME`.
   */
  function pnpm(directory: string, args: readonly string[]): void {
    const result = spawnSync('pnpm', [...args], {
      cwd: directory,
      env: corepackEnv({ ...sandbox.env, NPM_CONFIG_USERCONFIG: '/dev/null' }),
      // `spawnSync` blocks this worker's event loop, so vitest's own
      // `testTimeout` cannot fire while it runs: a registry that swallows a
      // connection rather than refusing it would hang the suite instead of
      // failing it, and the run would end with no output from pnpm at all.
      // The bound is well past a cold resolve and well under a wait nobody
      // would sit through; exceeding it kills the child and sets
      // `result.error`, which is rethrown below.
      timeout: FIXTURE_TIMEOUT_MS,
    })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      const output = `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`
      // The signal is named beside the status, because a child a signal
      // ended has no status at all and `exit null` names nothing a reader can
      // act on. The bound above is the usual way to get one.
      throw new Error(
        `fixture: pnpm ${args.join(' ')} failed in ${directory} ` +
          `(exit ${result.status}, signal ${result.signal})\n${output}`,
      )
    }
  }

  // The Python checks that a lock file actually appeared, because "a package
  // manager that cannot satisfy its pinned version may print guidance and
  // still exit 0", which was corepack resolving a `packageManager` field, and
  // that field goes with Berry. A real `pnpm install --lockfile-only`
  // that exits 0 has written the lock file, so the guard here would be a
  // branch no test can reach, and the coverage rule says to restructure until
  // the branch is not there rather than to exclude it. The claim is asserted
  // instead, from the outside, in `packages.test.ts`.

  /** A throwaway clone of the same origin, for the three builders that make
   *  origin move without touching the work tree under test. `git.ts` keeps its
   *  own copy of this private, and it is four lines. */
  function cloneOrigin(work: string): string {
    const origin = git.git(work, 'remote', 'get-url', 'origin')
    const scratch = mkdtempSync(path.join(sandbox.path, 'pkg-scratch-'))
    git.git(scratch, 'clone', '-q', origin, path.join(scratch, 'c'))
    return path.join(scratch, 'c')
  }

  /** Commit everything in the clone, push it, and take the clone away again:
   *  what every builder below does once it has changed the lock file. */
  function pushAndDiscard(clone: string, message: string): void {
    git.git(clone, 'add', '-A')
    git.git(clone, 'commit', '-qm', message)
    git.push(clone)
    rmSync(path.dirname(clone), { recursive: true, force: true })
  }

  return {
    jsProject(work: string): void {
      writeFileSync(
        path.join(work, 'package.json'),
        `${JSON.stringify({ name: 'fixture', version: '1.0.0' })}\n`,
      )
      pnpm(work, LOCKFILE_ONLY)
      git.git(work, 'add', '-A')
      git.git(work, 'commit', '-qm', 'add pnpm project')
      git.push(work)
    },

    remoteUpdateLock(work: string): void {
      const clone = cloneOrigin(work)
      mkdirSync(path.join(clone, 'local-dep'))
      writeFileSync(
        path.join(clone, 'local-dep', 'package.json'),
        `${JSON.stringify({ name: 'local-dep', version: '1.0.0' })}\n`,
      )
      const manifest = JSON.parse(readFileSync(path.join(clone, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
      manifest.dependencies = { 'local-dep': 'file:./local-dep' }
      writeFileSync(path.join(clone, 'package.json'), `${JSON.stringify(manifest)}\n`)
      pnpm(clone, LOCKFILE_ONLY)
      pushAndDiscard(clone, 'add a local dependency')
    },

    remoteBreakLock(work: string): void {
      const clone = cloneOrigin(work)
      writeFileSync(path.join(clone, LOCKFILE), 'not: [valid\n')
      pushAndDiscard(clone, 'break the lock file')
    },

    remoteDropLockfile(work: string): void {
      const clone = cloneOrigin(work)
      unlinkSync(path.join(clone, LOCKFILE))
      pushAndDiscard(clone, 'drop lock file')
    },
  }
}
