// The question builders' tests (#164, spike). No network: these are pure
// functions, so a test can assert the request body byte for byte and the
// parse against a canned response.
//
// The rubric prose is deliberately NOT asserted word for word. It is the part
// of the spike that gets rewritten against smoke results, and a test that
// pins it would fail on every iteration while proving nothing. What is
// asserted instead is everything a caller or the API depends on: the state,
// the question ids, the types, the option sets, and the backticked state path
// each question points at, which is the one piece of prose that has to track
// the state's shape.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  batchSections,
  classifyRequest,
  EVIDENCE_QUESTION_ID,
  estimateTokens,
  evidenceRequest,
  PAIR_QUESTION_ID,
  pairRequest,
  parseClassification,
  parseEvidence,
  parsePair,
  shortId,
} from './questions.ts'
import type { Unit } from './types.ts'

/** Narrow away the `undefined` that `noUncheckedIndexedAccess` adds, with a failure if it is real. */
function defined<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} should exist`)
  return value
}

function unit(over: Partial<Unit> & Pick<Unit, 'id' | 'text'>): Unit {
  return {
    file: 'CLAUDE.md',
    startLine: 1,
    endLine: 1,
    block: 'sentence',
    headingPath: ['claude', 'Tests'],
    leadIn: null,
    prev: null,
    next: null,
    refs: [],
    ...over,
  }
}

const ONE = unit({
  id: 'CLAUDE.md:148-149',
  startLine: 148,
  endLine: 149,
  text: 'One command per language: `pnpm test` for TypeScript.',
  leadIn: null,
  prev: null,
  next: '`--locked` as in CI.',
  refs: [
    {
      kind: 'command',
      value: 'pnpm test',
      resolution: { status: 'unchecked', reason: 'not_resolved_yet' },
    },
  ],
})

const TWO = unit({
  id: 'CLAUDE.md:150-150',
  startLine: 150,
  endLine: 150,
  text: '`--locked` as in CI, so a stale `uv.lock` fails rather than being rewritten.',
  prev: ONE.text,
})

const QUESTION_NAMES = ['kind', 'volatile', 'self_contained', 'evidence', 'multi_assertion']

test('per_unit sends one request per unit, with that unit as the whole state', () => {
  const requests = classifyRequest([ONE, TWO], { shape: 'per_unit' })

  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0]?.state, {
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    lead_in: null,
    prev: null,
    text: 'One command per language: `pnpm test` for TypeScript.',
    next: '`--locked` as in CI.',
    refs: ['pnpm test'],
  })
  assert.deepEqual(
    Object.keys(requests[0]?.questions ?? {}),
    QUESTION_NAMES.map((name) => `${name}__u0`),
  )
  assert.deepEqual(
    Object.keys(requests[1]?.questions ?? {}),
    QUESTION_NAMES.map((name) => `${name}__u1`),
  )
})

test('per_unit questions point at the top-level `text`', () => {
  const [request] = classifyRequest([ONE], { shape: 'per_unit' })
  const questions = request?.questions ?? {}

  const kind = defined(questions.kind__u0, 'kind__u0')
  assert.equal(kind.type, 'choice')
  assert.deepEqual(
    (kind.instructions as { question: string }).question,
    'What kind of statement is `text`?',
  )
  assert.deepEqual(Object.keys((kind as { criteria: object }).criteria), [
    'repo_fact',
    'external_fact',
    'instruction',
    'rationale',
    'history',
    'pointer',
    'structural',
  ])

  const evidence = questions.evidence__u0
  assert.equal(evidence?.type, 'choice')
  assert.deepEqual(Object.keys((evidence as { criteria: object }).criteria), [
    'file_exists',
    'file_contents',
    'config_value',
    'github_state',
    'nothing_local',
  ])

  for (const name of ['volatile', 'self_contained', 'multi_assertion']) {
    const question = questions[`${name}__u0`]
    assert.equal(question?.type, 'noul', `${name} should be a noul`)
    assert.match(String(question?.instructions), /`text`/)
    assert.ok('criteria' in (question ?? {}), `${name} should carry true/false criteria`)
  }
})

test('per_section sends one request per heading path, keyed by short id', () => {
  const other = unit({
    id: 'CLAUDE.md:199-199',
    text: 'lefthook, staged-only.',
    headingPath: ['claude', 'Git hooks'],
  })
  const requests = classifyRequest([ONE, TWO, other], { shape: 'per_section' })

  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0]?.state, {
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Tests'],
    units: {
      u0: { text: ONE.text, refs: ['pnpm test'] },
      u1: { text: TWO.text },
    },
  })
  assert.deepEqual(Object.keys(requests[0]?.questions ?? {}), [
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
  assert.deepEqual(requests[1]?.state, {
    file: 'CLAUDE.md',
    heading_path: ['claude', 'Git hooks'],
    units: { u2: { text: 'lefthook, staged-only.' } },
  })
})

test('per_section questions point at the unit by its backticked path', () => {
  const [request] = classifyRequest([ONE, TWO], { shape: 'per_section' })
  const questions = request?.questions ?? {}
  assert.equal(
    (defined(questions.kind__u1, 'kind__u1').instructions as { question: string }).question,
    'What kind of statement is `units.u1.text`?',
  )
  assert.match(String(questions.volatile__u1?.instructions), /`units\.u1\.text`/)
})

test('a lead-in rides along only when the unit has one', () => {
  const led = unit({ id: 'a:1-1', text: 'ruff', leadIn: 'The required checks are:' })
  const [request] = classifyRequest([led], { shape: 'per_section' })
  assert.deepEqual((defined(request, 'request').state as { units: object }).units, {
    u0: { text: 'ruff', lead_in: 'The required checks are:' },
  })
})

test('per_unit is the default shape', () => {
  assert.equal(classifyRequest([ONE, TWO]).length, 2)
})

test('batchSections splits a section that does not fit', () => {
  const big = Array.from({ length: 6 }, (_, i) =>
    unit({ id: `CLAUDE.md:${i}-${i}`, text: 'x'.repeat(300), headingPath: ['one'] }),
  )
  // 300 characters is 100 tokens at the conservative estimate, so a 250-token
  // state budget holds two units and refuses the third.
  const sections = batchSections(big, { stateTokens: 250, requestTokens: 1_000_000 })
  assert.deepEqual(
    sections.map((section) => section.indexes),
    [
      [0, 1],
      [2, 3],
      [4, 5],
    ],
  )
})

test('batchSections splits when the repeated questions blow the request budget', () => {
  const many = Array.from({ length: 4 }, (_, i) =>
    unit({ id: `a:${i}-${i}`, text: 'short', headingPath: ['one'] }),
  )
  const sections = batchSections(many, { stateTokens: 1_000_000, requestTokens: 900 })
  assert.ok(sections.length > 1, 'the question cost should force a split')
  assert.deepEqual(
    sections.flatMap((section) => section.indexes),
    [0, 1, 2, 3],
  )
})

test('the section key includes the file: a shared heading path across files still splits', () => {
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
  assert.deepEqual(
    sections.map((section) => ({ file: section.file, indexes: section.indexes })),
    [
      { file: 'a.md', indexes: [0] },
      { file: 'b.md', indexes: [1] },
    ],
  )
})

test('units that share a key but are not neighbours in the array are not merged', () => {
  // Two units under the same heading path, with a unit from a different
  // heading path sitting between them: a caller could produce this by
  // filtering or reordering a document's real unit list.
  const first = unit({ id: 'a:1-1', text: 'first', headingPath: ['one'] })
  const between = unit({ id: 'a:2-2', text: 'between', headingPath: ['two'] })
  const later = unit({ id: 'a:3-3', text: 'later, same heading as first', headingPath: ['one'] })

  const sections = batchSections([first, between, later])

  assert.deepEqual(
    sections.map((section) => section.indexes),
    [[0], [1], [2]],
  )
})

test('a single unit over budget is still sent alone, never dropped or merged', () => {
  const oversized = unit({ id: 'a:1-1', text: 'x'.repeat(3_000), headingPath: ['one'] })
  const sections = batchSections([oversized], { stateTokens: 10, requestTokens: 10 })
  assert.deepEqual(sections, [{ file: 'CLAUDE.md', headingPath: ['one'], indexes: [0] }])
})

test('estimateTokens is conservative about prose', () => {
  assert.equal(estimateTokens('abc'), 1)
  assert.equal(estimateTokens('a'.repeat(300)), 100)
  assert.equal(estimateTokens({ a: 'bb' }), Math.ceil('{"a":"bb"}'.length / 3))
})

test('shortId is the unit index', () => {
  assert.equal(shortId(0), 'u0')
  assert.equal(shortId(11), 'u11')
})

test('parseClassification reads a canned response into the contract type', () => {
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

  assert.equal(parsed?.unitId, 'CLAUDE.md:148-149')
  assert.equal(parsed?.kind.choice, 'repo_fact')
  assert.equal(parsed?.kind.confidence, 0.62)
  // Options the response left out come back as 0, so the record is total.
  assert.deepEqual(parsed?.kind.probabilities, {
    repo_fact: 0.7,
    external_fact: 0,
    instruction: 0.3,
    rationale: 0,
    history: 0,
    pointer: 0,
    structural: 0,
  })
  assert.equal(parsed?.volatile, 0.12)
  assert.equal(parsed?.selfContained, 0.88)
  assert.equal(parsed?.evidenceNeed.choice, 'config_value')
  assert.equal(parsed?.multiAssertion, 0.04)
})

test('parseClassification refuses an answer of the wrong type or an unknown option', () => {
  const good = {
    kind__u0: {
      type: 'choice',
      choice: 'repo_fact',
      probabilities: { repo_fact: 1 },
      confidence: 1,
    },
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
  assert.throws(
    () => parseClassification([ONE], { ...good, volatile__u0: { type: 'noul' } }),
    /no noul answer/,
  )
  assert.throws(
    () => parseClassification([ONE], { ...good, kind__u0: undefined }),
    /no choice answer/,
  )
  assert.throws(
    () =>
      parseClassification([ONE], { ...good, kind__u0: { ...good.kind__u0, choice: 'invented' } }),
    /not one of the options/,
  )
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

test('a noul outside 0 to 1 is refused, not clamped, and reported as out of range', () => {
  assert.throws(
    () =>
      parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: { type: 'noul', noul: 1.5 } }),
    // The value is present, so the message should point at the value being
    // wrong, not read like the key is missing.
    /out of range: 1\.5/,
  )
})

test('a non-finite noul is reported as out of range too, not as missing', () => {
  assert.throws(
    () =>
      parseClassification([ONE], {
        ...GOOD_ANSWERS,
        volatile__u0: { type: 'noul', noul: Number.NaN },
      }),
    /out of range/,
  )
})

test('an array does not pass readChoice as an object', () => {
  assert.throws(
    () => parseClassification([ONE], { ...GOOD_ANSWERS, kind__u0: ['repo_fact'] }),
    /no choice answer/,
  )
})

test('an array does not pass readNoul as an object', () => {
  assert.throws(
    () => parseClassification([ONE], { ...GOOD_ANSWERS, volatile__u0: [0.5] }),
    /no noul answer/,
  )
})

test('a choice missing the probability for its own answer is refused, not defaulted to 0', () => {
  assert.throws(
    () =>
      parseClassification([ONE], {
        ...GOOD_ANSWERS,
        kind__u0: { type: 'choice', choice: 'repo_fact', probabilities: {}, confidence: 1 },
      }),
    /no probability for its own choice repo_fact/,
  )
})

test('a non-finite probability on a non-chosen option is refused', () => {
  assert.throws(
    () =>
      parseClassification([ONE], {
        ...GOOD_ANSWERS,
        kind__u0: {
          type: 'choice',
          choice: 'repo_fact',
          probabilities: { repo_fact: 1, instruction: Number.NaN },
          confidence: 1,
        },
      }),
    /non-finite probability for instruction/,
  )
})

test('a NaN confidence is refused, not passed through as a valid number', () => {
  assert.throws(
    () =>
      parseClassification([ONE], {
        ...GOOD_ANSWERS,
        kind__u0: { ...GOOD_ANSWERS.kind__u0, confidence: Number.NaN },
      }),
    /no choice answer/,
  )
})

test('a probability of 42 is refused, not accepted as a raw score', () => {
  assert.throws(
    () =>
      parseClassification([ONE], {
        ...GOOD_ANSWERS,
        kind__u0: {
          type: 'choice',
          choice: 'repo_fact',
          probabilities: { repo_fact: 42 },
          confidence: 1,
        },
      }),
    /probability out of range for repo_fact: 42/,
  )
})

test('pairRequest carries both units and one question', () => {
  const b = unit({
    id: 'plugins/gh/README.md:310-310',
    file: 'plugins/gh/README.md',
    headingPath: ['gh', 'Requirements'],
    text: 'It needs node 22.18 or newer.',
  })

  const request = pairRequest(ONE, b)

  assert.deepEqual(request.state, {
    statement_a: {
      file: 'CLAUDE.md',
      heading_path: ['claude', 'Tests'],
      text: 'One command per language: `pnpm test` for TypeScript.',
    },
    statement_b: {
      file: 'plugins/gh/README.md',
      heading_path: ['gh', 'Requirements'],
      text: 'It needs node 22.18 or newer.',
    },
  })
  assert.deepEqual(Object.keys(request.questions), [PAIR_QUESTION_ID])
  const question = request.questions[PAIR_QUESTION_ID]
  assert.equal(question?.type, 'choice')
  assert.deepEqual(Object.keys((question as { criteria: object }).criteria), [
    'same_claim',
    'contradicts',
    'unrelated',
  ])
  assert.match(
    (defined(question, 'pair question').instructions as { question: string }).question,
    /`statement_a`/,
  )
})

test('parsePair keeps the candidate and adds the verdict', () => {
  const judgment = parsePair(
    { a: 'CLAUDE.md:1-1', b: 'README.md:2-2', similarity: 0.81 },
    {
      pair: {
        type: 'choice',
        choice: 'same_claim',
        probabilities: { same_claim: 0.8, contradicts: 0.05, unrelated: 0.15 },
        confidence: 0.72,
      },
    },
  )

  assert.deepEqual(judgment, {
    a: 'CLAUDE.md:1-1',
    b: 'README.md:2-2',
    similarity: 0.81,
    verdict: {
      choice: 'same_claim',
      probabilities: { same_claim: 0.8, contradicts: 0.05, unrelated: 0.15 },
      confidence: 0.72,
    },
  })
})

test('evidenceRequest is the citation check, exactly', () => {
  const request = evidenceRequest(ONE, 'package.json', '"test": "vitest run --coverage"')

  assert.deepEqual(request.state, {
    claim: 'One command per language: `pnpm test` for TypeScript.',
    source: 'package.json',
    excerpt: '"test": "vitest run --coverage"',
  })
  assert.deepEqual(Object.keys(request.questions), [EVIDENCE_QUESTION_ID])
  assert.deepEqual(
    Object.keys((request.questions[EVIDENCE_QUESTION_ID] as { criteria: object }).criteria),
    ['supports', 'contradicts', 'says_nothing'],
  )
})

test('parseEvidence returns the contract shape', () => {
  const judgment = parseEvidence(ONE, 'package.json', '"test": "vitest run --coverage"', {
    relation: {
      type: 'choice',
      choice: 'supports',
      probabilities: { supports: 0.97, contradicts: 0.01, says_nothing: 0.02 },
      confidence: 0.95,
    },
  })

  assert.equal(judgment.unitId, 'CLAUDE.md:148-149')
  assert.equal(judgment.source, 'package.json')
  assert.equal(judgment.verdict.choice, 'supports')
  assert.equal(judgment.verdict.confidence, 0.95)
})
