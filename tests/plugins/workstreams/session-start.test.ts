// The one spawned contract test for the `SessionStart` hook's entry
// point, and the wiring `hooks.json` carries for it.
//
// `subcommands/session-start.test.ts` runs the hook's decisions in
// process. This file runs the process boundary itself: the floor guard
// in front of it, both streams, and the exit status. It reuses layer 1's
// fixtures (`tests/plugins/gh/fixtures/`) by path, rather than a copy of
// its own: `runScript` and `startScript` take a file to spawn, and
// neither fixture names anything specific to the gh plugin.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript, startScript } from '#harness/spawn.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = pluginFile('workstreams', 'hooks', 'session-start.ts')
const HOOKS_JSON = pluginFile('workstreams', 'hooks', 'hooks.json')
const GH_FIXTURES = path.join(HERE, '..', 'gh', 'fixtures')
const OLD_NODE_VERSION = path.join(GH_FIXTURES, 'old-node-version.ts')
const RUN_SHELL_COMMAND = path.join(GH_FIXTURES, 'run-shell-command.ts')

it('writes nothing at all, in silence, when everything is present', () => {
  const sandbox = createSandbox()
  const bin = sandbox.join('bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\ncase "$*" in\n  *"extension list"*) echo "gh stack\tgithub/gh-stack\tv0.1.0" ;;\n  *) exit 0 ;;\nesac\n',
    {
      mode: 0o755,
    },
  )
  const env = { ...sandbox.env, PATH: sandbox.stubPath(bin) }
  const registryDir = sandbox.join('home', '.claude', 'plugins')
  mkdirSync(registryDir, { recursive: true })
  const reviewers = sandbox.join('cache', 'pr-review-toolkit', 'agents')
  mkdirSync(reviewers, { recursive: true })
  for (const agent of [
    'code-reviewer',
    'comment-analyzer',
    'silent-failure-hunter',
    'pr-test-analyzer',
    'type-design-analyzer',
  ]) {
    writeFileSync(path.join(reviewers, `${agent}.md`), '---\n')
  }
  writeFileSync(
    path.join(registryDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        'pr-review-toolkit@claude-plugins-official': [
          { scope: 'user', installPath: path.dirname(reviewers) },
        ],
      },
    }),
  )

  const result = runScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

it('writes one line naming the floor when node is below it, and exits 0', () => {
  const sandbox = createSandbox()

  const result = runScript(OLD_NODE_VERSION, { args: [HOOK], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    '{"systemMessage":"\\nworkstreams: ⚠️ node \\"v20.19.0\\" is below the floor: 22.18.0 or newer."}\n',
  )
  expect(result.stderr).toBe('')
})

it('writes a problem line when a dependency is absent, well under the deadline', () => {
  const sandbox = createSandbox()
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const started = Date.now()

  const result = runScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env })

  expect(Date.now() - started).toBeLessThan(2_500)
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('workstreams:')
  expect(result.stdout).toContain('the GitHub CLI (gh) is absent')
  expect(result.stderr).toContain('the GitHub CLI (gh) is absent')
})

// --- the wiring hooks.json carries -------------------------------------------

it('runs the hook entry with node, behind the silent guard, on start, resume, clear and compact', () => {
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
    hooks: { SessionStart: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
  }
  const entries = config.hooks.SessionStart

  expect(entries).toHaveLength(1)
  expect(entries[0]?.matcher).toBe('startup|resume|clear|compact')
  // Spelled in two pieces because biome refuses a `${` inside a plain
  // string, and the value under test is a shell command carrying Claude
  // Code's own expansion rather than a TypeScript template.
  const expansion = `$${'{'}CLAUDE_PLUGIN_ROOT}`
  expect(entries[0]?.hooks.map((hook) => hook.command)).toEqual([
    'if ! command -v node >/dev/null 2>&1; then ' +
      `printf '{"systemMessage":"\\\\nworkstreams: ⚠️ node not found on PATH"}\\n'; exit 0; fi; ` +
      `node "${expansion}/hooks/session-start.ts"; exit 0`,
  ])
  // Well under the hook's own 3 s ceiling (`.claude/rules/_design-principles.md`).
  expect(entries[0]?.hooks.map((hook) => hook.timeout)).toEqual([3])
})

it('writes the node-missing alert itself, straight from the command string', () => {
  const sandbox = createSandbox()

  const result = runScript(RUN_SHELL_COMMAND, {
    args: [HOOKS_JSON],
    env: { ...sandbox.env, PATH: sandbox.pathWithout('node') },
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"\\nworkstreams: ⚠️ node not found on PATH"}\n')
  expect(result.stderr).toBe('')
})

it('does not claim node is missing when node runs but fails for another reason', () => {
  // Node is on `PATH` here. `CLAUDE_PLUGIN_ROOT` is not set, so the real
  // command resolves to a path with no file at it, and node itself exits
  // non-zero. The command must not read that as "node not found": the
  // `if` guard checks `command -v node` on its own, once, before it ever
  // runs node.
  const sandbox = createSandbox()

  const result = runScript(RUN_SHELL_COMMAND, { args: [HOOKS_JSON], env: sandbox.env })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Cannot find module')
})

it('finishes clean when the reader of the hook response leaves at once', async () => {
  const sandbox = createSandbox()
  const env = { ...sandbox.env, PATH: sandbox.pathWithout('gh') }
  const running = startScript(HOOK, { stdin: JSON.stringify({ session_id: 's1' }), env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expect(ended.stderr).not.toContain('Error: write EPIPE')
  expect(ended.stderr).not.toMatch(/\n {4}at /)
})

it('finishes clean when the reader of the below-floor alert leaves at once', async () => {
  const sandbox = createSandbox()
  const running = startScript(OLD_NODE_VERSION, { args: [HOOK], env: sandbox.env })

  running.closeStdout()
  const ended = await running.ended()

  expect(ended.status).toBe(0)
  expect(ended.stderr).not.toContain('Error: write EPIPE')
  expect(ended.stderr).not.toMatch(/\n {4}at /)
})
