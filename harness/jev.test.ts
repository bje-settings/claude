// The mock's own claims (#173), mirroring harness/gh.test.ts: a reply
// registered per method comes back on every call, a fail switch fails only
// its own method, an unregistered method throws and names itself, and
// usage() always answers zeros.
import { expect, it } from 'vitest'
import { createJevMock, JevError, jevFails } from './jev.ts'

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
    classify: new Error('jev: rate limited'),
    judgePair: {
      choice: 'unrelated',
      probabilities: { unrelated: 1, same_claim: 0, contradicts: 0 },
      confidence: 1,
    },
  })

  await expect(jev.classify([], 'per_unit')).rejects.toThrow('jev: rate limited')
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
  ).resolves.toBeDefined()
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
  // No call counting: the mock holds no state, so a call to classify must not
  // move usage() at all.
  expect(jev.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
})
