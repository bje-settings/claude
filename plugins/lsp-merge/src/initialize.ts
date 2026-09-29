// The one `initialize` result that Claude Code sees, made from the result
// of each child.
//
// Document sync is always full (ADR 006). Each `didChange` then carries the
// whole text, and every child accepts a whole-text change, whatever sync
// kind it asked for. So the proxy keeps no copy of any document.
//
// For each other capability, the first child in config order that declares
// it gives the value. A request goes to the primary child for its file. If
// that child lacks the capability, it answers with an error or `null`, and
// the proxy sends that answer on.

import { recordOf } from './jsonrpc.ts'

/** Full sync, open and close, and save without text. */
export const TEXT_DOCUMENT_SYNC = {
  openClose: true,
  change: 1,
  save: { includeText: false },
} as const

/** Claude Code never pulls diagnostics. The proxy pulls from its children
 *  itself, and pushes the result, so it does not claim that it answers
 *  pulls (ADR 006). */
const DROPPED = new Set(['textDocumentSync', 'diagnosticProvider'])

/** The capabilities in one `initialize` result, or none. */
export const capabilitiesOf = (result: unknown): Record<string, unknown> =>
  recordOf(recordOf(result).capabilities)

/** Merge the `initialize` results of the children, in config order. */
export const mergeInitializeResults = (results: readonly unknown[]): Record<string, unknown> => {
  const capabilities: Record<string, unknown> = {}
  for (const result of results) {
    for (const [key, value] of Object.entries(capabilitiesOf(result))) {
      if (DROPPED.has(key) || value === undefined || value === null || value === false) continue
      if (!(key in capabilities)) capabilities[key] = value
    }
  }
  capabilities.textDocumentSync = TEXT_DOCUMENT_SYNC
  return { capabilities, serverInfo: { name: 'lsp-merge' } }
}
