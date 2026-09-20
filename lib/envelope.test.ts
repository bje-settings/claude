// The envelope's own claims. Each row is a decision arm: a caller responds
// differently to a refusal than to a failure, and differently again to a
// payload, so each is asserted rather than derived from the others.
import { describe, expect, it } from 'vitest'

import {
  type Envelope,
  EXIT_CODES,
  exitCodeFor,
  failed,
  isOk,
  ok,
  refused,
  renderJson,
  renderText,
} from './envelope.ts'

describe('outcomes', () => {
  it('carries the value it was given', () => {
    expect(ok({ url: 'https://mermaid.live/view#pako:x' })).toEqual({
      outcome: 'ok',
      value: { url: 'https://mermaid.live/view#pako:x' },
    })
  })

  it('keeps a refusal and a failure apart', () => {
    // The distinction is the whole point of having two: a refusal is the
    // caller's input to fix and a failure is this code's, and a skill reading
    // the status decides differently on each.
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
    // The narrowing is the point: reading `.value` off the union without it
    // is a type error, which is what keeps an empty result from being read as
    // a successful one.
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
    // A renderer that embedded one would double-space the output of a caller
    // writing through `console.log`.
    expect(renderJson(ok([1, 2])).stdout).toBe('[1,2]')
  })
})

describe('renderText', () => {
  it('writes the payload verbatim', () => {
    // `mermaid-url.py` prints a bare URL and its skills read that line as a
    // URL. Rendered as JSON it would arrive quoted and escaped, which is a
    // different contract wearing the same exit code.
    const url = 'https://mermaid.live/view#pako:eNpLy8'
    expect(renderText(ok(url))).toEqual({ stdout: url, stderr: '', exitCode: 0 })
  })
})

describe.each([
  ['renderJson', renderJson],
  ['renderText', renderText],
])('%s on a failure', (_name, render) => {
  it('writes nothing to stdout, and the reason to stderr', () => {
    // The property worth pinning: a caller parsing stdout can never parse a
    // refusal into a result, because there is nothing there to parse.
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
