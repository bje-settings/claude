// The mock's own claims (#173), the same as harness/gh.test.ts. A reply
// registered per method comes back on every call. A sequence takes one
// reply per call, and the last one repeats (#174). A fail switch fails
// only its own method. An unregistered method throws and names itself.
// usage() always answers zeros.
import { expect, it } from 'vitest'
import {
  type ChoiceAnswer,
  createJevMock,
  JevError,
  type JevUnit,
  jevFails,
  type PairVerdict,
} from '#harness/jev.ts'

it('answers with the reply registered for classify, on every call', async () => {
  const outcome = { classifications: [], failures: [] }
  const jev = createJevMock({ classify: outcome })

  await expect(jev.classify([], 'per_unit')).resolves.toEqual(outcome)
  await expect(jev.classify([], 'per_unit')).resolves.toEqual(outcome)
})

it('answers judgePair and judgeEvidence from their own registrations', async () => {
  const pairVerdict = {
    choice: 'same_claim' as const,
    probabilities: { same_claim: 1, contradicts: 0, unrelated: 0 },
    confidence: 1,
  }
  const evidenceVerdict = {
    choice: 'supports' as const,
    probabilities: { supports: 1, contradicts: 0, says_nothing: 0 },
    confidence: 1,
  }
  const jev = createJevMock({ judgePair: pairVerdict, judgeEvidence: evidenceVerdict })

  await expect(
    jev.judgePair(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      {
        id: 'b',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'b',
        refs: [],
      },
    ),
  ).resolves.toEqual(pairVerdict)
  await expect(
    jev.judgeEvidence(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      'source.ts',
      'excerpt',
    ),
  ).resolves.toEqual(evidenceVerdict)
})

it('fails only the method the fail switch was registered for', async () => {
  const jev = createJevMock({
    judgePair: new Error('jev: rate limited'),
    judgeEvidence: {
      choice: 'supports',
      probabilities: { supports: 1, contradicts: 0, says_nothing: 0 },
      confidence: 1,
    },
  })

  await expect(
    jev.judgePair(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      {
        id: 'b',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'b',
        refs: [],
      },
    ),
  ).rejects.toThrow('jev: rate limited')
  await expect(
    jev.judgeEvidence(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      'source.ts',
      'excerpt',
    ),
  ).resolves.toBeDefined()
})

it("classify has no fail switch, because the real client's classify() never rejects", async () => {
  // `lib/jev.ts`'s `classifyImpl` settles every request with
  // `Promise.allSettled`. It folds a rejection into
  // `ClassifyOutcome.failures`, instead of rejecting. `JevReplies['classify']`
  // excludes `Error`, so `tsc` enforces this at the type level (it refuses
  // `classify: new Error(...)`). This test is the runtime half: a
  // registered `ClassifyOutcome` is the only thing `classify` can ever
  // answer with, fail switch or not.
  const outcome = { classifications: [], failures: [{ id: 'request 0', message: 'boom' }] }
  const jev = createJevMock({ classify: outcome })

  await expect(jev.classify([], 'per_unit')).resolves.toEqual(outcome)
})

it('jevFails produces a JevError, so a command branching on error.status has something to catch', async () => {
  const jev = createJevMock({ judgeEvidence: jevFails('jev: rate limited', 429) })

  const rejection = await jev
    .judgeEvidence(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      'source.ts',
      'excerpt',
    )
    .catch((error: unknown) => error)

  expect(rejection).toBeInstanceOf(JevError)
  expect((rejection as JevError).status).toBe(429)
  expect((rejection as JevError).message).toBe('jev: rate limited')
})

it('jevFails defaults status to 0, the transport-failure status, when none is given', () => {
  expect(jevFails('boom').status).toBe(0)
})

it('throws and names the method when nothing is registered for it', async () => {
  const jev = createJevMock()

  await expect(jev.classify([], 'per_unit')).rejects.toThrow(
    'jev mock: no reply registered for classify',
  )
  await expect(
    jev.judgePair(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      {
        id: 'b',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'b',
        refs: [],
      },
    ),
  ).rejects.toThrow('jev mock: no reply registered for judgePair')
  await expect(
    jev.judgeEvidence(
      {
        id: 'a',
        file: 'a.md',
        headingPath: [],
        leadIn: null,
        prev: null,
        next: null,
        text: 'a',
        refs: [],
      },
      'source.ts',
      'excerpt',
    ),
  ).rejects.toThrow('jev mock: no reply registered for judgeEvidence')
})

