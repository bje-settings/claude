// The diagnostic union. Each child pushes `textDocument/publishDiagnostics`
// for a file, and each push replaces that child's earlier list for the
// file. Claude Code also replaces its list for a file on each push. So the
// proxy keeps the last list of each child for each file, and pushes the
// union of all of them each time one child pushes.

/** The params of one `textDocument/publishDiagnostics` notification. */
export interface PublishParams {
  readonly uri: string
  readonly diagnostics: readonly Record<string, unknown>[]
}

export interface DiagnosticStore {
  /** Record the push of `child`, and return the params to send on. */
  update(child: string, params: PublishParams): PublishParams
}

/** Claude Code shows `source` after each message. When a child leaves it
 *  out, the child's name tells the reader which server found it. */
const withSource = (child: string, diagnostic: Record<string, unknown>): Record<string, unknown> =>
  typeof diagnostic.source === 'string' && diagnostic.source !== ''
    ? diagnostic
    : { ...diagnostic, source: child }

export const createDiagnosticStore = (): DiagnosticStore => {
  const byUri = new Map<string, Map<string, readonly Record<string, unknown>[]>>()
  return {
    update: (child, params) => {
      const byChild = byUri.get(params.uri) ?? new Map<string, readonly Record<string, unknown>[]>()
      byUri.set(params.uri, byChild)
      byChild.set(
        child,
        params.diagnostics.map((diagnostic) => withSource(child, diagnostic)),
      )
      return { uri: params.uri, diagnostics: [...byChild.values()].flat() }
    },
  }
}
