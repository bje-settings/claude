// The diagnostic union. Each child pushes `textDocument/publishDiagnostics`
// for a file, or answers a pull, and each list replaces that child's earlier
// list for the file. Claude Code also replaces its list for a file on each
// push. So the proxy keeps the last list of each child for each file, and
// pushes the union of all of them each time one list changes.
import { fileURLToPath } from 'node:url'

/** The params of one `textDocument/publishDiagnostics` notification. */
export interface PublishParams {
  readonly uri: string
  readonly diagnostics: readonly Record<string, unknown>[]
}

export interface DiagnosticStore {
  /** Record `uri` as the spelling Claude Code uses for its file. Each push
   *  for the file then uses it. */
  open(uri: string): void
  /** Record the list of `child`, and return the params to send on. */
  update(child: string, params: PublishParams): PublishParams
  /** Drop every list for the file `uri` names. */
  forget(uri: string): void
}

/** One key for each file, however a server spells its URI. A server can
 *  write `%40` where Claude Code writes `@`, or `C:` where it writes `c%3A`.
 *  A URI that is not a file URI is its own key. */
export const fileKey = (uri: string): string => {
  let file: string
  try {
    file = fileURLToPath(uri)
  } catch {
    return uri
  }
  return file.replace(
    /^([\\/]?)([A-Za-z]):/,
    (_, slash: string, drive: string) => `${slash}${drive.toLowerCase()}:`,
  )
}

/** Claude Code shows `source` after each message. When a child leaves it
 *  out, the child's name tells the reader which server found it. */
const withSource = (child: string, diagnostic: Record<string, unknown>): Record<string, unknown> =>
  typeof diagnostic.source === 'string' && diagnostic.source !== ''
    ? diagnostic
    : { ...diagnostic, source: child }

interface FileEntry {
  uri: string
  readonly byChild: Map<string, readonly Record<string, unknown>[]>
}

export const createDiagnosticStore = (): DiagnosticStore => {
  const files = new Map<string, FileEntry>()
  const entry = (uri: string): FileEntry => {
    const key = fileKey(uri)
    const found = files.get(key) ?? { uri, byChild: new Map() }
    files.set(key, found)
    return found
  }
  return {
    open: (uri) => {
      entry(uri).uri = uri
    },
    update: (child, params) => {
      const file = entry(params.uri)
      file.byChild.set(
        child,
        params.diagnostics.map((diagnostic) => withSource(child, diagnostic)),
      )
      return { uri: file.uri, diagnostics: [...file.byChild.values()].flat() }
    },
    forget: (uri) => {
      files.delete(fileKey(uri))
    },
  }
}
