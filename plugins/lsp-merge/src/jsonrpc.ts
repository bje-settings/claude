// The LSP base protocol: JSON-RPC messages, each one after a
// `Content-Length` header. Claude Code and each child server speak it on
// stdio. This file only frames and unframes. It makes no routing decision.
//
// Spec: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol

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

/** The message that `body` holds. Anything that is not a JSON object is
 *  not a JSON-RPC message. */
const parseBody = (body: string): Message => {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new FramingError(`body is not JSON: ${JSON.stringify(body.slice(0, 80))}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FramingError(`body is not a JSON object: ${JSON.stringify(body.slice(0, 80))}`)
  }
  return value as Message
}

export const createDecoder = (): Decoder => {
  let buffer = Buffer.alloc(0)
  return {
    push: (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const messages: Message[] = []
      for (;;) {
        const end = buffer.indexOf(SEPARATOR)
        if (end < 0) return messages
        const length = contentLength(buffer.subarray(0, end).toString('ascii'))
        const start = end + SEPARATOR.length
        if (buffer.length < start + length) return messages
        messages.push(parseBody(buffer.subarray(start, start + length).toString('utf8')))
        buffer = buffer.subarray(start + length)
      }
    },
  }
}
