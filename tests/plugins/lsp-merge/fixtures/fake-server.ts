// A fake LSP child server for the lsp-merge tests. Its behaviour comes from
// one JSON argument (`FakeOptions`).
//
// It reports each message it receives back to the client as a
// `window/logMessage` notification, whose message is
// `{"server": <name>, "got": <message>}`. So a test sees where the proxy
// routed each message, with no log file.
import { closeSync } from 'node:fs'
import { createDecoder, encode, type Message } from '#lsp-merge/jsonrpc.ts'

export interface FakeOptions {
  readonly name: string
  readonly capabilities?: Record<string, unknown>
  /** Answer `initialize` with an error. */
  readonly initError?: boolean
  /** Push one diagnostic on each `didOpen` and `didChange`. */
  readonly diagnose?: boolean
  /** Leave `source` out of the diagnostics it pushes. */
  readonly noSource?: boolean
  /** After `initialized`, send this request to the client. */
  readonly requestId?: number | string
  /** Exit with status 3 when this method arrives. */
  readonly crashOn?: string
  /** Write bytes that break the framing when this method arrives. */
  readonly garbageOn?: string
  /** Stay alive after `exit`. */
  readonly ignoreExit?: boolean
  /** Exit as soon as `shutdown` is answered. */
  readonly exitOnShutdown?: boolean
  /** After `initialized`, send a response to a request nobody sent. */
  readonly strayResponse?: boolean
  /** After `initialized`, close stdin and stay alive. */
  readonly closeStdin?: boolean
  /** Declare `diagnosticProvider`, and answer each pull this way: one
   *  diagnostic (`full`), `unchanged`, or an error. */
  readonly pull?: 'full' | 'unchanged' | 'error' | 'retrigger-once' | 'full-once'
  /** Send `workspace/diagnostic/refresh` when this method arrives. */
  readonly refreshOn?: string
  /** Ignore SIGTERM, so only SIGKILL stops it. */
  readonly ignoreSigterm?: boolean
  /** Write `pid <n>` to stderr at start. */
  readonly logPid?: boolean
  /** Write this line to stderr at start. */
  readonly stderr?: string
}

/** The range of each diagnostic the fake server gives. */
const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }

const options = JSON.parse(process.argv[2] ?? '{}') as FakeOptions
const send = (message: Message): void => {
  process.stdout.write(encode({ jsonrpc: '2.0', ...message }))
}

let pulls = 0

const handle = (message: Message): void => {
  const method = typeof message.method === 'string' ? message.method : undefined
  send({
    method: 'window/logMessage',
    params: { type: 4, message: JSON.stringify({ server: options.name, got: message }) },
  })
  if (method !== undefined && method === options.crashOn) process.exit(3)
  if (method !== undefined && method === options.refreshOn) {
    send({ id: 'refresh-1', method: 'workspace/diagnostic/refresh' })
  }
  if (method !== undefined && method === options.garbageOn) {
    process.stdout.write('Content-Length: 5\r\n\r\nnope!')
    return
  }
  const params = (message.params ?? {}) as Record<string, unknown>
  const document = (params.textDocument ?? {}) as Record<string, unknown>
  switch (method) {
    case 'initialize': {
      const capabilities = { ...options.capabilities }
      if (options.pull !== undefined)
        capabilities.diagnosticProvider = { interFileDependencies: false }
      if (options.initError) {
        send({ id: message.id, error: { code: -32603, message: `${options.name} refused` } })
      } else send({ id: message.id, result: { capabilities } })
      return
    }
    case 'textDocument/diagnostic':
      pulls += 1
      if (options.pull === 'retrigger-once' && pulls === 1) {
        send({
          id: message.id,
          error: { code: -32802, message: 'busy', data: { retriggerRequest: true } },
        })
      } else if (options.pull === 'full-once' && pulls > 1) {
        send({ id: message.id, result: { kind: 'unchanged', resultId: '1' } })
      } else if (options.pull === 'error')
        send({ id: message.id, error: { code: -32603, message: 'no' } })
      else if (options.pull === 'unchanged')
        send({ id: message.id, result: { kind: 'unchanged', resultId: '1' } })
      else {
        send({
          id: message.id,
          result: {
            kind: 'full',
            items: [
              {
                range: RANGE,
                message: `${options.name} pulled`,
              },
            ],
          },
        })
      }
      return
    case 'initialized':
      if (options.strayResponse) send({ id: 'stray', result: 'nobody asked' })
      if (options.closeStdin) {
        process.stdin.destroy()
        closeSync(0)
        setInterval(() => {}, 1_000)
      }
      if (options.requestId !== undefined) {
        send({
          id: options.requestId,
          method: 'window/workDoneProgress/create',
          params: { token: options.name },
        })
      }
      return
    case 'shutdown':
      send({ id: message.id, result: null })
      if (options.exitOnShutdown) setImmediate(() => process.exit(0))
      return
    case 'exit':
      if (!options.ignoreExit) process.exit(0)
      return
    case 'textDocument/didOpen':
    case 'textDocument/didChange':
      if (options.diagnose) {
        const diagnostic: Record<string, unknown> = {
          range: RANGE,
          severity: 1,
          message: `${options.name} found a problem`,
        }
        if (!options.noSource) diagnostic.source = options.name
        send({
          method: 'textDocument/publishDiagnostics',
          params: { uri: document.uri, diagnostics: [diagnostic] },
        })
      }
      return
    default:
      if (method !== undefined && message.id !== undefined) {
        send({ id: message.id, result: { server: options.name, method } })
      }
  }
}

if (options.stderr !== undefined) process.stderr.write(`${options.stderr}\n`)
if (options.logPid) process.stderr.write(`pid ${process.pid}\n`)
if (options.ignoreSigterm) process.on('SIGTERM', () => {})

const decoder = createDecoder()
process.stdin.on('data', (chunk: Buffer) => {
  for (const message of decoder.push(chunk)) handle(message)
})
process.stdin.on('end', () => {
  if (!options.ignoreExit) process.exit(0)
})
