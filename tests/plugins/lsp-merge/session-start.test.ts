// The spawned contract test for the `SessionStart` hook's entry point, and
// the wiring `hooks.json` carries for it. `subcommands/session-start.test.ts`
// runs the decisions in process. This file reuses the gh plugin's fixtures
// by path, as `tests/plugins/workstreams/session-start.test.ts` does.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = pluginFile('lsp-merge', 'hooks', 'session-start.ts')
const HOOKS_JSON = pluginFile('lsp-merge', 'hooks', 'hooks.json')
const GH_FIXTURES = path.join(HERE, '..', 'gh', 'fixtures')
const OLD_NODE_VERSION = path.join(GH_FIXTURES, 'old-node-version.ts')
const RUN_SHELL_COMMAND = path.join(GH_FIXTURES, 'run-shell-command.ts')

/** A project with a valid config, and a `claude` stub that answers the
 *  plugin list with `listing`. */
const rig = (listing: string) => {
  const sandbox = createSandbox()
  const project = sandbox.join('project')
  mkdirSync(path.join(project, '.claude'), { recursive: true })
  writeFileSync(
    path.join(project, '.claude', 'lsp-merge.json'),
    JSON.stringify({ ts: { command: 'node', extensionToLanguage: { '.ts': 'typescript' } } }),
  )
  const bin = sandbox.join('bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\ncase "$*" in\n  *"plugin list"*) printf '%s' '${listing}' ;;\n  *"details typescript7-lsp@bje"*) echo '  LSP servers (1)  typescript7' ;;\n  *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  )
  return { ...sandbox.env, PATH: sandbox.stubPath(bin), CLAUDE_PROJECT_DIR: project }
}

it('writes nothing when all is well', () => {
  const result = runScript(HOOK, { stdin: '{}', env: rig('[]') })

  expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
})

it('names a conflicting plugin, well under the deadline', () => {
  const env = rig('[{"id":"typescript7-lsp@bje","enabled":true}]')
  const started = Date.now()

  const result = runScript(HOOK, { stdin: '{}', env })

  expect(Date.now() - started).toBeLessThan(2_500)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('other language server plugins are enabled: typescript7-lsp@bje')
  expect(result.stderr).toContain('typescript7-lsp@bje')
})

it('writes one line naming the floor when node is below it, and exits 0', () => {
  const result = runScript(OLD_NODE_VERSION, { args: [HOOK], env: createSandbox().env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    '{"systemMessage":"\\nlsp-merge: ⚠️ node \\"v20.19.0\\" is below the floor: 22.18.0 or newer."}\n',
  )
})

it('runs the hook entry with node, behind the node guard, on start, resume, clear and compact', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    hooks: { SessionStart: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
  }
  const entries = config.hooks.SessionStart
  // Spelled in two pieces because biome refuses `${` inside a plain string.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`

  expect(Object.keys(config.hooks)).toEqual(['SessionStart'])
  expect(entries).toHaveLength(1)
  expect(entries[0]?.matcher).toBe('startup|resume|clear|compact')
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    'if ! command -v node >/dev/null 2>&1; then ' +
      `printf '{"systemMessage":"\\\\nlsp-merge: ⚠️ node not found on PATH"}\\n'; exit 0; fi; ` +
      `node "${expansion}/hooks/session-start.ts"; exit 0`,
  ])
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([3])
})

it('writes the node-missing alert itself, straight from the command string', () => {
  const sandbox = createSandbox()

  const result = runScript(RUN_SHELL_COMMAND, {
    args: [HOOKS_JSON],
    env: { ...sandbox.env, PATH: sandbox.pathWithout('node') },
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"\\nlsp-merge: ⚠️ node not found on PATH"}\n')
  expect(result.stderr).toBe('')
})
