// The transport's own tests (#173, porting the context-audit spike's
// `jev.test.ts`, #164). An injected `fetch`, `sleep` and `random`, so nothing
// here touches the network, waits in real time, or depends on which branch of
// jitter actually ran.

import { expect, it } from 'vitest'
import {
  backoffMs,
  choice,
  createJev,
  createLimiter,
  JevError,
  noul,
  redact,
  retryAfterMs,
} from './typesafe.ts'

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

// RETRYABLE names 500, 502 and 504 as "the standard proxy-layer statuses"
// beside 429, 503 and 529, each with its own test: a Set literal missing one
// of the six, or a typo in one of the numbers, is otherwise invisible to the
// suite (only 429, 503 and 529 had a test of their own before this one).
it.each([500, 502, 504])('a %d is retried like a 429', async (status) => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(status, 'unavailable') : reply(200, OK_BODY)
    },
  })

  await jev.ask('s', Q)
  expect(calls).toBe(2)
})

it('the computed backoff stays inside its own 30s ceiling for a large attempt', () => {
  // attempt 20: 500 * 2**20 is far past MAX_DELAY_MS, so an unguarded formula
  // would sleep hours; the ceiling caps it at 30000 before jitter.
  expect(backoffMs(20, () => 0.5)).toBe(15_000)
  expect(backoffMs(20, () => 1)).toBeLessThanOrEqual(30_000)
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

it('a transport failure message is capped at BODY_LIMIT, like every other JevError.body', async () => {
  // The doc comment on asBody says everything that reaches JevError.body goes
  // through it, "redacted, then capped". The transport-failure branch of
  // request()'s catch calls redact() directly instead of asBody(), so an
  // oversized Error#message from a network failure (an aggregate error, a
  // proxy quoting a whole request) would reach JevError.body uncapped.
  const jev = createJev({
    apiKey: KEY,
    maxRetries: 0,
    sleep: async () => {},
    fetch: async () => {
      throw new Error('x'.repeat(3_000))
    },
  })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.body.length).toBeLessThanOrEqual(2_000)
})

it('the cap is applied after redaction, so a key straddling the cut cannot survive', async () => {
  // asBody's doc comment promises "redacted, then capped". If BODY_LIMIT
  // sliced the text before redact() ran, a key positioned across the cut
  // point would be cut in half; redact() only matches the WHOLE key, so that
  // surviving half would never match and would leak into JevError.body
  // un-redacted. Placing the key's own midpoint at the cut is what makes that
  // failure mode observable: a message that is merely "long" (the test above)
  // cannot tell the two orderings apart when it carries no key at all.
  const straddle = 2_000 - Math.floor(KEY.length / 2)
  const message = `${'x'.repeat(straddle)}${KEY}${'y'.repeat(5_000)}`
  const jev = createJev({
    apiKey: KEY,
    maxRetries: 0,
    sleep: async () => {},
    fetch: async () => {
      throw new Error(message)
    },
  })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.body.length).toBeLessThanOrEqual(2_000)
  expect(error.body).not.toContain(KEY)
  // A slice-before-redact bug leaves this un-redacted fragment inside the
  // truncated body.
  expect(error.body).not.toContain(KEY.slice(0, 10))
  expect(error.body).toContain('[redacted]')
})

it('a transport failure that is not an Error instance is still retried and reported', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    maxRetries: 0,
    sleep: async () => {},
    fetch: async () => {
      calls += 1
      // Not every rejection is an Error: this pins messageOf's String(error) arm.
      throw 'boom'
    },
  })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.message).toMatch(/gave up after 1 attempts, last a transport failure/)
  expect(error.body).toBe('boom')
  expect(calls).toBe(1)
})

it('with no fetch injected, the global fetch is used', async () => {
  const original = globalThis.fetch
  const seen: { url?: string } = {}
  globalThis.fetch = (async (url: string | URL) => {
    seen.url = String(url)
    return reply(200, OK_BODY)
  }) as typeof fetch
  try {
    const jev = createJev({ apiKey: KEY })
    const answers = await jev.ask('s', Q)
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(noulOf(answers, 'q')).toBe(0.75)
  } finally {
    globalThis.fetch = original
  }
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

it('the api key is redacted from a server error body that echoes the auth header', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    // The worst case for a header leak: a server that echoes the request
    // headers back verbatim in its error body.
    fetch: async (_url, init) => reply(400, JSON.stringify(init?.headers)),
  })

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  const everything = `${error.message} ${error.stack ?? ''} ${error.body} ${JSON.stringify(error)}`
  expect(everything.includes(KEY)).toBe(false)
  expect(error.body.includes('[redacted]')).toBe(true)
})

