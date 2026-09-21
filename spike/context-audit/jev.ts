// The HTTP client for TypeSafe's System One endpoint (#164, spike). Written
// from the live docs rather than from memory: `POST
// https://api.typesafe.ai/v1/systemone`, Bearer auth, body `{state, model,
// questions}`, response `{model, answers, usage:{input_tokens,
// output_tokens}}` (docs.typesafe.ai/api). No SDK, node built-ins and global
// `fetch` only, so the spike has no dependency to install and nothing to
// vendor if the idea graduates.
//
// Everything here is transport. What to ask lives in `questions.ts`, because
// the question design is the part of the spike that has to be iterated on and
// a retry loop is not.
//
// Erasable-syntax subset (ADR 001): no `enum`, no parameter properties, no
// namespaces, explicit `.ts` on every import.

import type { Usage } from './types.ts'

/** The endpoint, from the API reference. Not configurable: the spike calls one service. */
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * Anything `instructions` and `criteria` accept. The "Advanced: structure"
 * page calls this an `EntryType` and allows a string, an object, an array or
 * null in every one of those positions; `questions.ts` uses objects for the
 * option rubrics, so the loose type is load bearing rather than laziness.
 */
export type Entry =
  | string
  | number
  | boolean
  | null
  | readonly Entry[]
  | { readonly [key: string]: Entry }

export type NoulQuestion = {
  readonly type: 'noul'
  readonly instructions: Entry
  /** Optional. What a yes and a no mean; the docs recommend it where the boundary is subtle. */
  readonly criteria?: { readonly true: Entry; readonly false: Entry }
}

/**
 * `T` is the option set. It is recovered from `criteria`'s keys by
 * {@link AnswerFor}, so a caller that builds a Choice with {@link choice}
 * gets an answer whose `choice` is one of its own options and not `string`.
 */
export type ChoiceQuestion<T extends string = string> = {
  readonly type: 'choice'
  readonly instructions: Entry
  readonly criteria: Readonly<Record<T, Entry>>
}

export type AnyQuestion = NoulQuestion | ChoiceQuestion<string>

export type QuestionMap = Readonly<Record<string, AnyQuestion>>

export type NoulAnswer = { readonly type: 'noul'; readonly noul: number }

export type RawChoiceAnswer<T extends string = string> = {
  readonly type: 'choice'
  readonly choice: T
  readonly probabilities: Readonly<Record<T, number>>
  readonly confidence: number
}

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer T>
    ? RawChoiceAnswer<T>
    : Q extends NoulQuestion
      ? NoulAnswer
      : never

export type Answers<Q extends QuestionMap> = { readonly [K in keyof Q]: AnswerFor<Q[K]> }

/** A Noul question. `criteria` is optional in the API and optional here. */
export function noul(instructions: Entry, criteria?: { true: Entry; false: Entry }): NoulQuestion {
  return criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria }
}

/**
 * A Choice question. The options are the keys of `criteria`; the docs are
 * explicit that both the option names and their descriptions reach the model,
 * so `questions.ts` writes both to separate the options from each other.
 */
export function choice<const T extends string>(
  instructions: Entry,
  criteria: Record<T, Entry>,
): ChoiceQuestion<T> {
  return { type: 'choice', instructions, criteria }
}

/**
 * A response the API refused or could not be read. `status` and `body` are
 * carried so a caller can tell a 422 (a question this code built wrong) from
 * a 401 (stop, do not retry). The API key is never a field here and never
 * reaches `message`: the only place it exists in this module is the
 * `Authorization` header built inside `send`.
 */
export class JevError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, message?: string) {
    super(message ?? `TypeSafe request failed with HTTP ${status}`)
    this.name = 'JevError'
    this.status = status
    this.body = body
  }
}

export type JevOptions = {
  readonly apiKey: string
  readonly fetch?: typeof fetch
  readonly model?: string
  readonly concurrency?: number
  readonly maxRetries?: number
  /**
   * The test seam for backoff (RFC 001 decision 3: inject the client, keep
   * the function pure otherwise). Without it a test that proves `Retry-After`
   * is honoured has to wait the header out in real time.
   */
  readonly sleep?: (ms: number) => Promise<void>
}

