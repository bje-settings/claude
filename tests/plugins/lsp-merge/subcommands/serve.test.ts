// The proxy in process, with real children: each child is
// `fixtures/fake-server.ts` under this same node. `lsp-client.test-support.ts`
// has the client, and says how a test sees where a message went.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { createSandbox } from '#harness/sandbox.ts'
import type { Message } from '#lsp-merge/jsonrpc.ts'
import { runServe } from '#lsp-merge/subcommands/serve.ts'
import { createClient, type Entry, fakeEntry, unionOf } from '../lsp-client.test-support.ts'

const TS = { '.ts': 'typescript' }
const TS_AND_JSON = { '.ts': 'typescript', '.json': 'json' }

/** Everything written to `stream`, as text. */
const collect = (stream: NodeJS.ReadableStream): (() => string) => {
  let text = ''
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  return () => text
}

/** A project whose config runs `entries`, and a client wired to the proxy. */
const start = (entries: readonly Entry[] | string, exitGraceMs = 2_000) => {
  const sandbox = createSandbox()
  const project = sandbox.join('project')
  mkdirSync(path.join(project, '.claude'), { recursive: true })
  writeFileSync(
    path.join(project, '.claude', 'lsp-merge.json'),
    typeof entries === 'string'
      ? entries
      : JSON.stringify(
          Object.fromEntries(entries.map((entry) => [entry.fake.name, fakeEntry(entry)])),
        ),
  )
  const input = new PassThrough()
  const output = new PassThrough()
  const err = new PassThrough()
  const stderr = collect(err)
  const client = createClient(input, output)
  const status = runServe([project], { input, output, err, env: process.env, exitGraceMs })

  const initialize = async (): Promise<Message> => {
    client.send({
      id: 0,
      method: 'initialize',
      params: { rootUri: `file://${project}`, capabilities: {} },
    })
    const answer = await client.waitFor((message) => message.id === 0)
    client.send({ method: 'initialized', params: {} })
    return answer
  }
  const stop = async (): Promise<number> => {
    client.send({ id: 'end', method: 'shutdown' })
    await client.waitFor((message) => message.id === 'end')
    client.send({ method: 'exit' })
    return status
  }
  return { ...client, project, input, initialize, stop, status, stderr }
}

const uri = (project: string, file: string) => `file://${project}/${file}`

it('answers initialize once, with merged capabilities and full sync', async () => {
  const proxy = start([
    {
      fake: { name: 'ts', capabilities: { hoverProvider: true, textDocumentSync: 2 } },
      extensionToLanguage: TS,
    },
    {
      fake: { name: 'biome', capabilities: { documentFormattingProvider: true } },
      extensionToLanguage: TS_AND_JSON,
    },
  ])

  const answer = await proxy.initialize()

  expect(answer).toEqual({
    jsonrpc: '2.0',
    id: 0,
    result: {
      capabilities: {
        hoverProvider: true,
        documentFormattingProvider: true,
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
      },
      serverInfo: { name: 'lsp-merge' },
    },
  })
  expect(await proxy.stop()).toBe(0)
})

it('gives each child its own initializationOptions and settings', async () => {
  const proxy = start([
    {
      fake: { name: 'ts' },
      extensionToLanguage: TS,
      initializationOptions: { ts: true },
      settings: { tsSetting: 1 },
    },
    { fake: { name: 'biome' }, extensionToLanguage: TS_AND_JSON },
  ])

  await proxy.initialize()
  await proxy.waitFor((message) => JSON.stringify(message).includes('didChangeConfiguration'))

  expect(proxy.got('ts', 'initialize')[0]?.params).toMatchObject({
    initializationOptions: { ts: true },
  })
  expect(proxy.got('biome', 'initialize')[0]?.params).not.toHaveProperty('initializationOptions')
  expect(proxy.got('ts', 'workspace/didChangeConfiguration').map((one) => one.params)).toEqual([
    { settings: { tsSetting: 1 } },
  ])
  expect(proxy.got('biome', 'workspace/didChangeConfiguration')).toEqual([])
  expect(await proxy.stop()).toBe(0)
})

