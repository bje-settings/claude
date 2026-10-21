// The one spawned contract test for the shepherd plugin's `SessionStart`
// hook entry point, and the wiring `hooks.json` carries for it.
//
// `subcommands/session-start.test.ts` runs the hook's decisions in
// process. This file runs the process boundary itself: the floor guard in
// front of it, both streams, and the exit status. It reuses the floor and
// shell fixtures of `tests/plugins/gh/fixtures/` by path, as
// `tests/plugins/workstreams/session-start.test.ts` does. Neither fixture
// names anything of the gh plugin.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox, type Sandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = pluginFile('shepherd', 'hooks', 'session-start.ts')
const HOOKS_JSON = pluginFile('shepherd', 'hooks', 'hooks.json')
const GH_FIXTURES = path.join(HERE, '..', 'gh', 'fixtures')
const OLD_NODE_VERSION = path.join(GH_FIXTURES, 'old-node-version.ts')
const RUN_SHELL_COMMAND = path.join(GH_FIXTURES, 'run-shell-command.ts')

/** A sandbox with a stand-in `gh` first on PATH, and the `gh stack`
 *  extension where gh keeps it, under the sandbox home. gh reads
 *  `XDG_DATA_HOME` before the home, so it goes. */
const withEverything = (): Sandbox => {
  const sandbox = createSandbox()
  const bin = sandbox.stubPath(sandbox.join('bin-gh'))
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  delete sandbox.env.XDG_DATA_HOME
  mkdirSync(
    path.join(String(sandbox.env.HOME), '.local', 'share', 'gh', 'extensions', 'gh-stack'),
    { recursive: true },
  )
  return sandbox
}

it('writes nothing at all, in silence, when everything is present', () => {
  const sandbox = withEverything()

  const result = runScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('writes a problem line and additionalContext when the extension is absent, well under the deadline', () => {
  const sandbox = withEverything()
  // gh reads `XDG_DATA_HOME` first, and this one holds no extension.
  sandbox.env.XDG_DATA_HOME = sandbox.join('no-data')
  const started = Date.now()

  const result = runScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env: sandbox.env })

  expect(Date.now() - started).toBeLessThan(2_500)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('shepherd:')
  expect(result.stdout).toContain('gh stack extension not found')
  expect(result.stdout).toContain('/shepherd:merge cannot merge a stack.')
  expect(result.stderr).toBe('gh stack extension not found\n')
})

it('writes a problem line when gh is absent, well under the deadline', () => {
  const sandbox = createSandbox()
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const started = Date.now()

  const result = runScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env })

  expect(Date.now() - started).toBeLessThan(2_500)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('GitHub CLI (gh) not found on PATH')
  expect(result.stdout).toContain('The shepherd plugin cannot run.')
  expect(result.stderr).toBe('GitHub CLI (gh) not found on PATH\n')
})

it('writes one line naming the floor when node is below it, and exits 0', () => {
  const sandbox = createSandbox()

  const result = runScript(OLD_NODE_VERSION, { args: [HOOK], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    '{"systemMessage":"\\nshepherd: ⚠️ node \\"v20.19.0\\" is below the floor: 22.18.0 or newer."}\n',
  )
  expect(result.stderr).toBe('')
})

// --- the wiring hooks.json carries -------------------------------------------

it('runs the hook entry with node, behind the silent guard, on start, resume, clear and compact', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    hooks: Record<string, { matcher: string; hooks: { command: string; timeout: number }[] }[]>
  }
  const entries = config.hooks.SessionStart ?? []

  expect(Object.keys(config.hooks)).toEqual(['SessionStart'])
  expect(entries).toHaveLength(1)
  expect(entries[0]?.matcher).toBe('startup|resume|clear|compact')
  // Spelled in two pieces because biome refuses a `${` inside a plain
  // string, and the value under test is a shell command carrying Claude
  // Code's own expansion rather than a TypeScript template.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    'if ! command -v node >/dev/null 2>&1; then ' +
      `printf '{"systemMessage":"\\\\nshepherd: ⚠️ node not found on PATH"}\\n'; exit 0; fi; ` +
      `node "${expansion}/hooks/session-start.ts"; exit 0`,
  ])
  // The hook's own 3 s ceiling (`.claude/rules/_design-principles.md`).
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([3])
})

it('writes the node-missing alert itself, straight from the command string', () => {
  const sandbox = createSandbox()

  const result = runScript(RUN_SHELL_COMMAND, {
    args: [HOOKS_JSON],
    env: { ...sandbox.env, PATH: sandbox.pathWithout('node') },
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"\\nshepherd: ⚠️ node not found on PATH"}\n')
  expect(result.stderr).toBe('')
})

it('does not claim node is missing when node runs but fails for another reason', () => {
  // `CLAUDE_PLUGIN_ROOT` is not set, so the command names a file that is
  // not there, and node itself exits non-zero.
  const sandbox = createSandbox()

  const result = runScript(RUN_SHELL_COMMAND, { args: [HOOKS_JSON], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Cannot find module')
})
