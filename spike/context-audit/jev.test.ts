// The client's own tests (#164, spike). `node:test` and an injected `fetch`,
// so nothing here touches the network and nothing needs a key.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { backoffMs, createJev, JevError, retryAfterMs } from './jev.ts'

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
  assert.equal(typeof answer.noul, 'number')
  return answer.noul as number
}

test('sends the documented request shape', async () => {
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

  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(seen.init?.method, 'POST')
  const headers = seen.init?.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${KEY}`)
  assert.equal(headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(seen.init?.body)), {
    state: { text: 'hello' },
    model: 'jev-latest',
    questions: { q: { type: 'noul', instructions: 'Is this a test?' } },
  })
  assert.equal(noulOf(answers, 'q'), 0.75)
})

test('the model is overridable', async () => {
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
  assert.equal(JSON.parse(body).model, 'jev-1.13.0')
})

test('retries a 429 and then succeeds', async () => {
  let calls = 0
  const slept: number[] = []
  const jev = createJev({
    apiKey: KEY,
    sleep: async (ms) => {
      slept.push(ms)
    },
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(429, 'slow down') : reply(200, OK_BODY)
    },
  })

  const answers = await jev.ask('s', Q)

  assert.equal(calls, 2)
  assert.equal(noulOf(answers, 'q'), 0.75)
  assert.equal(slept.length, 1)
})

test('honours Retry-After in seconds over the computed backoff', async () => {
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

  assert.deepEqual(slept, [7000])
})

test('a Retry-After above the ceiling is capped at 120s', async () => {
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

  assert.deepEqual(slept, [120_000])
})

test('retryAfterMs reads seconds, dates, and neither', () => {
  const now = Date.parse('2026-09-21T00:00:00Z')
  assert.equal(retryAfterMs('3', now), 3000)
  assert.equal(retryAfterMs('  12 ', now), 12000)
  assert.equal(retryAfterMs('Mon, 21 Sep 2026 00:00:30 GMT', now), 30000)
  assert.equal(retryAfterMs('Mon, 21 Sep 2020 00:00:00 GMT', now), 0)
  assert.equal(retryAfterMs('soon', now), null)
  assert.equal(retryAfterMs('', now), null)
  assert.equal(retryAfterMs(null, now), null)
})

test('backoff grows and stays inside the jittered ceiling', () => {
  assert.equal(
    backoffMs(0, () => 0),
    0,
  )
  assert.equal(
    backoffMs(0, () => 0.999),
    499,
  )
  assert.equal(
    backoffMs(3, () => 0.999),
    3996,
  )
  // Capped: 500 * 2 ** 20 is far past the ceiling.
  assert.equal(
    backoffMs(20, () => 0.5),
    15000,
  )
})

test('a network error is retried', async () => {
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
  assert.equal(calls, 2)
})

test('a stalled request is aborted by the timeout and retried as a transport failure', async () => {
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
  assert.equal(calls, 2)
  assert.equal(noulOf(answers, 'q'), 0.75)
})

test('a body that is not valid JSON on a 2xx is not retried', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return reply(200, 'not json at all {')
    },
  })

  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 200)
      assert.match(error.message, /not valid JSON/)
      assert.equal(error.body, 'not json at all {')
      return true
    },
  )
  // A billed 2xx must not be resent: exactly one attempt, not up to maxRetries + 1.
  assert.equal(calls, 1)
})

test('gives up after maxRetries and reports the last status', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    maxRetries: 2,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return reply(429, 'still rate limited')
    },
  })

  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 429)
      assert.match(error.message, /gave up after 3 attempts, last HTTP 429/)
      assert.equal(error.body, 'still rate limited')
      return true
    },
  )
  assert.equal(calls, 3)
})

test('a 400 is not retried and carries its status and body', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return reply(400, '{"error":"questions.q.criteria is required"}')
    },
  })

  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 400)
      assert.equal(error.body, '{"error":"questions.q.criteria is required"}')
      return true
    },
  )
  assert.equal(calls, 1)
})

test('the api key is redacted from a server error body that echoes the auth header', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    // The worst case for a header leak: a server that echoes the request
    // headers back verbatim in its error body.
    fetch: async (_url, init) => reply(400, JSON.stringify(init?.headers)),
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  assert.ok(error instanceof JevError)
  const everything = `${error.message} ${error.stack ?? ''} ${error.body} ${JSON.stringify(error)}`
  assert.ok(!everything.includes(KEY))
  assert.ok(error.body.includes('[redacted]'))
})

test('the api key is redacted from a foreign error thrown by fetch itself', async () => {
  const jev = createJev({
    apiKey: KEY,
    maxRetries: 0,
    sleep: async () => {},
    fetch: async (_url, init) => {
      const headers = init?.headers as Record<string, string>
      // A transport that fails badly enough to leak the header into its own
      // exception message, the way a proxy or a broken client sometimes does.
      throw new Error(String(headers.authorization))
    },
  })

  const error = await jev.ask('s', Q).catch((e: unknown) => e)
  assert.ok(error instanceof JevError)
  assert.equal(error.status, 0)
  const everything = `${error.message} ${error.stack ?? ''} ${error.body} ${String(error)} ${JSON.stringify(error)}`
  assert.ok(!everything.includes(KEY))
})

test('a body without answers is refused as a JevError carrying the response status', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, { model: 'jev-1.13.0' }) })
  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 200)
      assert.match(error.message, /no answers/)
      return true
    },
  )
})

test('a missing answer for a question asked is refused as a JevError', async () => {
  const jev = createJev({
    apiKey: KEY,
    fetch: async () =>
      reply(200, { model: 'x', answers: { other: { type: 'noul', noul: 1 } }, usage: {} }),
  })
  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 200)
      assert.match(error.message, /no answer for question q/)
      return true
    },
  )
})

test('a non-object body is refused as a JevError', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, '"just a string"') })
  await assert.rejects(
    () => jev.ask('s', Q),
    (error: unknown) => {
      assert.ok(error instanceof JevError)
      assert.equal(error.status, 200)
      assert.match(error.message, /not an object/)
      return true
    },
  )
})

test('an array body is refused, not treated as an object', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, [1, 2, 3]) })
  await assert.rejects(() => jev.ask('s', Q), /not an object/)
})

test('concurrency never exceeds the limit', async () => {
  let inFlight = 0
  let peak = 0
  const jev = createJev({
    apiKey: KEY,
    concurrency: 3,
    fetch: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return reply(200, OK_BODY)
    },
  })

  await Promise.all(Array.from({ length: 20 }, () => jev.ask('s', Q)))

  assert.equal(peak, 3)
  assert.equal(jev.usage().requests, 20)
})

test('a rejected request still releases its slot', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    concurrency: 1,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(400, 'nope') : reply(200, OK_BODY)
    },
  })

  await assert.rejects(() => jev.ask('s', Q))
  const answers = await jev.ask('s', Q)
  assert.equal(noulOf(answers, 'q'), 0.75)
})

test('usage accumulates requests, attempts, tokens and request time', async () => {
  const jev = createJev({
    apiKey: KEY,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      return reply(200, OK_BODY)
    },
  })

  assert.deepEqual(jev.usage(), {
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
  await jev.ask('s', Q)
  await jev.ask('s', Q)
  const usage = jev.usage()
  assert.equal(usage.requests, 2)
  assert.equal(usage.attempts, 2)
  assert.equal(usage.inputTokens, 200)
  assert.equal(usage.outputTokens, 20)
  assert.ok(usage.requestMsSum >= 2, `expected some elapsed time, got ${usage.requestMsSum}`)
})

test('a call retried twice reports one logical request and three attempts', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return calls < 3 ? reply(429, 'slow down') : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)
  const usage = jev.usage()
  assert.equal(usage.requests, 1)
  assert.equal(usage.attempts, 3)
})

test('usage counts a failed request and a body with no usage field', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => reply(200, { model: 'x', answers: { q: { type: 'noul', noul: 0.5 } } }),
  })
  await jev.ask('s', Q)
  const usage = jev.usage()
  assert.equal(usage.requests, 1)
  assert.equal(usage.inputTokens, 0)
})

test('usage() returns a copy, not the live totals', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, OK_BODY) })
  const before = jev.usage()
  await jev.ask('s', Q)
  assert.equal(before.requests, 0)
  assert.equal(jev.usage().requests, 1)
})
