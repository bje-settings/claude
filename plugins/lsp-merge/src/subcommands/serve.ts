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
//   TypeScript 7's server only answers pulls (ADR 006). The proxy answers a
//   child's `workspace/diagnostic/refresh` itself, and pulls each open file
//   of that child again. A pull that the child cancels with
//   `retriggerRequest` is sent again.
// - A request from a child goes to Claude Code under an id from the proxy,
//   so two children can use the same id. The response goes back to that
//   child, under its own id.
// - If a child exits before shutdown, the proxy exits with status 1, and
//   Claude Code restarts all of them. When the proxy stops, a child that
//   has not exited after the grace time gets SIGKILL.
//
// stdout is the LSP channel. Nothing else ever goes to it. Each problem goes
// to stderr, which Claude Code keeps in its debug log.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { type ChildConfig, loadConfig } from '../config.ts'
import { createDiagnosticStore, fileKey, type PublishParams } from '../diagnostics.ts'
import { capabilitiesOf, mergeInitializeResults } from '../initialize.ts'
import { createDecoder, encode, type Message, recordOf } from '../jsonrpc.ts'
import { claims, languageIdFor } from '../router.ts'

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

/** A request that went to one or more children, and the answers so far.
 *  `done` runs when the last child answers. */
interface Outstanding {
  readonly waiting: Set<Child>
  readonly answers: Map<Child, Message>
  readonly done: (answers: ReadonlyMap<Child, Message>) => void
  /** Whether a `$/cancelRequest` from Claude Code may reach the children. */
  readonly cancellable: boolean
}

/** A request that a child sent to Claude Code, under a proxy id. */
interface FromChild {
  readonly child: Child
  readonly id: unknown
}

/** The prefix of the ids of the proxy's own requests. Claude Code's ids are
 *  numbers, so these cannot be the same as one of them. */
const PROXY_ID_PREFIX = 'lsp-merge:'

/** How long to wait before a pull that a child cancelled with
 *  `retriggerRequest` goes again, in milliseconds. The child cancels while
 *  it is busy, for example while it loads the project. */
export const RETRIGGER_MS = 100

/** A key for a JSON-RPC id. The id may be a number or a string, and `1`
 *  and `"1"` are different ids. */
const idKey = (id: unknown): string => JSON.stringify(id)

/** The file a message is about, or `''`. Most requests name it in
 *  `textDocument`. A call or type hierarchy request names it in `item`. */
