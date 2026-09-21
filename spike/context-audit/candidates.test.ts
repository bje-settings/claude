import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { candidatePairs } from './candidates.ts'
import type { BlockKind, Unit } from './types.ts'

let counter = 0
/** A `Unit` with every contract field filled, for tests that only care about
 *  `id`, `text` and (sometimes) `block`/`file`/`headingPath`. */
const makeUnit = (overrides: Partial<Unit> & { text: string }): Unit => {
  counter += 1
  return {
    id: `unit-${counter}`,
    file: 'CLAUDE.md',
    startLine: counter,
    endLine: counter,
    block: 'sentence' as BlockKind,
    headingPath: [],
    leadIn: null,
    prev: null,
    next: null,
    refs: [],
    ...overrides,
  }
}

describe('candidatePairs: basics', () => {
  it('pairs two units that share most of their vocabulary', () => {
    const a = makeUnit({ id: 'a', text: 'the retry policy backs off exponentially on failure' })
    const b = makeUnit({ id: 'b', text: 'the retry policy backs off exponentially every time' })
    const pairs = candidatePairs([a, b])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]?.a, 'a')
    assert.equal(pairs[0]?.b, 'b')
    assert.ok((pairs[0]?.similarity ?? 0) > 0.5)
  })

  it('does not pair units with disjoint vocabulary', () => {
    const a = makeUnit({ id: 'a', text: 'the retry policy backs off exponentially on failure' })
    const b = makeUnit({
      id: 'b',
      text: 'deploy previews expire after fourteen days automatically',
    })
    assert.deepEqual(candidatePairs([a, b]), [])
  })

  it('never pairs a unit with itself', () => {
    const a = makeUnit({ id: 'a', text: 'the retry policy backs off exponentially on failure' })
    const pairs = candidatePairs([a])
    assert.deepEqual(pairs, [])
  })

  it('emits each pair once, ordered a < b by id', () => {
    const z = makeUnit({
      id: 'z-unit',
      text: 'the retry policy backs off exponentially on failure',
    })
    const a = makeUnit({
      id: 'a-unit',
      text: 'the retry policy backs off exponentially every time',
    })
    const pairs = candidatePairs([z, a])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]?.a, 'a-unit')
    assert.equal(pairs[0]?.b, 'z-unit')
  })

  it('respects a lower threshold that the default would miss', () => {
    const a = makeUnit({ id: 'a', text: 'alpha shared bravo charlie' })
    const b = makeUnit({ id: 'b', text: 'shared delta echo foxtrot' })
    assert.deepEqual(candidatePairs([a, b]), [])
    const loose = candidatePairs([a, b], { threshold: 0.1 })
    assert.equal(loose.length, 1)
    assert.equal(loose[0]?.a, 'a')
    assert.equal(loose[0]?.b, 'b')
  })

  it('excludes a unit under four tokens entirely', () => {
    const short = makeUnit({ id: 'short', text: 'alpha shared bravo' })
    const long = makeUnit({ id: 'long', text: 'alpha shared bravo charlie delta' })
    assert.deepEqual(candidatePairs([short, long]), [])
  })
})

describe('candidatePairs: maxPerUnit', () => {
  it('caps how many pairs one unit appears in', () => {
    const hub = makeUnit({
      id: 'hub',
      text: 'retry policy backs off exponentially on network failure',
    })
    const partners = ['p1', 'p2', 'p3'].map((id) =>
      makeUnit({ id, text: 'retry policy backs off exponentially on network failure too' }),
    )
    const pairs = candidatePairs([hub, ...partners], { maxPerUnit: 2 })
    const hubPairs = pairs.filter((p) => p.a === 'hub' || p.b === 'hub')
    assert.equal(hubPairs.length, 2)
  })
})

describe('candidatePairs: repeated table cells', () => {
  const cell = (id: string, headingPath: string[]) =>
    makeUnit({
      id,
      block: 'table_row',
      file: 'CLAUDE.md',
      headingPath,
      text: 'Yes supports full automatic retries on failure',
    })

  it('does not pair identical cells from the same table', () => {
    const a = cell('a', ['Round history'])
    const b = cell('b', ['Round history'])
    assert.deepEqual(candidatePairs([a, b]), [])
  })

  it('pairs identical cells from different tables in the same file', () => {
    const a = cell('a', ['Round history'])
    const b = cell('b', ['Open items'])
    const pairs = candidatePairs([a, b])
    assert.equal(pairs.length, 1)
  })

  it('pairs identical text when neither unit is a table row', () => {
    const a = makeUnit({ id: 'a', text: 'Yes supports full automatic retries on failure' })
    const b = makeUnit({ id: 'b', text: 'Yes supports full automatic retries on failure' })
    const pairs = candidatePairs([a, b])
    assert.equal(pairs.length, 1)
  })
})

describe('candidatePairs: scales past naive O(n^2)', () => {
  it('finds one distinctive pair among a large corpus without a per-pair blowup', () => {
    const n = 20_000
    const units: Unit[] = []
    for (let i = 0; i < n; i++) {
      units.push(makeUnit({ id: `bg-${i}`, text: `commontoken bg${i}x bg${i}y bg${i}z` }))
    }
    units.push(
      makeUnit({
        id: 'special-0',
        text: 'commontoken distinctivematch1 distinctivematch2 distinctivematch3 specialown0',
      }),
    )
    units.push(
      makeUnit({
        id: 'special-1',
        text: 'commontoken distinctivematch1 distinctivematch2 distinctivematch3 specialown1',
      }),
    )

    const startedAt = Date.now()
    const pairs = candidatePairs(units)
    const elapsedMs = Date.now() - startedAt

    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]?.a, 'special-0')
    assert.equal(pairs[0]?.b, 'special-1')
    assert.ok((pairs[0]?.similarity ?? 0) > 0.5)
    // A regression to a full pairwise comparison over 20,002 units (about
    // 2*10^8 pairs) would not finish in anything close to this bound; the
    // inverted index finds this pair by construction (the shared,
    // low-document-frequency "distinctivematch*" tokens) without scanning
    // the "commontoken" postings list at all, since it is over the cap.
    assert.ok(elapsedMs < 5000, `expected under 5000ms, took ${elapsedMs}ms`)
  })
})