it('sends a request about a file to its primary child only, and a request with no file to the first child', async () => {
  const proxy = start([
    { fake: { name: 'biome' }, extensionToLanguage: { '.json': 'json' } },
    { fake: { name: 'ts' }, extensionToLanguage: TS },
    { fake: { name: 'biome-ts' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  proxy.send({
    id: 1,
    method: 'textDocument/hover',
    params: { textDocument: { uri: uri(proxy.project, 'a.ts') } },
  })
  proxy.send({ id: 2, method: 'workspace/symbol', params: { query: 'x' } })
  proxy.send({
    id: 4,
    method: 'callHierarchy/incomingCalls',
    params: { item: { uri: uri(proxy.project, 'a.ts'), name: 'f' } },
  })
  proxy.send({
    id: 3,
    method: 'textDocument/hover',
    params: { textDocument: { uri: uri(proxy.project, 'a.py') } },
  })

  expect((await proxy.waitFor((message) => message.id === 1)).result).toEqual({
    server: 'ts',
    method: 'textDocument/hover',
  })
  expect((await proxy.waitFor((message) => message.id === 2)).result).toEqual({
    server: 'biome',
    method: 'workspace/symbol',
  })
  expect((await proxy.waitFor((message) => message.id === 4)).result).toEqual({
    server: 'ts',
    method: 'callHierarchy/incomingCalls',
  })
  expect(await proxy.waitFor((message) => message.id === 3)).toEqual({
    jsonrpc: '2.0',
    id: 3,
    result: null,
  })
  expect(proxy.got('biome-ts', 'textDocument/hover')).toEqual([])
  expect(await proxy.stop()).toBe(0)
})

it('syncs a document to every child that claims it, with each language id, and pushes the diagnostic union', async () => {
  const proxy = start([
    { fake: { name: 'ts', diagnose: true }, extensionToLanguage: TS },
    {
      fake: { name: 'biome', diagnose: true, noSource: true },
      extensionToLanguage: { '.ts': 'ts-biome' },
    },
    { fake: { name: 'json-only' }, extensionToLanguage: { '.json': 'json' } },
  ])
  await proxy.initialize()
  const file = uri(proxy.project, 'a.ts')

  proxy.send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: file, languageId: 'from-manifest', version: 1, text: 'x' } },
  })
  const union = await proxy.waitFor(unionOf(2))
  proxy.send({
    method: 'textDocument/didChange',
    params: { textDocument: { uri: file, version: 2 }, contentChanges: [{ text: 'y' }] },
  })
  proxy.send({ method: 'textDocument/didSave', params: { textDocument: { uri: file } } })
  proxy.send({ method: 'textDocument/didClose', params: { textDocument: { uri: file } } })
  await proxy.until(() =>
    ['ts', 'biome'].every((name) => proxy.got(name, 'textDocument/didClose').length === 1),
  )

  // The union keeps push order, and the two children push in either order.
  expect(union.params).toEqual({
    uri: file,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: 'ts found a problem', source: 'ts' }),
      expect.objectContaining({ message: 'biome found a problem', source: 'biome' }),
    ]),
  })
  expect(proxy.got('ts', 'textDocument/didOpen')[0]?.params).toMatchObject({
    textDocument: { languageId: 'typescript' },
  })
  expect(proxy.got('biome', 'textDocument/didOpen')[0]?.params).toMatchObject({
    textDocument: { languageId: 'ts-biome' },
  })
  for (const method of [
    'textDocument/didOpen',
    'textDocument/didChange',
    'textDocument/didSave',
    'textDocument/didClose',
  ]) {
    expect(proxy.got('ts', method)).toHaveLength(1)
    expect(proxy.got('json-only', method)).toEqual([])
  }
  expect(await proxy.stop()).toBe(0)
})