it('the api key is redacted from a foreign error thrown by fetch itself', async () => {
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

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.status).toBe(0)
  const everything = `${error.message} ${error.stack ?? ''} ${error.body} ${String(error)} ${JSON.stringify(error)}`
  expect(everything.includes(KEY)).toBe(false)
})

it('the api key is redacted from a server body that echoes the bare key, not just Bearer <key>', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    // No `Bearer` prefix this time: some servers echo the raw credential
    // value alone, which is a different code path in `redact` than the
    // `Bearer <key>` case the other tests exercise.
    fetch: async () => reply(400, JSON.stringify({ error: `key ${KEY} rejected` })),
  })

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.body.includes(KEY)).toBe(false)
  expect(error.body.includes('[redacted]')).toBe(true)
})

it('the api key is redacted from a malformed 2xx body that happens to contain it', async () => {
  // Pins the redact() call on the not-valid-JSON call site, which no other
  // test exercises with the bare key present in the body.
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, `not json ${KEY}`) })

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.message).toMatch(/not valid JSON/)
  expect(error.body.includes(KEY)).toBe(false)
  expect(error.body.includes('[redacted]')).toBe(true)
})

it('the api key is redacted from a 2xx body with no answers that happens to contain it', async () => {
  // Pins one of the three ask()-level safeStringify(payload) call sites: a
  // 2xx that parses as JSON but fails the `answers` shape check.
  const jev = createJev({
    apiKey: KEY,
    fetch: async () => reply(200, { model: 'x', note: `leaked key ${KEY}` }),
  })

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.message).toMatch(/no answers/)
  expect(error.body.includes(KEY)).toBe(false)
  expect(error.body.includes('[redacted]')).toBe(true)
})

it('redact leaves text alone when the api key is empty', () => {
  // Exercises the early-return branch directly: an empty key would otherwise
  // become an empty-string RegExp that matches everywhere.
  expect(redact('nothing to hide', '')).toBe('nothing to hide')
})

it('redact turns Bearer <key> into [redacted] alone, not Bearer [redacted]', () => {
  // The doc comment on redact() promises this exact result so the reader
  // never sees "Bearer [redacted]"; a bare-key-only redaction would still
  // remove the key here (leaving no key text behind) without producing this
  // string, so a test that only checked "the key is gone" could not tell the
  // two implementations apart.
  expect(redact(`Bearer ${KEY}`, KEY)).toBe('[redacted]')
})

it('a body without answers is refused as a JevError carrying the response status', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, { model: 'jev-1.13.0' }) })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.status).toBe(200)
  expect(error.message).toMatch(/no answers/)
})

it('a missing answer for a question asked is refused as a JevError', async () => {
  const jev = createJev({
    apiKey: KEY,
    fetch: async () =>
      reply(200, { model: 'x', answers: { other: { type: 'noul', noul: 1 } }, usage: {} }),
  })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.status).toBe(200)
  expect(error.message).toMatch(/no answer for question q/)
})

it('a non-object body is refused as a JevError', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, '"just a string"') })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.status).toBe(200)
  expect(error.message).toMatch(/not an object/)
})

it('an array body is refused, not treated as an object', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, [1, 2, 3]) })
  await expect(jev.ask('s', Q)).rejects.toThrow(/not an object/)
})

it('gives up after maxRetries and reports the last status', async () => {
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

  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.status).toBe(429)
  expect(error.message).toMatch(/gave up after 3 attempts, last HTTP 429/)
  expect(error.body).toBe('still rate limited')
  expect(calls).toBe(3)
  // usage() is a run's own account of what it spent, and a request that
  // never succeeds was still billed for every attempt: the `finally` around
  // the whole retry loop counts it the same as a request that succeeded.
  const usage = jev.usage()
  expect(usage.requests).toBe(1)
  expect(usage.attempts).toBe(3)
})

