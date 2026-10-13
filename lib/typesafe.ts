// This file is the TypeSafe System One transport (#173). It ports the
// context-audit spike's `jev.ts` (#164).
//
// The call is `POST https://api.typesafe.ai/v1/systemone`, with Bearer auth.
// The body is `{state, model, questions}`. The response is `{model, answers,
// usage:{input_tokens, output_tokens}}` (docs.typesafe.ai/api). This file
// uses no SDK. It uses node built-ins and the global `fetch` only, like
// every other file here (ADR 001).
//
// This is the generic ask/usage transport. `lib/jev.ts` is the audit's own
// client on top of it. It adds the five judgment questions and their
// parsers. This file knows nothing about the audit.
//
// This file injects every value that could sit in an untestable branch.
// These are `fetch`, `sleep`, `random`, and a clock. The clock is reached
// only through `Date.now` inside the request loop. A test steers the loop:
// it injects `sleep` and reads what it was called with. The loop's own
// timing is what a test checks, not wall time.
//
// This file uses the erasable-syntax subset (ADR 001). It has no `enum`, no
// parameter properties, and no namespaces. Every import names its `.ts`
// extension.

/** The endpoint, from the API reference. This file calls one service, so it does not change. */
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * Anything `instructions` and `criteria` accept. The API's "Advanced:
 * structure" page calls this an `EntryType`. It allows a string, an object,
 * an array, or null in every one of those positions. `lib/jev.ts` uses
 * objects for the option rubrics. So this loose type is necessary, not a
 * shortcut.
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
  /** Optional. This says what a yes and a no mean. The docs recommend it when the boundary is not clear. */
  readonly criteria?: { readonly true: Entry; readonly false: Entry }
}

/** `T` is the option set, named by `criteria`'s keys. */
export type ChoiceQuestion<T extends string = string> = {
  readonly type: 'choice'
  readonly instructions: Entry
  readonly criteria: Readonly<Record<T, Entry>>
}

export type AnyQuestion = NoulQuestion | ChoiceQuestion<string>

export type QuestionMap = Readonly<Record<string, AnyQuestion>>

/**
 * Every answer of a run, keyed by the question ids that `ask` receives.
 * This type stays untyped on purpose. A request takes shape as
 * `Record<string, AnyQuestion>`. Its per-unit and per-section ids are
 * computed values, not literal ones. So a mapped answer type keyed off the
 * question map would never describe what a caller actually holds.
 * `lib/jev.ts`'s parsers narrow this into the contract's real types at run
 * time, which is where that check belongs.
 */
export type AnswerBag = Record<string, unknown>

/** A Noul question. `criteria` is optional in the API and optional here. */
export function noul(instructions: Entry, criteria?: { true: Entry; false: Entry }): NoulQuestion {
  return criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria }
}

/**
 * A Choice question. The options are the keys of `criteria`. The docs state
 * clearly that both the option names and their descriptions reach the model.
 * So `lib/jev.ts` writes both, to keep the options distinct from each other.
 */
export function choice<const T extends string>(
  instructions: Entry,
  criteria: Record<T, Entry>,
): ChoiceQuestion<T> {
  return { type: 'choice', instructions, criteria }
}

/**
 * A response the API refused, or a run that gave up on one. This class
 * carries `status` and `body`, so a caller can tell three cases apart. A 422
 * means this code built a bad question. A 401 means stop; do not retry. A
 * transport failure has `status` 0, because there was no response to read
 * one from.
 *
 * `ask` throws this class for every failure it can raise. A body the
 * contract does not recognize is one example. So a caller only ever has one
 * class to catch.
 *
 * The API key never reaches `message` or `body` on this class. Every string
 * that could carry the key is redacted first. This covers a server's error
 * text and a foreign `Error#message`. This class also never keeps a foreign
 * error as `cause`. A kept error could send the unredacted original text
 * back out through `JSON.stringify(error)`.
 *
 * Both members are public, like `GhError` (`lib/gh.ts`). `tsc` sees a class
 * exported from `lib/` under two identities: its real path, and the copy
 * at `plugins/<p>/src/lib/typesafe.ts` (ADR 006). A
 * `private` or `protected` member would make the class nominal per
 * declaration. Then the two identities would no longer be assignable to
 * each other.
 */
