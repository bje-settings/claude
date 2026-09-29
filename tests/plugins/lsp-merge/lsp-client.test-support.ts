// The test side of an LSP session with the proxy, shared by
// `subcommands/serve.test.ts` (in process) and `bin.test.ts` (spawned).
//
// The fake server (`fixtures/fake-server.ts`) reports each message it gets
// as a `window/logMessage`. This client parses each report once, as it
// arrives, so a test asserts where the proxy routed a message by what
// reaches the client.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecoder, encode, type Message } from '#lsp-merge/jsonrpc.ts'
import type { FakeOptions } from './fixtures/fake-server.ts'

export const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-server.ts',
)

/** One `lsp-merge.json` entry that runs the fake server. */
export interface Entry {
  readonly fake: FakeOptions
  readonly extensionToLanguage: Record<string, string>
  readonly initializationOptions?: unknown
  readonly settings?: unknown
}

export const fakeEntry = ({ fake, ...rest }: Entry) => ({
  command: process.execPath,
  args: [FAKE, JSON.stringify(fake)],
  ...rest,
})

/** A `publishDiagnostics` that carries `count` diagnostics. */
export const unionOf =
  (count: number) =>
  (message: Message): boolean =>
    message.method === 'textDocument/publishDiagnostics' &&
    (message.params as { diagnostics: unknown[] }).diagnostics.length === count

/** How long a wait may take before the test fails and shows what arrived. */
const WAIT_MS = 5_000

/** A client that writes to `toProxy` and reads from `fromProxy`. */
export const createClient = (toProxy: NodeJS.WritableStream, fromProxy: NodeJS.ReadableStream) => {
  const received: Message[] = []
  const logs: { server: string; got: Message }[] = []
  const waiters: { condition: () => boolean; resolve: () => void }[] = []
  const decoder = createDecoder()

  fromProxy.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      received.push(message)
      if (message.method === 'window/logMessage') {
        logs.push(JSON.parse((message.params as { message: string }).message))
      }
    }
    for (const waiter of [...waiters]) {
      if (!waiter.condition()) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  })

  /** Resolve once `condition` holds, checked as each chunk arrives. */
  const until = (condition: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      if (condition()) {
        resolve()
        return
      }
      const timer = setTimeout(
        () => reject(new Error(`timed out; received ${JSON.stringify(received)}`)),
        WAIT_MS,
      )
      waiters.push({
        condition,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })

  return {
    received,
    logs,
    send: (message: Message): void => {
      toProxy.write(encode({ jsonrpc: '2.0', ...message }))
    },
    until,
    /** The first received message that `match` accepts, once it arrives. */
    waitFor: async (match: (message: Message) => boolean): Promise<Message> => {
      await until(() => received.some(match))
      return received.find(match) as Message
    },
    /** Each message of `method` that fake server `server` reported. */
    got: (server: string, method: string): Message[] =>
      logs
        .filter((log) => log.server === server && log.got.method === method)
        .map((log) => log.got),
  }
}
