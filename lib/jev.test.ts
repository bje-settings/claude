// The Jev client's own tests (#173). An injected `fetch`, so nothing here
// touches the network and nothing needs a key (`typesafe.test.ts` already
// covers the transport itself: retries, redaction, usage; this file covers
// what `lib/jev.ts` adds on top of it).

import { expect, it } from 'vitest'
import {
  batchSections,
  classifyRequest,
  createJevClient,
  estimateTokens,
  parseClassification,
  shortId,
} from './jev.ts'

const KEY = 'sk-test-do-not-log-me'

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function unit(over: Partial<Parameters<typeof jevUnit>[0]> = {}): ReturnType<typeof jevUnit> {
  return jevUnit(over)
}

function jevUnit(over: {
  id?: string
  file?: string
  headingPath?: string[]
  leadIn?: string | null
  prev?: string | null
  next?: string | null
  text?: string
  refs?: { value: string }[]
}) {
  return {
    id: over.id ?? 'CLAUDE.md:1-1',
    file: over.file ?? 'CLAUDE.md',
    headingPath: over.headingPath ?? ['claude', 'Tests'],
    leadIn: over.leadIn ?? null,
    prev: over.prev ?? null,
    next: over.next ?? null,
    text: over.text ?? 'One command per language: `pnpm test` for TypeScript.',
    refs: over.refs ?? [],
  }
}

const CLASSIFICATION_ANSWERS_U0 = {
  kind__u0: {
    type: 'choice',
    choice: 'repo_fact',
    probabilities: { repo_fact: 1 },
    confidence: 0.9,
  },
  volatile__u0: { type: 'noul', noul: 0.1 },
  self_contained__u0: { type: 'noul', noul: 0.9 },
  evidence__u0: {
    type: 'choice',
    choice: 'config_value',
    probabilities: { config_value: 1 },
    confidence: 0.8,
  },
  multi_assertion__u0: { type: 'noul', noul: 0.05 },
}

it('classify of one unit sends the five per-unit questions and parses one Classification', async () => {
  const seen: { body?: string } = {}
  const client = createJevClient({
    apiKey: KEY,
    fetch: async (_url, init) => {
      seen.body = String(init?.body)
      return reply(200, {
        model: 'jev-1.13.0',
        answers: CLASSIFICATION_ANSWERS_U0,
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    },
  })

  const outcome = await client.classify([unit()], 'per_unit')

  const sent = JSON.parse(seen.body ?? '{}')
  expect(Object.keys(sent.questions)).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
  ])
  expect(outcome.failures).toEqual([])
  expect(outcome.classifications).toHaveLength(1)
  expect(outcome.classifications[0]?.unitId).toBe('CLAUDE.md:1-1')
  expect(outcome.classifications[0]?.kind.choice).toBe('repo_fact')
})

const ONE = unit({
  id: 'CLAUDE.md:148-149',
  text: 'One command per language: `pnpm test` for TypeScript.',
  refs: [{ value: 'pnpm test' }],
})

const TWO = unit({ id: 'CLAUDE.md:150-150', text: '`--locked` as in CI.' })

it('per_section sends one request per heading path, keyed by short id', () => {
  const other = unit({
    id: 'CLAUDE.md:199-199',
    text: 'lefthook, staged-only.',
    headingPath: ['claude', 'Git hooks'],
  })
  const requests = classifyRequest([ONE, TWO, other], 'per_section')

  expect(requests).toHaveLength(2)
  expect(requests[0]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    units: {
      u0: { text: ONE.text, refs: ['pnpm test'] },
      u1: { text: TWO.text },
    },
  })
  expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
    'kind__u1',
    'volatile__u1',
    'self_contained__u1',
    'evidence__u1',
    'multi_assertion__u1',
  ])
  expect(requests[1]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Git hooks'],
    units: { u2: { text: 'lefthook, staged-only.' } },
  })
})

it('per_section questions point at the unit by its backticked path', () => {
  const [request] = classifyRequest([ONE, TWO], 'per_section')
  const questions = request?.questions ?? {}
  const kind = questions.kind__u1 as unknown as { instructions: { question: string } }
  expect(kind.instructions.question).toBe('What kind of statement is `units.u1.text`?')
  const volatile = questions.volatile__u1 as unknown as { instructions: unknown }
  expect(String(volatile.instructions)).toMatch(/`units\.u1\.text`/)
})