export class JevError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, message?: string) {
    super(message ?? `TypeSafe request failed with HTTP ${status}`)
    // This name is set here, not inherited. `Error` names itself after its
    // own constructor. Without this line, a caught failure would report as a
    // plain `Error`.
    this.name = 'JevError'
    this.status = status
    this.body = body
  }
}

export type TypeSafeUsage = {
  readonly requests: number
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly requestMsSum: number
}

export type TypeSafeOptions = {
  readonly apiKey: string
  readonly fetch?: typeof fetch
  readonly model?: string
  readonly concurrency?: number
  readonly maxRetries?: number
  /**
   * Per-attempt socket timeout, enforced with `AbortSignal.timeout`. A
   * stalled request aborts. This code handles it as a transport failure,
   * like any other, so it retries the request the same way. The default is
   * 60s, so one dead socket cannot hang the whole run.
   */
  readonly timeoutMs?: number
  /**
   * The test seam for backoff. RFC 001 decision 3 says to inject the client
   * and keep the function pure otherwise. Without this seam, a test that
   * proves the code honors `Retry-After` would have to wait. It would wait
   * out the header in real time.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * The test seam for jitter. Without it, a test can know the ceiling that
   * `backoffMs` computes, but not the value inside it. A test that asserts
   * one exact sleep duration would then read `Math.random`'s own output.
   */
  readonly random?: () => number
}

export type Jev = {
  ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<AnswerBag>
  usage(): TypeSafeUsage
}

/**
 * Statuses the API reference names as "back off and retry", plus the
 * standard proxy-layer statuses (500, 502, 503, 504). A proxy in front of
 * the API can produce these even when the API itself would not. Here, they
 * mean the same thing as a 429 or 529. This code retries a transport
 * failure too.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529])

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_TIMEOUT_MS = 60_000
const BASE_DELAY_MS = 500
/**
 * The ceiling on the computed backoff. With the default `maxRetries` of 4,
 * the loop only ever reaches `backoffMs(3)`, about 4s before jitter. So this
 * 30s ceiling does nothing, unless a caller raises `maxRetries` well past
 * the default.
 */
const MAX_DELAY_MS = 30_000
/**
 * The ceiling on a server-stated `Retry-After`. Unlike the computed backoff,
 * the server chooses this value, not this code. The API reference does not
 * bound it. So a bad response that asks for an hour cannot stall the run
 * past two minutes.
 */
const RETRY_AFTER_CEILING_MS = 120_000
/** The cap on `JevError.body`. A human skims this text, so it need not be the whole thing. */
const BODY_LIMIT = 2_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `Retry-After` in milliseconds, or null when the header is absent or
 * unreadable. The HTTP spec allows both a delay in seconds and an HTTP date.
 * The docs say the SDKs honor the header, but do not say which form the API
 * sends. So this function reads both forms.
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
 * base here. This transport fans out to `concurrency` requests at once.
 * Without jitter, a shared 429 would make every one of them retry at the
 * same instant.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrubs the API key from text that came from outside this module.
 * Examples are a server's error body, or a foreign `Error#message` that
 * echoed a request header. It also scrubs `Bearer <key>` as a unit. This
 * function replaces `Bearer <key>` first, so the result reads `[redacted]`
 * rather than `Bearer [redacted]`.
 */
export function redact(text: string, apiKey: string): string {
  if (apiKey === '') return text
  const escaped = escapeForRegExp(apiKey)
  return text
    .replace(new RegExp(`Bearer\\s+${escaped}`, 'gi'), '[redacted]')
    .replace(new RegExp(escaped, 'g'), '[redacted]')
}

/** A foreign error's own text, read here before this file redacts it into a `JevError`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A plain JSON object. `typeof` answers `'object'` for `null` and for an
 * array too, so this function excludes both. Every caller here checks
 * something the API sent. Without this check, an array would read as an
 * object that carries none of the properties the contract promises.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `payload` only ever comes from `JSON.parse`, or is `undefined` for an
 * empty body. So `JSON.stringify` here can never throw the way it can on
 * arbitrary input. No circular reference or `BigInt` can survive the parse.
 * This function has no `try`, so it has no branch that a test could only
 * fake.
 */
