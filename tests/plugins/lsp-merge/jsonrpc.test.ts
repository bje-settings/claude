import { describe, expect, it } from 'vitest'
import { createDecoder, encode, FramingError } from '#lsp-merge/jsonrpc.ts'

describe('encode', () => {
  it('puts the byte length, not the character length, in the header', () => {
    const bytes = encode({ jsonrpc: '2.0', method: 'x', params: { text: 'é✓' } })
    const text = bytes.toString('utf8')
    const [header, body] = text.split('\r\n\r\n')

    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body as string, 'utf8')}`)
    expect(JSON.parse(body as string)).toEqual({
      jsonrpc: '2.0',
      method: 'x',
      params: { text: 'é✓' },
    })
  })
})

describe('createDecoder', () => {
  it('gives back a message that spans several chunks, once it is complete', () => {
    const bytes = encode({ id: 1, result: 'é✓' })
    const decoder = createDecoder()

    expect(decoder.push(bytes.subarray(0, 10))).toEqual([])
    expect(decoder.push(bytes.subarray(10, bytes.length - 2))).toEqual([])
    expect(decoder.push(bytes.subarray(bytes.length - 2))).toEqual([{ id: 1, result: 'é✓' }])
  })

  it('gives back every message in one chunk, in order', () => {
    const decoder = createDecoder()

    expect(decoder.push(Buffer.concat([encode({ id: 1 }), encode({ id: 2 })]))).toEqual([
      { id: 1 },
      { id: 2 },
    ])
  })

  it('accepts other header fields and any case', () => {
    const body = '{"id":3}'
    const decoder = createDecoder()

    expect(
      decoder.push(
        Buffer.from(
          `content-type: application/vscode-jsonrpc\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
        ),
      ),
    ).toEqual([{ id: 3 }])
  })

  it('refuses a header with no length', () => {
    expect(() => createDecoder().push(Buffer.from('X: 1\r\n\r\n{}'))).toThrow(FramingError)
  })

  it('refuses a body that is not JSON', () => {
    expect(() => createDecoder().push(Buffer.from('Content-Length: 5\r\n\r\nnope!'))).toThrow(
      /body is not JSON/,
    )
  })

  it('refuses a body that is JSON but not an object', () => {
    expect(() => createDecoder().push(Buffer.from('Content-Length: 2\r\n\r\n[]'))).toThrow(
      /not a JSON object/,
    )
    expect(() => createDecoder().push(Buffer.from('Content-Length: 4\r\n\r\nnull'))).toThrow(
      /not a JSON object/,
    )
  })
})