it('a lead-in rides along only when the unit has one', () => {
  const led = unit({ id: 'a:1-1', text: 'ruff', leadIn: 'The required checks are:' })
  const [request] = classifyRequest([led], 'per_section')
  const state = (request as { state: { units: object } }).state
  expect(state.units).toEqual({
    u0: { text: 'ruff', lead_in: 'The required checks are:' },
  })
})

it('batchSections splits a section that does not fit', () => {
  const big = Array.from({ length: 6 }, (_, i) =>
    unit({ id: `CLAUDE.md:${i}-${i}`, text: 'x'.repeat(300), headingPath: ['one'] }),
  )
  // 300 characters is 100 tokens at the conservative estimate, so a 250-token
  // state budget holds two units and refuses the third.
  const sections = batchSections(big, { stateTokens: 250, requestTokens: 1_000_000 })
  expect(sections.map((section) => section.indexes)).toEqual([
    [0, 1],
    [2, 3],
    [4, 5],
  ])
})

it('batchSections splits when the repeated questions blow the request budget', () => {
  const many = Array.from({ length: 4 }, (_, i) =>
    unit({ id: `a:${i}-${i}`, text: 'short', headingPath: ['one'] }),
  )
  const sections = batchSections(many, { stateTokens: 1_000_000, requestTokens: 900 })
  expect(sections.length).toBeGreaterThan(1)
  expect(sections.flatMap((section) => section.indexes)).toEqual([0, 1, 2, 3])
})

it('the section key includes the file: a shared heading path across files still splits', () => {
  const lastOfA = unit({
    id: 'a.md:9-9',
    file: 'a.md',
    text: 'last unit of a.md',
    headingPath: ['Setup'],
  })
  const firstOfB = unit({
    id: 'b.md:1-1',
    file: 'b.md',
    text: 'first unit of b.md',
    headingPath: ['Setup'],
  })
  const sections = batchSections([lastOfA, firstOfB])
  expect(sections.map((section) => ({ file: section.file, indexes: section.indexes }))).toEqual([
    { file: 'a.md', indexes: [0] },
    { file: 'b.md', indexes: [1] },
  ])
})

it('units that share a key but are not neighbours in the array are not merged', () => {
  const first = unit({ id: 'a:1-1', text: 'first', headingPath: ['one'] })
  const between = unit({ id: 'a:2-2', text: 'between', headingPath: ['two'] })
  const later = unit({ id: 'a:3-3', text: 'later, same heading as first', headingPath: ['one'] })

  const sections = batchSections([first, between, later])

  expect(sections.map((section) => section.indexes)).toEqual([[0], [1], [2]])
})

it('a single unit over budget is still sent alone, never dropped or merged', () => {
  const oversized = unit({ id: 'a:1-1', text: 'x'.repeat(3_000), headingPath: ['one'] })
  const sections = batchSections([oversized], { stateTokens: 10, requestTokens: 10 })
  expect(sections).toEqual([{ file: 'CLAUDE.md', headingPath: ['one'], indexes: [0] }])
})

it('estimateTokens is conservative about prose', () => {
  expect(estimateTokens('abc')).toBe(1)
  expect(estimateTokens('a'.repeat(300))).toBe(100)
  expect(estimateTokens({ a: 'bb' })).toBe(Math.ceil('{"a":"bb"}'.length / 3))
})

it('shortId is the unit index', () => {
  expect(shortId(0)).toBe('u0')
  expect(shortId(11)).toBe('u11')
})

it('per_unit sends one request per unit, with that unit as the whole state', () => {
  const requests = classifyRequest([ONE, TWO], 'per_unit')

  expect(requests).toHaveLength(2)
  expect(requests[0]?.state).toEqual({
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    lead_in: null,
    prev: null,
    text: 'One command per language: `pnpm test` for TypeScript.',
    next: null,
    refs: ['pnpm test'],
  })
  expect(Object.keys(requests[0]?.questions ?? {})).toEqual([
    'kind__u0',
    'volatile__u0',
    'self_contained__u0',
    'evidence__u0',
    'multi_assertion__u0',
  ])
  expect(Object.keys(requests[1]?.questions ?? {})).toEqual([
    'kind__u1',
    'volatile__u1',
    'self_contained__u1',
    'evidence__u1',
    'multi_assertion__u1',
  ])
})

