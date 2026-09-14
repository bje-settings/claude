// One test's private world: a temp directory, a HOME inside it, and an
// environment the test can rewrite. The port of the `Sandbox` class and the
// `sandbox` fixture in tests/conftest.py.
//
// The one deliberate change from the Python original is that nothing here
// touches `process.env`. pytest gives every example its own monkeypatch and
// undoes it at the end; vitest runs several test files through one worker
// process, so a mutated `process.env` would outlive the test that set it and
// reach whatever ran next in that worker. The sandbox hands out an `env`
// object instead, which the spawn helper and the git builder take as the
// child's environment, and which the test may edit freely because nobody else
// can see it.
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

// The tools a plugin script may reach for. `pathWithout` links all of these
// into a fresh bin directory except the ones it is asked to leave out, which
// is how the "tool is not installed" branches get provoked without touching
// the real PATH. Python's `python3` is `node` here: it is the interpreter the
// ported scripts run under, and the one whose absence they have to survive.
export const COMMON_TOOLS: readonly string[] = [
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
]

// Without these a returned PATH is not a usable shell environment at all, and
// a script would fail for a reason the test never meant to provoke.
export const ESSENTIAL_TOOLS: readonly string[] = ['bash', 'sh', 'node']

export interface Sandbox {
  /** The private temp directory. Everything the test writes goes under here. */
  readonly path: string
  /** The child environment: `process.env` with HOME moved and no plugin data
   *  directory. Mutable, and private to this sandbox. */
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

/** The environment a sandbox hands out: `base`, with HOME pointed at `home`
 *  and CLAUDE_PLUGIN_DATA removed.
 *
 *  A copy, never the object it was given: the point of the sandbox is that a
 *  test cannot change what another test sees. Exported so its own claims can
 *  be asserted against a base environment this process does not have.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  env.HOME = home
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
      for (const tool of COMMON_TOOLS) {
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