it('pulls diagnostics from a child that declares diagnosticProvider, after open, change and save', async () => {
  const proxy = start([
    { fake: { name: 'ts', pull: 'full' }, extensionToLanguage: TS },
    { fake: { name: 'biome', diagnose: true }, extensionToLanguage: TS },
    { fake: { name: 'quiet', pull: 'unchanged' }, extensionToLanguage: TS },
    { fake: { name: 'broken', pull: 'error' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()
  const file = uri(proxy.project, 'a.ts')

  proxy.send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: file, languageId: 'x', version: 1, text: '' } },
  })
  const union = await proxy.waitFor(unionOf(2))
  proxy.send({
    method: 'textDocument/didChange',
    params: { textDocument: { uri: file, version: 2 }, contentChanges: [{ text: 'y' }] },
  })
  proxy.send({ method: 'textDocument/didSave', params: { textDocument: { uri: file } } })
  proxy.send({ method: 'textDocument/didClose', params: { textDocument: { uri: file } } })
  await proxy.until(
    () =>
      proxy.got('biome', 'textDocument/didClose').length === 1 &&
      ['ts', 'quiet', 'broken'].every(
        (name) => proxy.got(name, 'textDocument/diagnostic').length === 3,
      ),
  )

  expect(union.params).toEqual({
    uri: file,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: 'ts pulled', source: 'ts' }),
      expect.objectContaining({ message: 'biome found a problem', source: 'biome' }),
    ]),
  })
  const asked = proxy.got('ts', 'textDocument/diagnostic')
  expect(asked).toHaveLength(3)
  expect(asked[0]).toMatchObject({ id: 'lsp-merge:1', params: { textDocument: { uri: file } } })
  expect(proxy.got('biome', 'textDocument/diagnostic')).toEqual([])
  expect(proxy.got('quiet', 'textDocument/diagnostic')).toHaveLength(3)
  expect(proxy.got('broken', 'textDocument/diagnostic')).toHaveLength(3)
  // Neither `unchanged` nor an error adds to, or clears, the union.
  const pushes = proxy.received.filter(
    (message) => message.method === 'textDocument/publishDiagnostics',
  )
  expect(
    pushes.every(
      (message) => (message.params as { diagnostics: unknown[] }).diagnostics.length > 0,
    ),
  ).toBe(true)
  expect(await proxy.stop()).toBe(0)
})

