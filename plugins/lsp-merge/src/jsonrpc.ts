// The LSP base protocol: JSON-RPC messages, each one after a
// `Content-Length` header. Claude Code and each child server speak it on
// stdio. This file only frames and unframes. It makes no routing decision.
//
// Spec: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol
import { isRecord } from './lib/typesafe.ts'

/** One JSON-RPC message: a request, a response, or a notification. */
export type Message = Record<string, unknown>

/** A byte stream that does not hold a valid LSP message. The proxy cannot
 *  continue on that stream, so the caller stops. */
export class FramingError extends Error {
  override name = 'FramingError'
}

const SEPARATOR = '\r\n\r\n'

/** `message` as bytes, with its header, ready to write to a stream. */
export const encode = (message: Message): Buffer => {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${SEPARATOR}`, 'ascii'), body])
}

/** A decoder for one stream. Give it each chunk as it arrives. It gives
 *  back each message that is now complete. A message can span chunks, and
 *  one chunk can hold several messages. */
export interface Decoder {
  push(chunk: Buffer): Message[]
}

/** The body length that `header` declares. Other header fields, such as
 *  `Content-Type`, are legal and have no effect here. */
const contentLength = (header: string): number => {
  const match = /^content-length: *(\d+) *$/im.exec(header)
  if (match === null)
    throw new FramingError(`no Content-Length in header: ${JSON.stringify(header)}`)
  return Number(match[1])
}

/** `value` when it is a JSON object, or an empty object. Each field of a
 *  message then reads as `undefined` when the sender left it out. */
export const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

/** The message that `body` holds. Anything that is not a JSON object is
 *  not a JSON-RPC message. */
const parseBody = (body: string): Message => {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new FramingError(`body is not JSON: ${JSON.stringify(body.slice(0, 80))}`)
  }
  if (!isRecord(value)) {
    throw new FramingError(`body is not a JSON object: ${JSON.stringify(body.slice(0, 80))}`)
  }
  return value
}

/** The chunks join only once a whole message is there, and the header is
 *  read once. A large body in many chunks then costs one copy, not one
 *  copy per chunk. */
export const createDecoder = (): Decoder => {
  let chunks: Buffer[] = []
  let size = 0
  /** Where the body starts and ends, once the header is read. */
  let body: { readonly start: number; readonly end: number } | null = null
  const joined = (): Buffer => {
    const all = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, size)
    chunks = [all]
    return all
  }
  return {
    push: (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      const messages: Message[] = []
      for (;;) {
        if (body === null) {
          const all = joined()
          const end = all.indexOf(SEPARATOR)
          if (end < 0) return messages
          const start = end + SEPARATOR.length
          body = { start, end: start + contentLength(all.subarray(0, end).toString('ascii')) }
        }
        if (size < body.end) return messages
        const all = joined()
        messages.push(parseBody(all.subarray(body.start, body.end).toString('utf8')))
        const rest = all.subarray(body.end)
        chunks = [rest]
        size = rest.length
        body = null
      }
    },
  }
}
