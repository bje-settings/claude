// The transport's own tests (#173, porting the context-audit spike's
// `jev.test.ts`, #164). An injected `fetch`, `sleep` and `random`, so nothing
// here touches the network, waits in real time, or depends on which branch of
// jitter actually ran.

import { expect, it } from 'vitest'
import { createJev, JevError, retryAfterMs } from './typesafe.ts'

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

it('retries a 429 and then succeeds, backing off with the injected random', async () => {
  let calls = 0
  const slept: number[] = []
  const jev = createJev({
    apiKey: KEY,
    random: () => 0.5,
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(429, 'slow down') : reply(200, OK_BODY)
    },
  })

  const answers = await jev.ask('s', Q)

  expect(calls).toBe(2)
  expect(noulOf(answers, 'q')).toBe(0.75)
  // attempt 0, random() = 0.5: floor(0.5 * min(30000, 500 * 2**0)) = 250.
  expect(slept).toEqual([250])
})

it('honours Retry-After in seconds over the computed backoff', async () => {
  let calls = 0
  const slept: number[] = []
  const jev = createJev({
    apiKey: KEY,
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(529, 'overloaded', { 'retry-after': '7' }) : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)

  expect(slept).toEqual([7000])
})

it('honours Retry-After as an HTTP date', async () => {
  const now = Date.now()
  const soon = new Date(now + 5_000).toUTCString()
  let calls = 0
  const slept: number[] = []
  const jev = createJev({
    apiKey: KEY,
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(429, 'slow down', { 'retry-after': soon }) : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)

  expect(slept.length).toBe(1)
  // Real-time slop between computing `soon` and the header being read.
  expect(slept[0]).toBeGreaterThan(3_000)
  expect(slept[0]).toBeLessThanOrEqual(5_000)
})

it('a Retry-After above the ceiling is capped at 120s', async () => {
  let calls = 0
  const slept: number[] = []
  const jev = createJev({
    apiKey: KEY,
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(429, 'slow down', { 'retry-after': '99999' }) : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)

  expect(slept).toEqual([120_000])
})

it('retryAfterMs reads seconds, dates, and neither', () => {
  const now = Date.parse('2026-09-21T00:00:00Z')
  expect(retryAfterMs('3', now)).toBe(3000)
  expect(retryAfterMs('  12 ', now)).toBe(12000)
  expect(retryAfterMs('Mon, 21 Sep 2026 00:00:30 GMT', now)).toBe(30000)
  expect(retryAfterMs('Mon, 21 Sep 2020 00:00:00 GMT', now)).toBe(0)
  expect(retryAfterMs('soon', now)).toBe(null)
  expect(retryAfterMs('', now)).toBe(null)
  expect(retryAfterMs(null, now)).toBe(null)
})

it('a 503 is retried like a 429', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(503, 'unavailable') : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)
  expect(calls).toBe(2)
})

it('a 400 is not retried and carries its status and body', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return reply(400, '{"error":"questions.q.criteria is required"}')
    },
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(JevError)
  expect((error as JevError).status).toBe(400)
  expect((error as JevError).body).toBe('{"error":"questions.q.criteria is required"}')
  expect(calls).toBe(1)
})

it('a network error is retried', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return reply(200, OK_BODY)
    },
  })
  await jev.ask('s', Q)
  expect(calls).toBe(2)
})

it('a stalled request is aborted by the timeout and retried as a transport failure', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    timeoutMs: 20,
    sleep: async () => {},
    fetch: (_url, init) => {
      calls += 1
      if (calls === 1) {
        // A socket that never answers: the only way it ever settles is the
        // abort signal firing when the timeout elapses.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'TimeoutError'))
          })
        })
      }
      return Promise.resolve(reply(200, OK_BODY))
    },
  })

  const answers = await jev.ask('s', Q)
  expect(calls).toBe(2)
  expect(noulOf(answers, 'q')).toBe(0.75)
  expect(jev.usage().attempts).toBe(2)
})

it('a body that is not valid JSON on a 2xx is not retried', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return reply(200, 'not json at all {')
    },
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(JevError)
  expect((error as JevError).status).toBe(200)
  expect((error as JevError).message).toMatch(/not valid JSON/)
  expect((error as JevError).body).toBe('not json at all {')
  // A billed 2xx must not be resent: exactly one attempt, not up to maxRetries + 1.
  expect(calls).toBe(1)
})

it('a 2xx whose body read throws is a non-retryable JevError with the real status', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('body read timed out')
        },
      } as unknown as Response
    },
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(JevError)
  expect((error as JevError).status).toBe(200)
  expect((error as JevError).message).toMatch(/body could not be read/)
  // A received, billed 2xx must not be resent just because its body read failed.
  expect(calls).toBe(1)
})

it('an unreadable body on a non-OK response is reported with a marker, not as empty', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () =>
      ({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => {
          throw new Error('read failed')
        },
      }) as unknown as Response,
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(JevError)
  expect((error as JevError).status).toBe(400)
  expect((error as JevError).body).toBe('(body unreadable)')
})
