// One test's private world: a temp directory, a HOME inside it, and an
// environment the test can rewrite. The port of the `Sandbox` class and the
// `sandbox` fixture in tests/conftest.py.
//
// Two deliberate changes from the Python original. The first is that nothing
// here touches `process.env`. pytest gives every example its own monkeypatch
// and undoes it at the end; vitest runs several test files through one worker
// process, so a mutated `process.env` would outlive the test that set it and
// reach whatever ran next in that worker. The sandbox hands out an `env`
// object instead, which the spawn helper and the git builder take as the
// child's environment, and which the test may edit freely because nobody else
// can see it. The second is that git's config lookup is held inside the
// sandbox rather than left to HOME alone; `sandboxEnv` says why.
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

// The tools a plugin script may reach for. `pathWithout` links all of these
// into a fresh bin directory except the ones it is asked to leave out, which
// is how the "tool is not installed" branches get provoked without touching
// the real PATH. Python's `python3` is `node` here: it is the interpreter the
// ported scripts run under, and the one whose absence they have to survive.
//
// `as const` so the names survive as a type: `pathWithout` only ever walks this
// list, so an essential tool missing from it would never be checked for, and
// the guarantee below would quietly stop holding. `CommonTool` makes that a
// compile error instead.
const COMMON_TOOL_NAMES = [
  'bash',
  'sh',
  'jq',
  'git',
  'gh',
  'grep',
  'sed',
  'awk',
  'tr',
  'cat',
  'cut',
  'head',
  'mkdir',
  'mv',
  'rm',
  'date',
  'find',
  'dirname',
  'basename',
  'env',
  'id',
  'chmod',
  'node',
] as const

/** A name `pathWithout` knows how to link. */
export type CommonTool = (typeof COMMON_TOOL_NAMES)[number]

// Exported as `readonly string[]`, so a caller may still ask about a name that
// is not one of these: `pathWithout` refuses a typo at run time, and
// sandbox.test.ts proves it by passing one.
export const COMMON_TOOLS: readonly string[] = COMMON_TOOL_NAMES

// Without these a returned PATH is not a usable shell environment at all, and
// a script would fail for a reason the test never meant to provoke. Typed as
// `CommonTool`, so one of these can never be a name `pathWithout` does not walk.
export const ESSENTIAL_TOOLS: readonly CommonTool[] = ['bash', 'sh', 'node']

export interface Sandbox {
  /** The private temp directory. Everything the test writes goes under here. */
  readonly path: string
  /** The child environment: `process.env` with HOME moved, no plugin data
   *  directory, and git's config lookup held inside the sandbox. Mutable, and
   *  private to this sandbox. */
  readonly env: NodeJS.ProcessEnv
  /** `path.join` rooted at the sandbox, for building fixture paths. */
  join(...parts: string[]): string
  /** Put `directory` ahead of everything on the sandbox's PATH. */
  stubPath(directory: string): string
  /** A bin directory of symlinks to the real tools, minus the named ones. */
  pathWithout(...tools: string[]): string
  /** Remove the sandbox directory. Registered with `onTestFinished` too. */
  cleanup(): void
}

/** The environment a sandbox hands out: `base`, with HOME pointed at `home`,
 *  CLAUDE_PLUGIN_DATA removed, and git's config lookup held inside the
 *  sandbox.
 *
 *  Moving HOME is not enough to keep the developer's git configuration out.
 *  `GIT_CONFIG_GLOBAL` overrides the HOME lookup entirely, and this
 *  repository's own workspace exports it from direnv, so without this a
 *  fixture reads the developer's real global config while CI reads none: with
 *  `status.showUntrackedFiles = no` and `merge.ff = false` in that file, two
 *  of git.test.ts's own assertions fail locally and pass in CI. Pointing it
 *  inside the sandbox restores the plain meaning of moving HOME, and leaves a
 *  test free to write that file itself. `GIT_CONFIG_NOSYSTEM` is the same
 *  argument for the machine's system config, which sets `init.defaultBranch`
 *  on a stock macOS git; it rather than `GIT_CONFIG_SYSTEM` because Apple's
 *  build reads its own system file whatever that is pointed at.
 *
 *  A copy, never the object it was given: the point of the sandbox is that a
 *  test cannot change what another test sees. Exported so its own claims can
 *  be asserted against a base environment this process does not have.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  env.HOME = home
  env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  delete env.CLAUDE_PLUGIN_DATA
  return env
}

/** Look `tool` up on a PATH value, the way a shell does: first executable
 *  match wins, and nothing is found when the value is empty. Exported for the
 *  git shim, which needs the real git's absolute path: a shim named `git`
 *  would otherwise resolve itself.
 */
export function findOnPath(tool: string, pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, tool)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable. Keep walking: a tool genuinely missing
      // from every entry is the case `pathWithout` has to report on.
    }
  }
  return undefined
}

/** A private temp directory, a HOME inside it, and no plugin data directory.
 *
 *  Call it from inside a test: the cleanup is registered with vitest's
 *  `onTestFinished`, so a test that throws still removes its directory, and
 *  `cleanup()` is there for a caller that wants to remove it sooner.
 */
export function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), 'bje-harness-'))
  const home = path.join(root, 'home')
  mkdirSync(home)
  const env = sandboxEnv(process.env, home)

  const cleanup = () => {
    rmSync(root, { recursive: true, force: true })
  }
  onTestFinished(cleanup)

  return {
    path: root,
    env,
    join: (...parts: string[]) => path.join(root, ...parts),

    stubPath(directory: string): string {
      // The shell helpers did this with a fixture `bin/` holding a stub `gh`;
      // the point is the same here, except that the rewrite lands on the
      // sandbox's own env rather than on the process's.
      mkdirSync(directory, { recursive: true })
      const existing = env.PATH
      env.PATH = existing ? `${directory}${path.delimiter}${existing}` : directory
      return directory
    },

    pathWithout(...tools: string[]): string {
      // A typo here would remove nothing and the test would pass for the wrong
      // reason, which is exactly the failure the suite must not have.
      const unknown = tools.filter((tool) => !COMMON_TOOLS.includes(tool))
      if (unknown.length > 0) {
        throw new Error(
          `not tools pathWithout knows about: ${[...unknown].sort().join(', ')}; ` +
            'add them to COMMON_TOOLS',
        )
      }
      // A fresh directory per call, so a second call cannot silently inherit
      // the first one's links and hand back a PATH that still holds the tool
      // the test is trying to take away.
      const directory = mkdtempSync(path.join(root, 'bin-without-'))
      // The `as const` list rather than the exported one, so `tool` carries the
      // literal type the ESSENTIAL_TOOLS check below is written against.
      for (const tool of COMMON_TOOL_NAMES) {
        if (tools.includes(tool)) continue
        const real = findOnPath(tool, env.PATH)
        if (real === undefined) {
          if (ESSENTIAL_TOOLS.includes(tool)) {
            throw new Error(`${tool} is not on PATH; cannot build a usable PATH`)
          }
          continue
        }
        symlinkSync(real, path.join(directory, tool))
      }
      return directory
    },

    cleanup,
  }
}