it('parseClassification reads a canned response into the contract type', () => {
  const answers = {
    kind__u0: {
      type: 'choice',
      choice: 'repo_fact',
      probabilities: { repo_fact: 0.7, instruction: 0.3 },
      confidence: 0.62,
    },
    volatile__u0: { type: 'noul', noul: 0.12 },
    self_contained__u0: { type: 'noul', noul: 0.88 },
    evidence__u0: {
      type: 'choice',
      choice: 'config_value',
      probabilities: { config_value: 0.9, file_contents: 0.1 },
      confidence: 0.85,
    },
    multi_assertion__u0: { type: 'noul', noul: 0.04 },
  }

  const [parsed] = parseClassification([ONE], answers)

  expect(parsed?.unitId).toBe('CLAUDE.md:148-149')
  expect(parsed?.kind.choice).toBe('repo_fact')
  expect(parsed?.kind.confidence).toBe(0.62)
  // Options the response left out come back as 0, so the record is total.
  expect(parsed?.kind.probabilities).toEqual({
    repo_fact: 0.7,
    external_fact: 0,
    instruction: 0.3,
    rationale: 0,
    history: 0,
    pointer: 0,
    structural: 0,
  })
  expect(parsed?.volatile).toBe(0.12)
  expect(parsed?.selfContained).toBe(0.88)
  expect(parsed?.evidenceNeed.choice).toBe('config_value')
  expect(parsed?.multiAssertion).toBe(0.04)
})

const GOOD_ANSWERS = {
  kind__u0: { type: 'choice', choice: 'repo_fact', probabilities: { repo_fact: 1 }, confidence: 1 },
  volatile__u0: { type: 'noul', noul: 0 },
  self_contained__u0: { type: 'noul', noul: 0 },
  evidence__u0: {
    type: 'choice',
    choice: 'config_value',
    probabilities: { config_value: 1 },
    confidence: 1,
  },
  multi_assertion__u0: { type: 'noul', noul: 0 },
}

it('parseClassification refuses an answer of the wrong type or an unknown option', () => {
  expect(() =>
    parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul' } }),
  ).toThrow(/no noul answer/)
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, kind__u0: undefined })).toThrow(
    /no choice answer/,
  )
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { ...GOOD_ANSWERS.kind__u0, choice: 'invented' },
    }),
  ).toThrow(/not one of the options/)
})

it('a noul outside 0 to 1 is refused, not clamped, and reported as out of range', () => {
  expect(() =>
    parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul', noul: 1.5 } }),
  ).toThrow(/out of range: 1\.5/)
})

it('a non-finite noul is reported as out of range too, not as missing', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      volatile__u0: { type: 'noul', noul: Number.NaN },
    }),
  ).toThrow(/out of range/)
})

it('an array does not pass readChoice as an object', () => {
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, kind__u0: ['repo_fact'] })).toThrow(
    /no choice answer/,
  )
})

it('an array does not pass readNoul as an object', () => {
  expect(() => parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: [0.5] })).toThrow(
    /no noul answer/,
  )
})

it('a choice missing the probability for its own answer is refused, not defaulted to 0', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { type: 'choice', choice: 'repo_fact', probabilities: {}, confidence: 1 },
    }),
  ).toThrow(/no probability for its own choice repo_fact/)
})

it('a non-finite probability on a non-chosen option is refused', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: {
        type: 'choice',
        choice: 'repo_fact',
        probabilities: { repo_fact: 1, instruction: Number.NaN },
        confidence: 1,
      },
    }),
  ).toThrow(/non-finite probability for instruction/)
})

it('a NaN confidence is refused, not passed through as a valid number', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: { ...GOOD_ANSWERS.kind__u0, confidence: Number.NaN },
    }),
  ).toThrow(/no choice answer/)
})

it('a probability of 42 is refused, not accepted as a raw score', () => {
  expect(() =>
    parseClassification([ONE], {
      ...GOOD_ANSWERS,
      kind__u0: {
        type: 'choice',
        choice: 'repo_fact',
        probabilities: { repo_fact: 42 },
        confidence: 1,
      },
    }),
  ).toThrow(/probability out of range for repo_fact: 42/)
})
