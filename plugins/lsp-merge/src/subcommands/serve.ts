// The lsp-merge proxy: the one language server that Claude Code starts,
// which runs each child server from `.claude/lsp-merge.json` and joins them
// (ADR 006).
//
// - A request about a file goes to the primary child for that file, and its
//   response goes back. A request with no file goes to the first child.
// - `initialize` and `shutdown` go to every child. The proxy answers once,
//   when all of them answer.
// - Document sync goes to every child that claims the file, with the
//   language id from that child's own map.
// - Each other notification goes to every child.
// - Diagnostics: the proxy keeps the last list of each child for each file,
//   and pushes the union (`diagnostics.ts`). A child that pushes gives its
//   list with `publishDiagnostics`. A child that declares
//   `diagnosticProvider` is pulled with `textDocument/diagnostic` after each
//   `didOpen`, `didChange` and `didSave`, because Claude Code never pulls.
//   TypeScript 7's server only answers pulls (ADR 006).
// - A request from a child goes to Claude Code with its id unchanged. The
//   response goes back to the child that last sent that id. Two children
//   that use the same id at the same time is a known limit (ADR 006).
// - If a child exits before shutdown, the proxy exits with status 1, and
//   Claude Code restarts all of them.
//
// stdout is the LSP channel. Nothing else ever goes to it. Each problem goes
// to stderr, which Claude Code keeps in its debug log.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { type ChildConfig, loadConfig } from '../config.ts'
import { createDiagnosticStore, type PublishParams } from '../diagnostics.ts'
import { mergeInitializeResults } from '../initialize.ts'
import { createDecoder, encode, type Message } from '../jsonrpc.ts'
import { claimants, languageIdFor } from '../router.ts'

export const USAGE = 'usage: lsp-merge serve <project-dir>\n'

/** How long the children have to exit after `exit`, in milliseconds. After
 *  that, the proxy stops them. */
export const EXIT_GRACE_MS = 2_000

export interface ServeEdges {
  /** Claude Code's messages. */
  readonly input: NodeJS.ReadableStream
  /** Messages to Claude Code. */
  readonly output: NodeJS.WritableStream
  /** Problems and child stderr, for the debug log. */
  readonly err: NodeJS.WritableStream
  /** The environment each child starts with, before its own `env`. */
  readonly env: NodeJS.ProcessEnv
  readonly exitGraceMs: number
}

interface Child {
  readonly config: ChildConfig
  readonly process: ChildProcessWithoutNullStreams
  exited: boolean
  /** Whether the child declared `diagnosticProvider`, so the proxy pulls. */
  pulls: boolean
}

/** A request that went to every child, and the answers so far. */
interface Broadcast {
  readonly waiting: Set<Child>
  readonly answers: Map<Child, Message>
  readonly done: (answers: ReadonlyMap<Child, Message>) => void
}

/** A diagnostic pull that the proxy sent, and the file it asked about. */
interface Pull {
  readonly child: Child
  readonly uri: string
}

/** The prefix of the ids of the proxy's own requests. Claude Code's ids are
 *  numbers, so these cannot be the same as one of them. */
const PULL_ID_PREFIX = 'lsp-merge:'

/** A key for a JSON-RPC id. The id may be a number or a string, and `1`
 *  and `"1"` are different ids. */
const idKey = (id: unknown): string => JSON.stringify(id)

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** The file a message is about, or `''`. */
const uriOf = (message: Message): string => {
  const uri = recordOf(recordOf(message.params).textDocument).uri
  return typeof uri === 'string' ? uri : ''
}

const DOCUMENT_SYNC = new Set([
  'textDocument/didChange',
  'textDocument/didSave',
  'textDocument/didClose',
])

/** The document events after which the proxy pulls diagnostics. */
const PULL_AFTER = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didSave',
])

