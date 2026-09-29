// The one spawned contract test for `scripts/lsp-merge.ts`: a real proxy
// process between this test and two real fake-server children. The routing
// decisions are tested in process in `subcommands/serve.test.ts`. This file
// only proves the process boundary: stdio is the LSP channel, and the exit
// status is the contract.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'
import { createClient, fakeEntry, unionOf } from './lsp-client.test-support.ts'

const BIN = pluginFile('lsp-merge', 'scripts', 'lsp-merge.ts')

const project = (config?: Record<string, unknown>): string => {
  const dir = createSandbox().join('project')
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  if (config !== undefined) {
    writeFileSync(path.join(dir, '.claude', 'lsp-merge.json'), JSON.stringify(config))
  }
  return dir
}

it('runs a session end to end: merged diagnostics on stdout, exit 0 after shutdown and exit', async () => {
  const dir = project({
    ts: fakeEntry({
      fake: { name: 'ts', diagnose: true },
      extensionToLanguage: { '.ts': 'typescript' },
    }),
    biome: fakeEntry({
      fake: { name: 'biome', diagnose: true },
      extensionToLanguage: { '.ts': 'typescript', '.json': 'json' },
    }),
  })
  // Spawned here, not with `startScript`: that helper closes stdin at once,
  // and the proxy reads a closed input as the end of the session.
  const proxy = spawn(process.execPath, [BIN, 'serve', dir])
  let stderr = ''
  proxy.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const ended = new Promise((resolve) =>
    proxy.on('close', (status, signal) => resolve({ status, signal })),
  )
  const client = createClient(proxy.stdin, proxy.stdout)

  client.send({ id: 0, method: 'initialize', params: { capabilities: {} } })
  await client.waitFor((message) => message.id === 0)
  client.send({ method: 'initialized', params: {} })
  client.send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri: `file://${dir}/a.ts`, languageId: 'typescript', version: 1, text: '' },
    },
  })
  const union = await client.waitFor(unionOf(2))
  client.send({ id: 1, method: 'shutdown' })
  await client.waitFor((message) => message.id === 1)
  client.send({ method: 'exit' })

  expect(
    (union.params as { diagnostics: { source: string }[] }).diagnostics
      .map((one) => one.source)
      .sort(),
  ).toEqual(['biome', 'ts'])
  expect(await ended).toEqual({ status: 0, signal: null })
  expect(stderr).toBe('')
})

it('exits 1 and names the file when the config is missing, with nothing on stdout', () => {
  const dir = project()

  const result = runScript(BIN, { args: ['serve', dir] })

  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`lsp-merge: ${dir}/.claude/lsp-merge.json is missing\n`)
})

it('exits 2 with the usage for an unknown command, or none', () => {
  for (const args of [['nope'], []]) {
    const result = runScript(BIN, { args })

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('usage: lsp-merge serve <project-dir>\n')
  }
})