export type Jev = {
  ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<Answers<Q>>
  usage(): Usage
}

/** Statuses the API reference names as "back off and retry". Everything else is a real answer. */
const RETRYABLE = new Set([429, 529])

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 4
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
/** A malformed body is not worth pasting whole into a stack trace. */
const BODY_LIMIT = 2_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `Retry-After` in milliseconds, or null when absent or unreadable. The HTTP
 * spec allows both a delay in seconds and an HTTP date, and the docs say the
 * SDKs honour the header without saying which form the API sends, so both are
 * read here.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null
  const trimmed = header.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/**
 * Full jitter over an exponential base, capped. Jitter matters more than the
 * base here: the spike fans out to `concurrency` requests at once, so a
 * shared 429 would otherwise retry every one of them at the same instant.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

/**
 * A counting semaphore. The slot is handed straight from a finishing task to
 * a waiting one rather than released and re-taken, so a caller arriving
 * between the two cannot slip in and push the in-flight count over the limit.
 */
function createLimiter(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < limit) {
      active += 1
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next === undefined) active -= 1
      else next()
    }
  }
}

export function createJev(opts: JevOptions): Jev {
  const doFetch = opts.fetch ?? fetch
  const model = opts.model ?? 'jev-latest'
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const sleep = opts.sleep ?? defaultSleep
  const limit = createLimiter(opts.concurrency ?? DEFAULT_CONCURRENCY)

  const totals: Usage = { requests: 0, inputTokens: 0, outputTokens: 0, ms: 0 }

  async function send(body: string): Promise<Response> {
    return doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body,
    })
  }

  /**
   * One request, with retries. A retryable answer is a 429, a 529 or a
   * transport failure; everything else is either the payload or a
   * {@link JevError} the caller has to look at. `Retry-After` wins over the
   * computed backoff when the response carries one.
   */
  async function request(body: string): Promise<unknown> {
    const started = Date.now()
    let lastStatus = 0
    let lastBody = ''
    try {
      for (let attempt = 0; ; attempt += 1) {
        let waitMs = backoffMs(attempt, Math.random)
        try {
          const response = await send(body)
          if (response.ok) return await response.json()
          const text = (await response.text().catch(() => '')).slice(0, BODY_LIMIT)
          if (!RETRYABLE.has(response.status)) throw new JevError(response.status, text)
          lastStatus = response.status
          lastBody = text
          const stated = retryAfterMs(response.headers.get('retry-after'), Date.now())
          if (stated !== null) waitMs = stated
        } catch (error) {
          if (error instanceof JevError) throw error
          lastStatus = 0
          lastBody = error instanceof Error ? error.message : String(error)
        }
        if (attempt >= maxRetries) {
          const what = lastStatus === 0 ? 'a transport failure' : `HTTP ${lastStatus}`
          throw new JevError(
            lastStatus,
            lastBody,
            `TypeSafe gave up after ${maxRetries + 1} attempts, last ${what}`,
          )
        }
        await sleep(waitMs)
      }
    } finally {
      totals.requests += 1
      totals.ms += Date.now() - started
    }
  }

  async function ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<Answers<Q>> {
    const body = JSON.stringify({ state, model, questions })
    const payload = await limit(() => request(body))
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('TypeSafe returned a body that is not an object')
    }
    const record = payload as {
      answers?: unknown
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    if (typeof record.answers !== 'object' || record.answers === null) {
      throw new Error('TypeSafe returned no answers')
    }
    totals.inputTokens += record.usage?.input_tokens ?? 0
    totals.outputTokens += record.usage?.output_tokens ?? 0
    const answers = record.answers as Record<string, unknown>
    for (const id of Object.keys(questions)) {
      if (!(id in answers)) throw new Error(`TypeSafe returned no answer for question ${id}`)
    }
    return answers as Answers<Q>
  }

  return {
    ask,
    usage: () => ({ ...totals }),
  }
}