it('usage() always answers zeros, whatever classify was told to answer', async () => {
  const jev = createJevMock({ classify: { classifications: [], failures: [] } })
  expect(jev.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
  await jev.classify([], 'per_unit')
  // The mock counts no calls. A call to classify must not move usage() at
  // all.
  expect(jev.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
})

/** The two arguments `judgePair` takes. No test here varies them. The
 *  double reads neither, so they exist only to satisfy the interface. */
const PAIR: [JevUnit, JevUnit] = [
  {
    id: 'a',
    file: 'a.md',
    headingPath: [],
    leadIn: null,
    prev: null,
    next: null,
    text: 'a',
    refs: [],
  },
  {
    id: 'b',
    file: 'a.md',
    headingPath: [],
    leadIn: null,
    prev: null,
    next: null,
    text: 'b',
    refs: [],
  },
]

/** A `judgePair` answer that chose `same_claim` with `confidence`. */
const pairAnswer = (confidence: number): ChoiceAnswer<PairVerdict> => ({
  choice: 'same_claim',
  probabilities: { same_claim: 1, contradicts: 0, unrelated: 0 },
  confidence,
})

it('takes one reply per call from a sequence, and repeats the last one', async () => {
  // This is the fact a single reply cannot state: two calls of the same
  // kind that come back with different confidences. A ranked findings list
  // is built out of this fact. The third call is past the end, so it reads
  // the last entry. A stage that makes one call more than the test expected
  // does not fall off the end.
  const jev = createJevMock({}, { judgePair: [pairAnswer(0.4), pairAnswer(0.9)] })

  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.4)
  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.9)
  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.9)
  // The cursor is the only state this double holds. It must stay out of
  // the one answer that could be mistaken for a call count. This is
  // asserted here, not beside `classify`, which has no cursor to leak.
  expect(jev.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
})

it('advances each method’s cursor on its own', async () => {
  // There is one cursor per method, not one for the whole double. A stage
  // that judges pairs and then evidence must not let the first stage's
  // calls decide what the second stage reads.
  const jev = createJevMock(
    {},
    {
      judgePair: [pairAnswer(0.4), pairAnswer(0.9)],
      judgeEvidence: [
        {
          choice: 'contradicts',
          probabilities: { contradicts: 1, says_nothing: 0, supports: 0 },
          confidence: 0.7,
        },
        {
          choice: 'supports',
          probabilities: { contradicts: 0, says_nothing: 0, supports: 1 },
          confidence: 0.2,
        },
      ],
    },
  )

  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.4)
  expect((await jev.judgeEvidence(PAIR[0], 'source.ts', 'excerpt')).choice).toBe('contradicts')
  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.9)
})

it('throws a sequence entry that is an Error, for that call alone', async () => {
  const jev = createJevMock(
    {},
    { judgePair: [jevFails('jev: rate limited', 429), pairAnswer(0.6)] },
  )

  await expect(jev.judgePair(...PAIR)).rejects.toThrow('jev: rate limited')
  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.6)
})

it('outranks the single reply registered for the same method', async () => {
  // Precedence exists for this reason. A reply left in place for another
  // reason must not quietly answer a test that means "this call, then that
  // one".
  const jev = createJevMock({ judgePair: pairAnswer(0.1) }, { judgePair: [pairAnswer(0.8)] })

  expect((await jev.judgePair(...PAIR)).confidence).toBe(0.8)
})

it('refuses an empty sequence rather than falling through to the reply', async () => {
  // An empty array means a test meant to register something and did not.
  // If the mock answered it from the single reply, or from nothing, that
  // mistake would stay hidden.
  const jev = createJevMock({ judgePair: pairAnswer(0.1) }, { judgePair: [] })

  await expect(jev.judgePair(...PAIR)).rejects.toThrow(
    'jev mock: the sequence registered for judgePair is empty',
  )
})