it('sends other notifications to every child, and a cancel only to the child that holds the request', async () => {
  const proxy = start([
    { fake: { name: 'ts' }, extensionToLanguage: TS },
    { fake: { name: 'biome' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  proxy.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
  proxy.send({
    id: 7,
    method: 'textDocument/hover',
    params: { textDocument: { uri: uri(proxy.project, 'a.ts') } },
  })
  proxy.send({ method: '$/cancelRequest', params: { id: 7 } })
  proxy.send({ method: '$/cancelRequest', params: { id: 'unknown' } })
  await proxy.until(
    () =>
      proxy.got('ts', '$/cancelRequest').length === 1 &&
      ['ts', 'biome'].every(
        (name) => proxy.got(name, 'workspace/didChangeWatchedFiles').length === 1,
      ),
  )

  expect(proxy.got('biome', 'workspace/didChangeWatchedFiles')).toHaveLength(1)
  expect(proxy.got('ts', 'workspace/didChangeWatchedFiles')).toHaveLength(1)
  expect(proxy.got('biome', '$/cancelRequest')).toEqual([])
  expect(await proxy.stop()).toBe(0)
})

/** Answer each `window/workDoneProgress/create` the proxy sent on, with
 *  the token of the child that asked. */
const answerProgressRequests = async (proxy: ReturnType<typeof start>, count: number) => {
  const isCreate = (message: Message) => message.method === 'window/workDoneProgress/create'
  await proxy.until(() => proxy.received.filter(isCreate).length === count)
  for (const request of proxy.received.filter(isCreate)) {
    proxy.send({ id: request.id, result: `for ${(request.params as { token: string }).token}` })
  }
}

it("sends a child's request to Claude Code under a proxy id, and the response back under the child's id", async () => {
  const proxy = start([
    { fake: { name: 'ts', requestId: 41 }, extensionToLanguage: TS },
    { fake: { name: 'biome', requestId: 'b-1' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  await answerProgressRequests(proxy, 2)
  proxy.send({ id: 'nobody', result: 'dropped' })
  await proxy.until(() => proxy.logs.filter((log) => log.got.result !== undefined).length === 2)

  const ids = proxy.received
    .filter((message) => message.method === 'window/workDoneProgress/create')
    .map((message) => message.id)
  expect(ids.every((id) => typeof id === 'string' && id.startsWith('lsp-merge:'))).toBe(true)
  const responses = proxy.logs.filter((log) => log.got.result !== undefined)
  expect(responses.map((log) => [log.server, log.got.id, log.got.result])).toEqual(
    expect.arrayContaining([
      ['ts', 41, 'for ts'],
      ['biome', 'b-1', 'for biome'],
    ]),
  )
  expect(await proxy.stop()).toBe(0)
})

it('gives each child its own response when two children use one request id at once', async () => {
  const proxy = start([
    { fake: { name: 'ts', requestId: 1 }, extensionToLanguage: TS },
    { fake: { name: 'biome', requestId: 1 }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  await answerProgressRequests(proxy, 2)
  await proxy.until(() => proxy.logs.filter((log) => log.got.result !== undefined).length === 2)

  const responses = proxy.logs.filter((log) => log.got.result !== undefined)
  expect(responses.map((log) => [log.server, log.got.id, log.got.result])).toEqual(
    expect.arrayContaining([
      ['ts', 1, 'for ts'],
      ['biome', 1, 'for biome'],
    ]),
  )
  expect(await proxy.stop()).toBe(0)
})

it('sends an initialize error on when a child refuses', async () => {
  const proxy = start([
    { fake: { name: 'ts' }, extensionToLanguage: TS },
    { fake: { name: 'biome', initError: true }, extensionToLanguage: TS },
  ])

  const answer = await proxy.initialize()

  expect(answer.error).toEqual({ code: -32603, message: 'biome refused' })
  expect(await proxy.stop()).toBe(0)
})

it('exits with status 1 and names the child when a child crashes', async () => {
  const proxy = start([
    { fake: { name: 'ts' }, extensionToLanguage: TS },
    { fake: { name: 'biome', crashOn: 'textDocument/didOpen' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  proxy.send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: uri(proxy.project, 'a.ts'), text: '' } },
  })

  expect(await proxy.status).toBe(1)
  expect(proxy.stderr()).toContain('lsp-merge: child "biome" exited (3). lsp-merge stops.')

  // Claude Code may still write, then close, after the proxy has stopped.
  // Neither reaches a child, and neither changes the status.
  proxy.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
  proxy.input.end()
  await new Promise((resolve) => setImmediate(resolve))
  expect(await proxy.status).toBe(1)
  expect(proxy.got('ts', 'workspace/didChangeWatchedFiles')).toEqual([])
})

it('exits with status 1 when a child cannot start', async () => {
  const proxy = start(
    JSON.stringify({ gone: { command: '/no/such/server', extensionToLanguage: TS } }),
  )

  expect(await proxy.status).toBe(1)
  expect(proxy.stderr()).toMatch(/lsp-merge: child "gone" could not start: .*ENOENT/)
})

it('exits with status 1 when a child breaks the framing', async () => {
  const proxy = start([{ fake: { name: 'ts', garbageOn: 'initialized' }, extensionToLanguage: TS }])
  await proxy.initialize()

  expect(await proxy.status).toBe(1)
  expect(proxy.stderr()).toContain('lsp-merge: child "ts": body is not JSON')
})

it('exits with status 1 when Claude Code breaks the framing', async () => {
  const proxy = start([{ fake: { name: 'ts' }, extensionToLanguage: TS }])
  await proxy.initialize()

  proxy.input.write('X: 1\r\n\r\n{}')

  expect(await proxy.status).toBe(1)
  expect(proxy.stderr()).toContain('lsp-merge: Claude Code: no Content-Length in header')
})

it('stops the children and exits 0 when Claude Code closes the input', async () => {
  const proxy = start([{ fake: { name: 'ts', ignoreExit: true }, extensionToLanguage: TS }])
  await proxy.initialize()

  proxy.input.end()

  expect(await proxy.status).toBe(0)
})

it('exits 0 once every child has gone after shutdown', async () => {
  const proxy = start([
    { fake: { name: 'ts', exitOnShutdown: true }, extensionToLanguage: TS },
    { fake: { name: 'biome', exitOnShutdown: true }, extensionToLanguage: TS },
  ])
  await proxy.initialize()

  proxy.send({ id: 'end', method: 'shutdown' })

  expect(await proxy.status).toBe(0)
  expect(proxy.stderr()).toBe('')
})

it('stops a child that ignores exit once the grace time ends', async () => {
  const proxy = start([{ fake: { name: 'ts', ignoreExit: true }, extensionToLanguage: TS }], 50)
  await proxy.initialize()
  const started = Date.now()

  expect(await proxy.stop()).toBe(0)
  expect(Date.now() - started).toBeLessThan(2_000)
})

it('drops a response to a request that nobody sent, and passes child stderr on', async () => {
  const proxy = start([
    { fake: { name: 'ts', strayResponse: true, stderr: 'ts says hello' }, extensionToLanguage: TS },
  ])
  await proxy.initialize()
  await proxy.waitFor(() => proxy.got('ts', 'initialized').length === 1)

  expect(await proxy.stop()).toBe(0)
  expect(proxy.received.some((message) => message.id === 'stray')).toBe(false)
  expect(proxy.stderr()).toContain('ts says hello\n')
})

it('survives a write to a child that closed its input, until the child exits', async () => {
  const proxy = start([{ fake: { name: 'ts', closeStdin: true }, extensionToLanguage: TS }])
  await proxy.initialize()
  await proxy.waitFor(() => proxy.got('ts', 'initialized').length === 1)
  await new Promise((resolve) => setTimeout(resolve, 50))

  proxy.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
  proxy.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  proxy.input.end()

  expect(await proxy.status).toBe(0)
})

it('answers a workspace/diagnostic/refresh itself, and pulls each open file of that child again', async () => {
  const proxy = start([
    {
      fake: { name: 'ts', pull: 'full', refreshOn: 'workspace/didChangeWatchedFiles' },
      extensionToLanguage: TS,
    },
  ])
  await proxy.initialize()
  const a = uri(proxy.project, 'a.ts')
  const b = uri(proxy.project, 'b.ts')
  const closed = uri(proxy.project, 'closed.ts')
  // No child claims `.json`, so neither the open nor the refresh pulls it.
  const other = uri(proxy.project, 'data.json')
  for (const file of [a, b, closed, other]) {
    proxy.send({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: file, languageId: 'x', version: 1, text: '' } },
    })
  }
  proxy.send({ method: 'textDocument/didClose', params: { textDocument: { uri: closed } } })
  await proxy.until(() => proxy.got('ts', 'textDocument/diagnostic').length === 3)

  proxy.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [] } })
  await proxy.until(() => proxy.got('ts', 'textDocument/diagnostic').length === 5)

  const pulled = proxy
    .got('ts', 'textDocument/diagnostic')
    .map((one) => (one.params as { textDocument: { uri: string } }).textDocument.uri)
  expect(pulled.slice(3).sort()).toEqual([a, b].sort())
  expect(proxy.logs.some((log) => log.got.id === 'refresh-1' && log.got.result === null)).toBe(true)
  expect(proxy.received.some((message) => message.method === 'workspace/diagnostic/refresh')).toBe(
    false,
  )
  expect(await proxy.stop()).toBe(0)
})

it('sends a pull again when the child cancels it with retriggerRequest', async () => {
  const proxy = start([{ fake: { name: 'ts', pull: 'retrigger-once' }, extensionToLanguage: TS }])
  await proxy.initialize()

  proxy.send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri: uri(proxy.project, 'a.ts'), languageId: 'x', version: 1, text: '' },
    },
  })
  const union = await proxy.waitFor(unionOf(1))

  expect(proxy.got('ts', 'textDocument/diagnostic')).toHaveLength(2)
  expect(union.params).toMatchObject({ diagnostics: [{ message: 'ts pulled' }] })
  expect(await proxy.stop()).toBe(0)
})

it("forgets a closed file's lists, so a pull-only child's old list does not come back", async () => {
  const proxy = start([
    { fake: { name: 'ts', pull: 'full-once' }, extensionToLanguage: TS },
    { fake: { name: 'biome', diagnose: true }, extensionToLanguage: TS },
  ])
  await proxy.initialize()
  const file = uri(proxy.project, 'a.ts')
  proxy.send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: file, languageId: 'x', version: 1, text: '' } },
  })
  await proxy.waitFor(unionOf(2))

  proxy.send({ method: 'textDocument/didClose', params: { textDocument: { uri: file } } })
  proxy.send({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: file, languageId: 'x', version: 2, text: '' } },
  })
  // Two pushes for the first open. After the reopen, biome pushes, and the
  // ts pull answers `unchanged`, which pushes nothing.
  await proxy.until(() => proxy.got('ts', 'textDocument/diagnostic').length === 2)
  await proxy.until(
    () =>
      proxy.received.filter((message) => message.method === 'textDocument/publishDiagnostics')
        .length === 3,
  )

  const pushes = proxy.received.filter(
    (message) => message.method === 'textDocument/publishDiagnostics',
  )
  expect(pushes.at(-1)?.params).toMatchObject({ diagnostics: [{ source: 'biome' }] })
  expect(await proxy.stop()).toBe(0)
})

