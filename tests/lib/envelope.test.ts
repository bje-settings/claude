// Tests for the envelope's own claims. Each row is a decision arm. A caller
// responds differently to a refusal than to a failure, and differently
// again to a payload. Each case is asserted, not derived from the others.
import { describe, expect, it } from 'vitest'

import {
  type Envelope,
  EXIT_CODES,
  exitCodeFor,
  failed,
  failedOnThrow,
  isOk,
  ok,
  refused,
  renderJson,
  renderText,
} from '#lib/envelope.ts'

describe('outcomes', () => {
  it('carries the value it was given', () => {
    expect(ok({ url: 'https://mermaid.live/view#pako:x' })).toEqual({
      outcome: 'ok',
      value: { url: 'https://mermaid.live/view#pako:x' },
    })
  })

  it('keeps a refusal and a failure apart', () => {
    // The distinction is the whole point of the two outcomes. A refusal
    // is the caller's input to fix, and a failure is this code's own
    // fault. A skill that reads the status decides differently on each.
    expect(refused('no diagram source on stdin')).toEqual({
      outcome: 'refused',
      error: 'no diagram source on stdin',
    })
    expect(failed('internal error: TypeError')).toEqual({
      outcome: 'failed',
      error: 'internal error: TypeError',
    })
  })

  it('maps each outcome onto the status its script used', () => {
    // 0, 2 and 1 are what `mermaid-url.py` exits with today: a URL, a refusal
    // it diagnosed, an internal error.
    expect(exitCodeFor(ok(null))).toBe(0)
    expect(exitCodeFor(refused('bad input'))).toBe(2)
    expect(exitCodeFor(failed('broken'))).toBe(1)
    expect(EXIT_CODES).toEqual({ ok: 0, failed: 1, refused: 2 })
  })

  it('narrows a success to its value', () => {
    const envelope: Envelope<number> = ok(7)
    expect(isOk(envelope)).toBe(true)
    // The narrowing is the point. To read `.value` off the union without it
    // is a type error. That error means a caller cannot treat an empty
    // result as a success.
    expect(isOk(envelope) ? envelope.value : 'unreachable').toBe(7)
    expect(isOk(refused('no'))).toBe(false)
  })
})

describe('renderJson', () => {
  it('writes the payload as one line of JSON', () => {
    expect(renderJson(ok({ repo: 'acme/widgets', open: 3 }))).toEqual({
      stdout: '{"repo":"acme/widgets","open":3}',
      stderr: '',
      exitCode: 0,
    })
  })

  it('leaves the trailing newline to the entry point', () => {
    // A renderer that embedded one would double-space the output of a
    // caller that writes through `console.log`.
    expect(renderJson(ok([1, 2])).stdout).toBe('[1,2]')
  })
})

describe('renderText', () => {
  it('writes the payload verbatim', () => {
    // `mermaid-url.py` prints a bare URL, and its skills read that line as
    // a URL. Rendered as JSON, it would arrive quoted and escaped: a
    // different contract, with the same exit code.
    const url = 'https://mermaid.live/view#pako:eNpLy8'
    expect(renderText(ok(url))).toEqual({ stdout: url, stderr: '', exitCode: 0 })
  })

  it('differs from renderJson on the one payload type both accept', () => {
    // The sentence above is a claim about `renderJson` too. A string is the
    // only payload both renderers take. So it is the only place the two
    // could quietly become the same function. Both are asserted on the
    // same value, so the test shows the difference, not two unrelated
    // examples.
    const url = 'https://mermaid.live/view#pako:eNpLy8'
    expect(renderJson(ok(url)).stdout).toBe(`"${url}"`)
    expect(renderText(ok(url)).stdout).toBe(url)
  })
})

describe.each([
  ['renderJson', renderJson],
  ['renderText', renderText],
])('%s on a failure', (_name, render) => {
  it('writes nothing to stdout, and the reason to stderr', () => {
    // This property matters. A caller that parses stdout can never read a
    // refusal as a result. There is nothing there to parse.
    expect(render(refused('no diagram source on stdin'))).toEqual({
      stdout: '',
      stderr: 'no diagram source on stdin',
      exitCode: 2,
    })
    expect(render(failed('internal error: TypeError'))).toEqual({
      stdout: '',
      stderr: 'internal error: TypeError',
      exitCode: 1,
    })
  })
})

describe('failedOnThrow', () => {
  const recorder = (): { text: string[]; write: (line: string) => boolean } => {
    const text: string[] = []
    return { text, write: (line) => text.push(line) > 0 }
  }

  it('passes a settled status through and writes nothing', async () => {
    const err = recorder()

    await expect(failedOnThrow(Promise.resolve(2), 'gh', err)).resolves.toBe(2)
    expect(err.text).toEqual([])
  })

  it('passes a null answer through, so an unknown command stays a refusal', async () => {
    const err = recorder()

    await expect(failedOnThrow(Promise.resolve(null), 'gh', err)).resolves.toBeNull()
    expect(err.text).toEqual([])
  })

  it('turns a thrown Error into one stderr line and exit 1', async () => {
    const err = recorder()

    await expect(failedOnThrow(Promise.reject(new Error('boom')), 'gh', err)).resolves.toBe(1)
    expect(err.text).toEqual(['gh: boom\n'])
  })

  it('writes a thrown value that is not an Error as text', async () => {
    const err = recorder()

    await expect(failedOnThrow(Promise.reject('bare'), 'gh', err)).resolves.toBe(1)
    expect(err.text).toEqual(['gh: bare\n'])
  })
})
