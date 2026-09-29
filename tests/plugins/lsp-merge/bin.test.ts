// The one spawned contract test for `scripts/lsp-merge.ts`: a real proxy
// process between this test and two real fake-server children. The routing
// decisions are tested in process in `subcommands/serve.test.ts`. This file
// only proves the process boundary: stdio is the LSP channel, and the exit
// status is the contract.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pluginFile } from '#harness/paths.ts'
import { createSandbox } from '#harness/sandbox.ts'
import { runScript } from '#harness/spawn.ts'
import { createDecoder, encode, type Message } from '#lsp-merge/jsonrpc.ts'

const BIN = pluginFile('lsp-merge', 'scripts', 'lsp-merge.ts')
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.ts')

const project = (config?: Record<string, unknown>): string => {
  const dir = createSandbox().join('project')
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  if (config !== undefined) {
    writeFileSync(path.join(dir, '.claude', 'lsp-merge.json'), JSON.stringify(config))
  }
  return dir
}

const fake = (name: string, extensionToLanguage: Record<string, string>) => ({
  command: process.execPath,
  args: [FAKE, JSON.stringify({ name, diagnose: true })],
  extensionToLanguage,
})

it('runs a session end to end: merged diagnostics on stdout, exit 0 after shutdown and exit', async () => {
  const dir = project({
    ts: fake('ts', { '.ts': 'typescript' }),
    biome: fake('biome', { '.ts': 'typescript', '.json': 'json' }),
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
  const received: Message[] = []
  const decoder = createDecoder()
  proxy.stdout.on('data', (chunk: Buffer) => received.push(...decoder.push(chunk)))
  const send = (message: Message) => proxy.stdin.write(encode({ jsonrpc: '2.0', ...message }))
  const waitFor = async (match: (message: Message) => boolean): Promise<Message> => {
    for (let tries = 0; tries < 500; tries += 1) {
      const found = received.find(match)
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`no matching message; received ${JSON.stringify(received)}`)
  }

  send({ id: 0, method: 'initialize', params: { capabilities: {} } })
  await waitFor((message) => message.id === 0)
  send({ method: 'initialized', params: {} })
  send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri: `file://${dir}/a.ts`, languageId: 'typescript', version: 1, text: '' },
    },
  })
  const union = await waitFor(
    (message) =>
      message.method === 'textDocument/publishDiagnostics' &&
      (message.params as { diagnostics: unknown[] }).diagnostics.length === 2,
  )
  send({ id: 1, method: 'shutdown' })
  await waitFor((message) => message.id === 1)
  send({ method: 'exit' })

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
