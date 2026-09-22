// The transport's own tests (#173, porting the context-audit spike's
// `jev.test.ts`, #164). An injected `fetch`, `sleep` and `random`, so nothing
// here touches the network, waits in real time, or depends on which branch of
// jitter actually ran.

import { expect, it } from 'vitest'
import { createJev } from './typesafe.ts'

const KEY = 'sk-test-do-not-log-me'

/** A response with the given status, body and headers, without a real server. */
function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'noul', noul: 0.75 } },
  usage: { input_tokens: 100, output_tokens: 10 },
}

const Q = { q: { type: 'noul', instructions: 'Is this a test?' } } as const

/** `answers.q` back into a number, without the cast a caller no longer needs to make. */
function noulOf(answers: Record<string, unknown>, id: string): number {
  const answer = answers[id] as { noul?: unknown }
  expect(typeof answer.noul).toBe('number')
  return answer.noul as number
}

it('sends the documented request shape and parses a 200', async () => {
  const seen: { url?: string; init?: RequestInit } = {}
  const jev = createJev({
    apiKey: KEY,
    fetch: async (url, init) => {
      seen.url = String(url)
      seen.init = init
      return reply(200, OK_BODY)
    },
  })

  const answers = await jev.ask({ text: 'hello' }, Q)

  expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.init?.method).toBe('POST')
  const headers = seen.init?.headers as Record<string, string>
  expect(headers.authorization).toBe(`Bearer ${KEY}`)
  expect(headers['content-type']).toBe('application/json')
  expect(JSON.parse(String(seen.init?.body))).toEqual({
    state: { text: 'hello' },
    model: 'jev-latest',
    questions: { q: { type: 'noul', instructions: 'Is this a test?' } },
  })
  expect(noulOf(answers, 'q')).toBe(0.75)
})

it('the model is overridable', async () => {
  let body = ''
  const jev = createJev({
    apiKey: KEY,
    model: 'jev-1.13.0',
    fetch: async (_url, init) => {
      body = String(init?.body)
      return reply(200, OK_BODY)
    },
  })
  await jev.ask('s', Q)
  expect(JSON.parse(body).model).toBe('jev-1.13.0')
})