it('sends SIGKILL to a child that ignores SIGTERM once the grace time ends', async () => {
  const proxy = start(
    [
      {
        fake: { name: 'stubborn', ignoreExit: true, ignoreSigterm: true, logPid: true },
        extensionToLanguage: TS,
      },
      { fake: { name: 'ts' }, extensionToLanguage: TS },
    ],
    50,
  )
  await proxy.initialize()
  const pid = Number(/pid (\d+)/.exec(proxy.stderr())?.[1])
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  expect(await proxy.stop()).toBe(0)
  for (let tries = 0; tries < 100 && alive(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(alive()).toBe(false)
})

it('refuses a command line that does not name one project directory', async () => {
  const err = new PassThrough()
  const stderr = collect(err)
  const edges = {
    input: new PassThrough(),
    output: new PassThrough(),
    err,
    env: {},
    exitGraceMs: 0,
  }

  expect(await runServe([], edges)).toBe(2)
  expect(await runServe([''], edges)).toBe(2)
  expect(await runServe(['a', 'b'], edges)).toBe(2)
  expect(stderr()).toBe('usage: lsp-merge serve <project-dir>\n'.repeat(3))
})

it('exits 1 and names each problem when the config is not valid', async () => {
  const proxy = start('{"ts": {"command": ""}}')

  expect(await proxy.status).toBe(1)
  expect(proxy.stderr()).toContain('lsp-merge.json: ts: "command" must be a non-empty string\n')
})