it('usage accumulates requests, attempts, tokens and request time', async () => {
  const jev = createJev({
    apiKey: KEY,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      return reply(200, OK_BODY)
    },
  })

  expect(jev.usage()).toEqual({
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  })
  await jev.ask('s', Q)
  await jev.ask('s', Q)
  const usage = jev.usage()
  expect(usage.requests).toBe(2)
  expect(usage.attempts).toBe(2)
  expect(usage.inputTokens).toBe(200)
  expect(usage.outputTokens).toBe(20)
  expect(usage.requestMsSum).toBeGreaterThanOrEqual(2)
})

it('a call retried twice reports one logical request and three attempts', async () => {
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
  expect(usage.requests).toBe(1)
  expect(usage.attempts).toBe(3)
})

it('usage counts a failed request and a body with no usage field', async () => {
  const jev = createJev({
    apiKey: KEY,
    sleep: async () => {},
    fetch: async () => reply(200, { model: 'x', answers: { q: { type: 'noul', noul: 0.5 } } }),
  })
  await jev.ask('s', Q)
  const usage = jev.usage()
  expect(usage.requests).toBe(1)
  expect(usage.inputTokens).toBe(0)
})

it('usage() returns a copy, not the live totals', async () => {
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, OK_BODY) })
  const before = jev.usage()
  await jev.ask('s', Q)
  expect(before.requests).toBe(0)
  expect(jev.usage().requests).toBe(1)
})

it('concurrency never exceeds the limit', async () => {
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

  expect(peak).toBe(3)
  expect(jev.usage().requests).toBe(20)
})

it('a rejected request still releases its slot', async () => {
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

  await expect(jev.ask('s', Q)).rejects.toThrow()
  const answers = await jev.ask('s', Q)
  expect(noulOf(answers, 'q')).toBe(0.75)
})

it('createLimiter releases its slot even when a task throws synchronously', async () => {
  // `createJev` only ever hands the limiter an async task (`request` is an
  // async function, so a throw inside it is already a rejected promise by
  // the time the limiter sees it), so this is the one case that integration
  // cannot exercise: a task that throws before returning a promise at all.
  // The doc comment's "handed straight from a finishing task to a waiting
  // one" promise has to hold from the `finally` block regardless of how the
  // task failed.
  const limit = createLimiter(1)

  await expect(
    limit((): Promise<never> => {
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')

  // If the first call's slot were never released, this would hang forever
  // waiting for one.
  await expect(limit(async () => 'ok')).resolves.toBe('ok')
})

it('noul omits criteria when none is given, and carries it when given', () => {
  expect(noul('is it true?')).toEqual({ type: 'noul', instructions: 'is it true?' })
  expect(noul('is it true?', { true: 'yes', false: 'no' })).toEqual({
    type: 'noul',
    instructions: 'is it true?',
    criteria: { true: 'yes', false: 'no' },
  })
})

it('choice carries the options as criteria keys', () => {
  expect(choice('which?', { a: 'first', b: 'second' })).toEqual({
    type: 'choice',
    instructions: 'which?',
    criteria: { a: 'first', b: 'second' },
  })
})

it('a retry sleeps through the real default sleep when none is injected', async () => {
  let calls = 0
  const jev = createJev({
    apiKey: KEY,
    // random: 0 makes backoffMs(0, random) floor to 0ms, so the real
    // (non-injected) sleep resolves near-instantly rather than slowing the
    // suite down.
    random: () => 0,
    fetch: async () => {
      calls += 1
      return calls === 1 ? reply(429, 'slow down') : reply(200, OK_BODY)
    },
  })

  const answers = await jev.ask('s', Q)
  expect(calls).toBe(2)
  expect(noulOf(answers, 'q')).toBe(0.75)
})

it('an empty 2xx body is refused as "not an object", not read as an answer', async () => {
  // payload becomes `undefined` here (`text === '' ? undefined : ...`), which
  // also exercises safeStringify's `JSON.stringify(undefined) ?? String()`
  // fallback in the error it builds.
  const jev = createJev({ apiKey: KEY, fetch: async () => reply(200, '') })
  const error = (await jev.ask('s', Q).catch((e: unknown) => e)) as JevError
  expect(error).toBeInstanceOf(JevError)
  expect(error.message).toMatch(/not an object/)
  expect(error.body).toBe('undefined')
})
