// The Jev client's own tests (#173). An injected `fetch`, so nothing here
// touches the network and nothing needs a key (`typesafe.test.ts` already
// covers the transport itself: retries, redaction, usage; this file covers
// what `lib/jev.ts` adds on top of it).

import { expect, it } from 'vitest'
import { createJevClient } from './jev.ts'

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
