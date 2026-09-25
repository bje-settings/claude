// url.ts's own claims, against the fixtures captured from
// `scripts/mermaid-url.py` before it was deleted (fixtures/GENERATED.md).
//
// Parity ruling (maintainer, 2026-09-20): parity is of MEANING, not of the
// URL string. Node's zlib build compresses the same bytes differently from
// Python's. So a fixture is never compared to a URL string. Every "ok"
// case is inflated back to the state object. The comparison checks two
// levels: the outer object, and its `mermaid` value, which is JSON inside
// JSON.
//
// Every "refused" case is compared by exit status. Only the status (2)
// matches Python's `argparse` convention (lib/args.ts, lib/README.md). The
// message text is this port's own throughout. It is never required to
// match argparse's wording.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
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

// A fixture set that quietly shrank to zero would pass this describe.each,
// and prove nothing. tests/repo.ts carries the same guard for plugins.
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
// Python. It is what this port trims that `mermaid-url.py` did not, and
// the other way around. Python's `str.strip()` also removes `\x1c` to
// `\x1f` (the information separator controls). JS's `String.prototype.trim()`
// does not remove them. So those characters at either edge survive here.
// They would not have survived there.
//
// This is stated and pinned, instead of a workaround. To match it here
// would mean this repository writes its own stripper by hand. This
// repository would then own that code (url.ts's own comment on
// `decodeAndTrim`).
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
  // This is distinct from the unknown-route fixture. This test asserts
  // that the args.ts arm fires before any stdin is even looked at. The
  // fixture (a bad route on valid stdin) does not prove that by itself,
  // apart from stdin's presence.
  const envelope = runMermaidUrl(['--route', 'view', '--theme'], new TextEncoder().encode('x'))

  expect(envelope.outcome).toBe('refused')
  expect(exitCodeFor(envelope)).toBe(2)
})

it('answers --help with a usage line and never looks at stdin', () => {
  // Invalid UTF-8 on stdin would refuse, if decodeAndTrim ran at all. So a
  // passing 'ok' here also proves that --help is checked before stdin is
  // touched.
  const envelope = runMermaidUrl(['--help'], Uint8Array.from([0x61, 0xff, 0x62]))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  expect(envelope.value).toMatch(/^mermaid\.ts \[--route /)
})

it('recognizes -h as well as --help, the way argparse auto-adds both', () => {
  const envelope = runMermaidUrl(['-h'], new TextEncoder().encode('x'))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  expect(envelope.value).toMatch(/^mermaid\.ts \[--route /)
})

it('answers --help even with a --route parseArguments would refuse, and never parses argv at all', () => {
  // Without the wantsHelp pre-scan, parseArguments would see --route bogus
  // first. It would refuse with exit 2 before --help was ever read off
  // parsed values. Usage must win. This matches how argparse resolves -h:
  // the instant it sees -h, before it checks anything else on the line.
  const envelope = runMermaidUrl(['--help', '--route', 'bogus'], new TextEncoder().encode('x'))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  expect(envelope.value).toMatch(/^mermaid\.ts \[--route /)
})

it('names the four routes alphabetised in a bad --route refusal', () => {
  // This pins url.ts's own comment claim (ROUTE_PREFIXES is "alphabetised:
  // the same order Python's argparse reports them in"). The message text
  // is this port's own (see the divergence note). But the order the routes
  // are named in is not incidental.
  const envelope = runMermaidUrl(['--route', 'bogus'], new TextEncoder().encode('x'))

  expect(envelope).toEqual({
    outcome: 'refused',
    error: '--route must be one of edit, ink-img, ink-svg, view, not "bogus"',
  })
})

it('defaults to --route view when no route is given at all', () => {
  const envelope = runMermaidUrl([], new TextEncoder().encode('graph TD; A-->B'))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  expect(envelope.value.startsWith('https://mermaid.live/view#pako:')).toBe(true)
})

it('strips a leading and trailing BOM, the one direction trim() goes further than Python', () => {
  // The other direction (\x1c-\x1f) is pinned above. This is the other
  // half of the same divergence (url.ts's decodeAndTrim comment). trim()
  // treats U+FEFF as whitespace. So a BOM at either edge is gone by the
  // time this reaches the encoder, unlike Python's `strip()`.
  const diagram = '﻿graph TD; A-->B﻿'
  const envelope = runMermaidUrl(['--route', 'view'], new TextEncoder().encode(diagram))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  const decoded = decodePayload(envelope.value, 'https://mermaid.live/view#pako:')
  expect(decoded.code).toBe('graph TD; A-->B')
})

it('compresses at zlib level 9, not whatever node defaults to', () => {
  // A fixture cannot pin this: every fixture assertion inflates and compares
  // parsed values, which are identical at any compression level. This value
  // is computed fresh in this test, against whatever node/zlib build runs
  // it, rather than a hardcoded byte count. So this holds on the floor
  // leg's node 22.18.0 too. That build may differ from the machine that
  // wrote this test.
  const diagram = `graph TD; ${'A-->B; '.repeat(80)}`
  const envelope = runMermaidUrl(['--route', 'view'], new TextEncoder().encode(diagram))

  expect(envelope.outcome).toBe('ok')
  if (envelope.outcome !== 'ok') return
  const prefix = 'https://mermaid.live/view#pako:'
  expect(envelope.value.startsWith(prefix)).toBe(true)
  const actualLength = Buffer.from(envelope.value.slice(prefix.length), 'base64url').length

  const state = JSON.stringify({ code: diagram, mermaid: JSON.stringify({ theme: 'default' }) })
  const stateBytes = Buffer.from(state, 'utf8')
  const level1Length = deflateSync(stateBytes, { level: 1 }).length
  const level9Length = deflateSync(stateBytes, { level: 9 }).length
  // This is a sanity check that this diagram is repetitive enough for the
  // level to actually matter. A diagram short enough to compress identically
  // at every level would make the assertion below pass for the wrong
  // reason.
  expect(level1Length).toBeGreaterThan(level9Length)
  expect(actualLength).toBe(level9Length)
})