/** Run the proxy until Claude Code ends it, and answer the exit status. */
export const runServe = (argv: readonly string[], edges: ServeEdges): Promise<number> => {
  const projectDir = argv[0]
  if (argv.length !== 1 || projectDir === undefined || projectDir === '') {
    edges.err.write(USAGE)
    return Promise.resolve(2)
  }
  const config = loadConfig(projectDir, (file) => readFileSync(file, 'utf8'))
  if (config.outcome === 'invalid') {
    for (const error of config.errors) edges.err.write(`lsp-merge: ${error}\n`)
    return Promise.resolve(1)
  }

  return new Promise((resolve) => {
    const store = createDiagnosticStore()
    const pending = new Map<string, Child>()
    const fromChildren = new Map<string, Child>()
    const broadcasts = new Map<string, Broadcast>()
    const pulls = new Map<string, Pull>()
    let pullCount = 0
    let finished = false
    let exiting = false
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (status: number): void => {
      if (finished) return
      finished = true
      clearTimeout(graceTimer)
      for (const child of children) if (!child.exited) child.process.kill()
      resolve(status)
    }

    const toClient = (message: Message): void => {
      edges.output.write(encode(message))
    }
    const toChild = (child: Child, message: Message): void => {
      child.process.stdin.write(encode(message))
    }

    /** The children that claim `uri`, in config order. The first is the
     *  primary for the file. */
    const claiming = (uri: string): Child[] => {
      const configs = claimants(
        children.map((child) => child.config),
        uri,
      )
      return children.filter((child) => configs.includes(child.config))
    }

    const broadcast = (
      message: Message,
      paramsFor: (child: Child) => unknown,
      done: Broadcast['done'],
    ): void => {
      broadcasts.set(idKey(message.id), { waiting: new Set(children), answers: new Map(), done })
      for (const child of children) toChild(child, { ...message, params: paramsFor(child) })
    }

    const onClientRequest = (method: string, message: Message): void => {
      if (method === 'initialize') {
        broadcast(
          message,
          (child) =>
            child.config.initializationOptions === undefined
              ? message.params
              : {
                  ...recordOf(message.params),
                  initializationOptions: child.config.initializationOptions,
                },
          (answers) => {
            // In config order, whatever order the answers came in.
            const ordered = children.map((child) => answers.get(child) as Message)
            for (const child of children) {
              const capabilities = recordOf(recordOf(answers.get(child)?.result).capabilities)
              child.pulls = Boolean(capabilities.diagnosticProvider)
            }
            const error = ordered.find((answer) => answer.error !== undefined)
            toClient(
              error === undefined
                ? {
                    jsonrpc: '2.0',
                    id: message.id,
                    result: mergeInitializeResults(ordered.map((answer) => answer.result)),
                  }
                : { jsonrpc: '2.0', id: message.id, error: error.error },
            )
          },
        )
        return
      }
      if (method === 'shutdown') {
        exiting = true
        broadcast(
          message,
          () => message.params,
          () => toClient({ jsonrpc: '2.0', id: message.id, result: null }),
        )
        return
      }
      const uri = uriOf(message)
      const child = uri === '' ? children[0] : claiming(uri)[0]
      if (child === undefined) {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
        return
      }
      pending.set(idKey(message.id), child)
      toChild(child, message)
    }

    /** Ask `child` for its diagnostics on `uri`. The answer arrives in
     *  `onChild`, which pushes it into the union. */
    const pull = (child: Child, uri: string): void => {
      pullCount += 1
      const id = `${PULL_ID_PREFIX}${pullCount}`
      pulls.set(idKey(id), { child, uri })
      toChild(child, {
        jsonrpc: '2.0',
        id,
        method: 'textDocument/diagnostic',
        params: { textDocument: { uri } },
      })
    }

    const onClientNotification = (method: string, message: Message): void => {
      const uri = uriOf(message)
      onDocumentEvent(method, message, uri)
      if (PULL_AFTER.has(method))
        for (const child of claiming(uri)) if (child.pulls) pull(child, uri)
    }

    const onDocumentEvent = (method: string, message: Message, uri: string): void => {
      if (method === 'textDocument/didOpen') {
        for (const child of claiming(uri)) {
          const params = recordOf(message.params)
          toChild(child, {
            ...message,
            params: {
              ...params,
              textDocument: {
                ...recordOf(params.textDocument),
                languageId: languageIdFor(child.config, uri),
              },
            },
          })
        }
        return
      }
      if (DOCUMENT_SYNC.has(method)) {
        for (const child of claiming(uri)) toChild(child, message)
        return
      }
      if (method === '$/cancelRequest') {
        const child = pending.get(idKey(recordOf(message.params).id))
        if (child !== undefined) toChild(child, message)
        return
      }
      for (const child of children) toChild(child, message)
      if (method === 'initialized') {
        for (const child of children) {
          if (child.config.settings === undefined) continue
          toChild(child, {
            jsonrpc: '2.0',
            method: 'workspace/didChangeConfiguration',
            params: { settings: child.config.settings },
          })
        }
      }
      if (method === 'exit') {
        // `shutdown` came first, so a child that has gone by now already
        // counts as a clean exit, and the last one to go ends the proxy.
        exiting = true
        graceTimer = setTimeout(() => finish(0), edges.exitGraceMs)
      }
    }

    const onClient = (message: Message): void => {
      if (typeof message.method !== 'string') {
        // A response to a request that a child sent.
        const key = idKey(message.id)
        const child = fromChildren.get(key)
        if (child === undefined) return
        fromChildren.delete(key)
        toChild(child, message)
        return
      }
      if (message.id === undefined) onClientNotification(message.method, message)
      else onClientRequest(message.method, message)
    }

    const onChild = (child: Child, message: Message): void => {
      const key = idKey(message.id)
      if (typeof message.method !== 'string') {
        const asked = pulls.get(key)
        if (asked?.child === child) {
          pulls.delete(key)
          // `unchanged`, or an error, leaves the child's last list as it is.
          const report = recordOf(message.result)
          if (report.kind !== 'full' || !Array.isArray(report.items)) return
          toClient({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: store.update(child.config.name, { uri: asked.uri, diagnostics: report.items }),
          })
          return
        }
        const waiting = broadcasts.get(key)
        if (waiting?.waiting.delete(child)) {
          waiting.answers.set(child, message)
          if (waiting.waiting.size > 0) return
          broadcasts.delete(key)
          waiting.done(waiting.answers)
          return
        }
        if (pending.get(key) !== child) return
        pending.delete(key)
        toClient(message)
        return
      }
      if (message.id !== undefined) {
        fromChildren.set(key, child)
        toClient(message)
        return
      }
      if (message.method === 'textDocument/publishDiagnostics') {
        toClient({
          jsonrpc: '2.0',
          method: message.method,
          params: store.update(child.config.name, message.params as PublishParams),
        })
        return
      }
      toClient(message)
    }

    const onChildGone = (child: Child, reason: string): void => {
      child.exited = true
      if (exiting) {
        if (children.every((one) => one.exited)) finish(0)
        return
      }
      edges.err.write(`lsp-merge: child "${child.config.name}" ${reason}. lsp-merge stops.\n`)
      finish(1)
    }

    /** Decode `chunk`, and give each message to `handle`. A stream that
     *  breaks the framing stops the proxy: nothing after it can be trusted. */
    const reader = (source: string, handle: (message: Message) => void) => {
      const decoder = createDecoder()
      return (chunk: Buffer): void => {
        if (finished) return
        let messages: Message[]
        try {
          messages = decoder.push(chunk)
        } catch (error) {
          edges.err.write(`lsp-merge: ${source}: ${(error as Error).message}. lsp-merge stops.\n`)
          finish(1)
          return
        }
        for (const message of messages) handle(message)
      }
    }

    const children: Child[] = config.children.map((childConfig) => {
      const child: Child = {
        config: childConfig,
        process: spawn(childConfig.command, [...childConfig.args], {
          cwd: projectDir,
          env: { ...edges.env, ...childConfig.env },
        }),
        exited: false,
        pulls: false,
      }
      child.process.on('error', (error) => onChildGone(child, `could not start: ${error.message}`))
      child.process.on('exit', (code, signal) => onChildGone(child, `exited (${signal ?? code})`))
      // A write to a child that has gone fails with EPIPE. Its `exit` event
      // reports the real cause, so this listener only keeps node from
      // crashing on the write.
      child.process.stdin.on('error', () => {})
      child.process.stdout.on(
        'data',
        reader(`child "${childConfig.name}"`, (message) => onChild(child, message)),
      )
      child.process.stderr.on('data', (chunk: Buffer) => edges.err.write(chunk))
      return child
    })

    edges.input.on('data', reader('Claude Code', onClient))
    edges.input.on('end', () => {
      exiting = true
      finish(0)
    })
  })
}