function safeStringify(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

/**
 * A counting semaphore. This function does not release the slot and then
 * let another task take it. Instead, it hands the slot straight from a task
 * that just finished to one that waits. So a caller that arrives between the
 * two cannot slip in and push the in-flight count over the limit.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
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

export function createJev(opts: TypeSafeOptions): Jev {
  const doFetch = opts.fetch ?? fetch
  const model = opts.model ?? 'jev-latest'
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = opts.sleep ?? defaultSleep
  const random = opts.random ?? Math.random
  const limit = createLimiter(opts.concurrency ?? DEFAULT_CONCURRENCY)

  /** Everything that reaches `JevError.body` passes through this function. It redacts the text, then caps it. */
  function asBody(text: string): string {
    return redact(text, opts.apiKey).slice(0, BODY_LIMIT)
  }

  const totals = {
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestMsSum: 0,
  }

  async function send(body: string): Promise<Response> {
    return doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /**
   * The payload of a response the server marked OK. This function reads the
   * body once as text, then parses it. So a malformed body is settled here,
   * not inside the retry machinery. This function throws both failures as a
   * {@link JevError} and retries neither. The reason: the server already
   * received and billed the request. A resend would only re-bill a request
   * that already succeeded.
   */
  async function readOk(response: Response): Promise<{ status: number; payload: unknown }> {
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      throw new JevError(
        response.status,
        asBody(messageOf(error)),
        `TypeSafe returned HTTP ${response.status} but the body could not be read`,
      )
    }
    try {
      return { status: response.status, payload: text === '' ? undefined : JSON.parse(text) }
    } catch {
      throw new JevError(
        response.status,
        asBody(text),
        `TypeSafe returned HTTP ${response.status} with a body that is not valid JSON`,
      )
    }
  }

  /**
   * One request, with retries. A retryable answer is a 429, a 529, or a
   * transport failure like a network error or an aborted timeout. A 2xx
   * response whose body cannot be parsed as JSON is NOT retryable. The
   * server already billed and answered it, not as the contract promises, so
   * a resend would only re-bill it. Everything else is either the payload or
   * a {@link JevError} that the caller must look at. `Retry-After` wins over
   * the computed backoff when the response carries one.
   */
  async function request(body: string): Promise<{ status: number; payload: unknown }> {
    const started = Date.now()
    let lastStatus = 0
    let lastBody = ''
    try {
      for (let attempt = 0; ; attempt += 1) {
        let waitMs = backoffMs(attempt, random)
        totals.attempts += 1
        try {
          const response = await send(body)
          if (response.ok) return await readOk(response)
          // Unlike the JSON body in `readOk`, this code does not discard an
          // unreadable non-OK body as an empty string. An empty body and an
          // unreadable one are different failures. If this code folded them
          // together, it would hide a read failure. The result would look
          // as if the server said nothing.
          const text = asBody(await response.text().catch(() => '(body unreadable)'))
          if (!RETRYABLE.has(response.status)) throw new JevError(response.status, text)
          lastStatus = response.status
          lastBody = text
          const stated = retryAfterMs(response.headers.get('retry-after'), Date.now())
          if (stated !== null) waitMs = Math.min(stated, RETRY_AFTER_CEILING_MS)
        } catch (error) {
          if (error instanceof JevError) throw error
          lastStatus = 0
          lastBody = asBody(messageOf(error))
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
      totals.requestMsSum += Date.now() - started
    }
  }

  async function ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<AnswerBag> {
    const body = JSON.stringify({ state, model, questions })
    const { status, payload } = await limit(() => request(body))
    function refuse(why: string): JevError {
      return new JevError(status, asBody(safeStringify(payload)), why)
    }
    if (!isRecord(payload)) {
      throw refuse('TypeSafe returned a body that is not an object')
    }
    const { answers, usage } = payload
    if (!isRecord(answers)) {
      throw refuse('TypeSafe returned no answers')
    }
    // This field is optional on purpose. The contract promises the counts,
    // but a response that omits them still carries answers this code must
    // return.
    const counts = usage as { input_tokens?: number; output_tokens?: number } | undefined
    totals.inputTokens += counts?.input_tokens ?? 0
    totals.outputTokens += counts?.output_tokens ?? 0
    for (const id of Object.keys(questions)) {
      if (!(id in answers)) {
        throw refuse(`TypeSafe returned no answer for question ${id}`)
      }
    }
    return answers
  }

  return {
    ask,
    usage: () => ({ ...totals }),
  }
}
