// url.ts's own claims, against the fixtures captured from
// `scripts/mermaid-url.py` before it was deleted (fixtures/GENERATED.md).
//
// Parity ruling (maintainer, 2026-09-20): parity is of MEANING, not of the
// URL string, since node's zlib build compresses the same bytes differently
// from Python's. So a fixture is never compared to a URL string: every "ok"
// case is inflated back to the state object and compared at two levels, the
// outer object and its `mermaid` value, which is JSON inside JSON; every
// "refused" case is compared by exit status, since the wording is this
// port's own (the args.ts refusal path is Python's `argparse` wording, and
// this one is not, and neither is required to match it).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { exitCodeFor } from '../lib/envelope.ts'
import { runMermaidUrl } from './url.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

interface OkFixture {
  readonly name: string
  readonly args: readonly string[]
  readonly stdinBytes: readonly number[]
  readonly outcome: 'ok'
  readonly urlPrefix: string
  readonly outerState: { readonly code: string; readonly mermaid: string }
  readonly mermaidConfig: Record<string, unknown>
}

interface RefusedFixture {
  readonly name: string
  readonly args: readonly string[]
  readonly stdinBytes: readonly number[]
  readonly outcome: 'refused'
  readonly status: number
}

type Fixture = OkFixture | RefusedFixture

const fixtureFiles = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .sort()

const fixtures: readonly Fixture[] = fixtureFiles.map(
  (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Fixture,
)

// A fixture set that quietly shrank to zero would pass this describe.each
// while proving nothing (the same guard tests/repo.ts carries for plugins).
if (fixtures.length === 0) throw new Error(`no fixtures found under ${FIXTURES}`)

/** Inflate and parse what `buildUrl` produced, at both levels. */
function decodePayload(url: string, prefix: string): { code: string; mermaid: unknown } {
  expect(url.startsWith(prefix)).toBe(true)
  const payload = url.slice(prefix.length)
  const inflated = inflateSync(Buffer.from(payload, 'base64url'))
  const state = JSON.parse(inflated.toString('utf8')) as { code: string; mermaid: string }
  return { code: state.code, mermaid: JSON.parse(state.mermaid) }
}

describe('runMermaidUrl against the Python parity fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const stdin = Uint8Array.from(fixture.stdinBytes)
      const envelope = runMermaidUrl(fixture.args, stdin)

      if (fixture.outcome === 'ok') {
        expect(envelope.outcome).toBe('ok')
        if (envelope.outcome !== 'ok') return // narrows for tsc; unreachable given the assertion above
        const decoded = decodePayload(envelope.value, fixture.urlPrefix)
        expect(decoded.code).toBe(fixture.outerState.code)
        expect(decoded.mermaid).toEqual(fixture.mermaidConfig)
      } else {
        expect(envelope.outcome).toBe('refused')
        expect(exitCodeFor(envelope)).toBe(fixture.status)
      }
    })
  }
})

// One divergence a fixture cannot carry, because it was never asked of the
// Python: what this port trims that `mermaid-url.py` did not, and the other
// way around. Python's `str.strip()` also removes `\x1c` to `\x1f` (the
// information separator controls); JS's `String.prototype.trim()` does not,
// so those characters at either edge survive here and would not have
// survived there. Stated and pinned rather than patched around, since
// matching it would mean hand-writing a stripper this repository would then
// own (url.ts's own comment on `decodeAndTrim`).
it('keeps \\x1c to \\x1f at the edges, where Python would have stripped them', () => {
  const diagram = '\x1cgraph TD; A-->B\x1f'
  const envelope = runMermaidUrl(['--route', 'view'], new TextEncoder().encode(diagram))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  const decoded = decodePayload(envelope.value, 'https://mermaid.live/view#pako:')
  expect(decoded.code).toBe(diagram)
})

it('refuses invalid UTF-8 without the message depending on TextDecoder internals', () => {
  const envelope = runMermaidUrl(['--route', 'view'], Uint8Array.from([0x61, 0xff, 0x62]))

  expect(envelope).toEqual({
    outcome: 'refused',
    error: 'diagram source is not valid UTF-8',
  })
})

it('reports exit 2 for a refused argv, and never runs the encoder', () => {
  // Distinct from the unknown-route fixture: this asserts the args.ts arm
  // fires before any stdin is even looked at, which the fixture (a bad
  // route on valid stdin) does not by itself prove apart from stdin's
  // presence.
  const envelope = runMermaidUrl(['--route', 'view', '--theme'], new TextEncoder().encode('x'))

  expect(envelope.outcome).toBe('refused')
  expect(exitCodeFor(envelope)).toBe(2)
})
