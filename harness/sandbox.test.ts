// The sandbox's own claims, asserted the way tests/gh/test_gh_fixtures.py
// asserts the Python fixtures': a sandbox that quietly stopped isolating HOME,
// or a pathWithout that quietly stopped removing anything, would make every
// test built on it pass for the wrong reason.
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { COMMON_TOOLS, createSandbox, ESSENTIAL_TOOLS, sandboxEnv } from './sandbox.ts'

/** A bin directory holding only the essential tools, as symlinks to this very
 *  node binary: `pathWithout` only asks whether a name is executable, so the
 *  target does not have to be the tool it is standing in for. It is the one
 *  way to reach "a non-essential tool is missing" without depending on which
 *  tools the machine running the suite happens to have.
 */
function essentialsOnly(sandbox: { join(...parts: string[]): string }): string {
  const directory = sandbox.join('essentials-bin')
  mkdirSync(directory, { recursive: true })
  for (const tool of ESSENTIAL_TOOLS) {
    symlinkSync(process.execPath, path.join(directory, tool))
  }
  return directory
}

it('puts HOME inside the sandbox and leaves no plugin data directory set', () => {
  const sandbox = createSandbox()

  expect(sandbox.env.HOME).toBe(path.join(sandbox.path, 'home'))
  expect(existsSync(path.join(sandbox.path, 'home'))).toBe(true)
  expect('CLAUDE_PLUGIN_DATA' in sandbox.env).toBe(false)
})

it('gives each sandbox its own directory under the system temp directory', () => {
  const first = createSandbox()
  const second = createSandbox()

  expect(first.path).not.toBe(second.path)
  expect(first.path.startsWith(path.join(tmpdir(), 'bje-harness-'))).toBe(true)
  expect(first.join('a', 'b')).toBe(path.join(first.path, 'a', 'b'))
})

it('removes the sandbox directory on cleanup', () => {
  const sandbox = createSandbox()
  expect(existsSync(sandbox.path)).toBe(true)

  sandbox.cleanup()

  expect(existsSync(sandbox.path)).toBe(false)
})

it('never mutates the environment it was built from', () => {
  // The property vitest makes load-bearing: several test files share one
  // worker process, so an env rewritten in place would outlive this test.
  const base = { HOME: '/original/home', CLAUDE_PLUGIN_DATA: '/original/data' }

  const env = sandboxEnv(base, '/sandbox/home')

  expect(env.HOME).toBe('/sandbox/home')
  expect('CLAUDE_PLUGIN_DATA' in env).toBe(false)
  expect(base).toEqual({ HOME: '/original/home', CLAUDE_PLUGIN_DATA: '/original/data' })

  const sandbox = createSandbox()
  sandbox.env.HOME = '/somewhere/else'
  expect(process.env.HOME).not.toBe('/somewhere/else')
})

it('puts a stub directory ahead of everything on the PATH it hands out', () => {
  const sandbox = createSandbox()
  const before = process.env.PATH

  const directory = sandbox.stubPath(sandbox.join('stub', 'bin'))

  expect(existsSync(directory)).toBe(true)
  expect(sandbox.env.PATH?.split(path.delimiter)[0]).toBe(directory)
  expect(sandbox.env.PATH).toContain(before)
  expect(process.env.PATH).toBe(before)
})

it('makes a stub directory the whole PATH when there was none', () => {
  const sandbox = createSandbox()
  delete sandbox.env.PATH

  const directory = sandbox.stubPath(sandbox.join('only', 'bin'))

  expect(sandbox.env.PATH).toBe(directory)
})

it('builds a PATH holding the real tools minus the named ones', () => {
  const sandbox = createSandbox()

  const directory = sandbox.pathWithout('git')

  const linked = readdirSync(directory)
  expect(linked).not.toContain('git')
  expect(linked).toContain('sh')
  expect(lstatSync(path.join(directory, 'sh')).isSymbolicLink()).toBe(true)
  expect(linked.every((tool) => COMMON_TOOLS.includes(tool))).toBe(true)
})

it('builds a fresh bin directory on every call', () => {
  // A second call inheriting the first one's links would hand back a PATH
  // that still holds the tool the test is trying to take away.
  const sandbox = createSandbox()

  const first = sandbox.pathWithout('git')
  const second = sandbox.pathWithout()

  expect(first).not.toBe(second)
  expect(readdirSync(first)).not.toContain('git')
  expect(readdirSync(second)).toContain('git')
})

it('refuses a tool name it does not know', () => {
  // A typo removes nothing, and the test then passes for the wrong reason.
  const sandbox = createSandbox()

  expect(() => sandbox.pathWithout('pyhton3', 'gti')).toThrow(
    /not tools pathWithout knows about: gti, pyhton3; add them to COMMON_TOOLS/,
  )
})

it('skips a non-essential tool that is not installed', () => {
  const sandbox = createSandbox()
  sandbox.env.PATH = essentialsOnly(sandbox)

  const directory = sandbox.pathWithout()

  expect(readdirSync(directory).sort()).toEqual([...ESSENTIAL_TOOLS].sort())
})

it('refuses to build a PATH with an essential tool missing', () => {
  // Silently returning a PATH without a shell would fail a later test for a
  // reason that test never meant to provoke.
  const sandbox = createSandbox()
  delete sandbox.env.PATH

  expect(() => sandbox.pathWithout()).toThrow(/bash is not on PATH; cannot build a usable PATH/)
})