const uriOf = (message: Message): string => {
  const params = recordOf(message.params)
  const uri = recordOf(params.textDocument).uri ?? recordOf(params.item).uri
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
    const outstanding = new Map<string, Outstanding>()
    const fromChildren = new Map<string, FromChild>()
    /** Claude Code's URI for each open file, by `fileKey`. */
    const openFiles = new Map<string, string>()
    let finished = false
    let exiting = false
    let idCount = 0
    const nextId = (): string => {
      idCount += 1
      return `${PROXY_ID_PREFIX}${idCount}`
    }
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (status: number): void => {
      if (finished) return
      finished = true
      clearTimeout(graceTimer)
      for (const child of children) if (!child.exited) child.process.kill()
      // A child that ignores SIGTERM would keep the proxy's process alive.
      setTimeout(() => {
        for (const child of children) if (!child.exited) child.process.kill('SIGKILL')
      }, edges.exitGraceMs).unref()
      resolve(status)
    }

    const toClient = (message: Message): void => {
      edges.output.write(encode(message))
    }
    /** Send one message to each of `targets`. It is encoded once, because a
     *  full-sync `didChange` carries the whole file. */
    const toChildren = (targets: readonly Child[], message: Message): void => {
      const bytes = encode(message)
      for (const child of targets) child.process.stdin.write(bytes)
    }

    /** The children that claim `uri`, in config order. The first is the
     *  primary for the file. */
    const claiming = (uri: string): Child[] => children.filter((child) => claims(child.config, uri))

    /** Send `message` to each of `targets`, and run `done` with their
     *  answers when the last one answers. */
    const ask = (
      targets: readonly Child[],
      message: Message,
      done: Outstanding['done'],
      cancellable = false,
    ): void => {
      outstanding.set(idKey(message.id), {
        waiting: new Set(targets),
        answers: new Map(),
        done,
        cancellable,
      })
      toChildren(targets, message)
    }

    /** Ask `child` for its diagnostics on `uri`, and push the answer into
     *  the union. `unchanged`, or an error, leaves the child's last list. An
     *  error that asks for a retrigger sends the pull again. */
    const pull = (child: Child, uri: string): void => {
      const message = {
        jsonrpc: '2.0',
        id: nextId(),
        method: 'textDocument/diagnostic',
        params: { textDocument: { uri } },
      }
      ask([child], message, (answers) => {
        const answer = answers.get(child) as Message
        if (recordOf(recordOf(answer.error).data).retriggerRequest === true) {
          setTimeout(() => pull(child, uri), RETRIGGER_MS)
          return
        }
        const report = recordOf(answer.result)
        if (report.kind !== 'full' || !Array.isArray(report.items)) return
        toClient({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: store.update(child.config.name, { uri, diagnostics: report.items }),
        })
      })
    }

    const onClientRequest = (method: string, message: Message): void => {
      if (method === 'initialize') {
        // Each child gets its own `initializationOptions`, so this sends one
        // message per child, under one id.
        outstanding.set(idKey(message.id), {
          waiting: new Set(children),
          answers: new Map(),
          cancellable: false,
          done: (answers) => {
            // In config order, whatever order the answers came in.
            const ordered = children.map((child) => {
              const answer = answers.get(child) as Message
              child.pulls = Boolean(capabilitiesOf(answer.result).diagnosticProvider)
              return answer
            })
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
        })
        for (const child of children) {
          const options = child.config.initializationOptions
          const params =
            options === undefined
              ? message.params
              : { ...recordOf(message.params), initializationOptions: options }
          toChildren([child], { ...message, params })
        }
        return
      }
      if (method === 'shutdown') {
        exiting = true
        ask(children, message, () => toClient({ jsonrpc: '2.0', id: message.id, result: null }))
        return
      }
      const uri = uriOf(message)
      const child = uri === '' ? children[0] : claiming(uri)[0]
      if (child === undefined) {
        toClient({ jsonrpc: '2.0', id: message.id, result: null })
        return
      }
      ask([child], message, (answers) => toClient(answers.get(child) as Message), true)
    }

    const onClientNotification = (method: string, message: Message): void => {
      const uri = uriOf(message)
      const claimed = claiming(uri)
      if (method === 'textDocument/didOpen') {
        openFiles.set(fileKey(uri), uri)
        store.open(uri)
        const params = recordOf(message.params)
        for (const child of claimed) {
          toChildren([child], {
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
      } else if (DOCUMENT_SYNC.has(method)) {
        toChildren(claimed, message)
        if (method === 'textDocument/didClose') {
          // A child that only answers pulls never clears its list, so the
          // union for a closed file would keep it.
          openFiles.delete(fileKey(uri))
          store.forget(uri)
        }
      } else if (method === '$/cancelRequest') {
        const entry = outstanding.get(idKey(recordOf(message.params).id))
        if (entry?.cancellable) toChildren([...entry.waiting], message)
      } else {
        toChildren(children, message)
      }
      if (PULL_AFTER.has(method)) for (const child of claimed) if (child.pulls) pull(child, uri)
      if (method === 'initialized') {
        for (const child of children) {
          if (child.config.settings === undefined) continue
          toChildren([child], {
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
        const asked = fromChildren.get(key)
        if (asked === undefined) return
        fromChildren.delete(key)
        toChildren([asked.child], { ...message, id: asked.id })
        return
      }
      if (message.id === undefined) onClientNotification(message.method, message)
      else onClientRequest(message.method, message)
    }

    const onChild = (child: Child, message: Message): void => {
      const key = idKey(message.id)
      if (typeof message.method !== 'string') {
        // A response. Only the child that was asked may answer.
        const entry = outstanding.get(key)
        if (!entry?.waiting.delete(child)) return
        entry.answers.set(child, message)
        if (entry.waiting.size > 0) return
        outstanding.delete(key)
        entry.done(entry.answers)
        return
      }
      if (message.method === 'workspace/diagnostic/refresh' && message.id !== undefined) {
        // Claude Code never pulls, so the proxy answers and pulls itself.
        toChildren([child], { jsonrpc: '2.0', id: message.id, result: null })
        for (const uri of openFiles.values()) if (claims(child.config, uri)) pull(child, uri)
        return
      }
      if (message.id !== undefined) {
        const id = nextId()
        fromChildren.set(idKey(id), { child, id: message.id })
        toClient({ ...message, id })
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
      // After `finish`, each exit is one that `finish` itself caused.
      if (finished) return
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
    edges.input.on('end', () => finish(0))
  })
}
