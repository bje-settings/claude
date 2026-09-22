// The TypeSafe System One transport (#173, porting the context-audit spike's
// `jev.ts`, #164). `POST https://api.typesafe.ai/v1/systemone`, Bearer auth,
// body `{state, model, questions}`, response `{model, answers,
// usage:{input_tokens, output_tokens}}` (docs.typesafe.ai/api). No SDK: node
// built-ins and global `fetch` only, matching every other file here (ADR 001).
//
// This is the generic ask/usage transport. `lib/jev.ts` is the audit's own
// client on top of it, with the five judgment questions and their parsers;
// this file knows nothing about the audit.
//
// Every knob that could otherwise sit in an untestable branch is injected:
// `fetch`, `sleep`, `random` and a clock reached only through `Date.now`
// inside the request loop (a test steers it by injecting `sleep` and reading
// what it was called with, since the loop's own timing is what a test cares
// about, not wall time). Erasable-syntax subset (ADR 001): no `enum`, no
// parameter properties, no namespaces, explicit `.ts` on every import.

/** The endpoint, from the API reference. Not configurable: this file calls one service. */
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * Anything `instructions` and `criteria` accept. The "Advanced: structure"
 * page calls this an `EntryType` and allows a string, an object, an array or
 * null in every one of those positions; `lib/jev.ts` uses objects for the
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

/** `T` is the option set, named by `criteria`'s keys. */
export type ChoiceQuestion<T extends string = string> = {
  readonly type: 'choice'
  readonly instructions: Entry
  readonly criteria: Readonly<Record<T, Entry>>
}

export type AnyQuestion = NoulQuestion | ChoiceQuestion<string>

export type QuestionMap = Readonly<Record<string, AnyQuestion>>

/**
 * Every answer of a run, keyed by the question ids `ask` was given. Untyped
 * on purpose: a request is built as `Record<string, AnyQuestion>` (the
 * per-unit and per-section ids are computed, not literal), so a mapped answer
 * type keyed off the question map has never described what a caller actually
 * has in hand. `lib/jev.ts`'s parsers narrow this into the contract's real
 * types at runtime, which is where that validation belongs.
 */
export type AnswerBag = Record<string, unknown>

/** A Noul question. `criteria` is optional in the API and optional here. */
export function noul(instructions: Entry, criteria?: { true: Entry; false: Entry }): NoulQuestion {
  return criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria }
}

/**
 * A Choice question. The options are the keys of `criteria`; the docs are
 * explicit that both the option names and their descriptions reach the model,
 * so `lib/jev.ts` writes both to separate the options from each other.
 */
export function choice<const T extends string>(
  instructions: Entry,
  criteria: Record<T, Entry>,
): ChoiceQuestion<T> {
  return { type: 'choice', instructions, criteria }
}

/**
 * A response the API refused, or a run that gave up on one. `status` and
 * `body` are carried so a caller can tell a 422 (a question this code built
 * wrong) from a 401 (stop, do not retry) from a transport failure, where
 * `status` is 0: there was no response to read one from. `ask` throws this
 * class for every failure it can raise, including a body the contract does
 * not recognise, so a caller only ever has one class to catch.
 *
 * The API key never reaches `message` or `body`: every string that could
 * carry it (a server's error text, a foreign `Error#message`) is redacted
 * before it is attached here, and no foreign error is kept as `cause`, since
 * that would smuggle the unredacted original back in through
 * `JSON.stringify(error)`.
 *
 * Both members are public, like `GhError` (`lib/gh.ts`): a class exported
 * from `lib/` is seen by `tsc` under two identities, its real path and
 * `plugins/<p>/src/lib/typesafe.ts` through the committed symlink, and a
 * `private` or `protected` member would make it nominal per declaration, so
 * the two identities would stop being assignable to each other.
 */
export class JevError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string, message?: string) {
    super(message ?? `TypeSafe request failed with HTTP ${status}`)
    // Set explicitly rather than inherited: `Error` names itself after its
    // own constructor, so without this a caught failure reports as a plain
    // `Error`.
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
   * stalled request aborts and is handled as a transport failure like any
   * other, so it is retried the same way. Defaults to 60s so one dead socket
   * cannot hang the whole run.
   */
  readonly timeoutMs?: number
  /**
   * The test seam for backoff (RFC 001 decision 3: inject the client, keep
   * the function pure otherwise). Without it a test that proves `Retry-After`
   * is honoured has to wait the header out in real time.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * The test seam for jitter. Without it, the ceiling `backoffMs` computes is
   * knowable but the value inside it is not, and a test asserting a specific
   * slept duration would be reading `Math.random`'s own output.
   */
  readonly random?: () => number
}

export type Jev = {
  ask<Q extends QuestionMap>(state: unknown, questions: Q): Promise<AnswerBag>
  usage(): TypeSafeUsage
}

/**
 * Statuses the API reference names as "back off and retry", plus the
 * standard proxy-layer statuses (500, 502, 503, 504): a proxy sitting in
 * front of the API can produce these even when the API itself would not, and
 * they mean the same thing as a 429 or 529 here. A transport failure is
 * retried too.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529])

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_TIMEOUT_MS = 60_000
const BASE_DELAY_MS = 500
/**
 * The ceiling on the computed backoff. With the default `maxRetries` (4) the
 * loop only ever reaches `backoffMs(3)`, about 4s before jitter, so this 30s
 * ceiling does nothing unless a caller raises `maxRetries` well past the
 * default.
 */
const MAX_DELAY_MS = 30_000
/**
 * The ceiling on a server-stated `Retry-After`. Unlike the computed backoff,
 * this is chosen by the server, not by this code, and the API reference does
 * not bound it, so an ill-behaved response asking for an hour cannot stall
 * the run past two minutes.
 */
const RETRY_AFTER_CEILING_MS = 120_000
/** The cap on `JevError.body`: a human skims it, so it need not be the whole thing. */
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
 * base here: this transport fans out to `concurrency` requests at once, so a
 * shared 429 would otherwise retry every one of them at the same instant.
 */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrubs the API key, and `Bearer <key>` as a unit, from text that came from
 * outside this module: a server's error body, or a foreign `Error#message`
 * that happened to echo a request header. `Bearer <key>` is replaced first so
 * the result reads `[redacted]` rather than `Bearer [redacted]`.
 */
export function redact(text: string, apiKey: string): string {
  if (apiKey === '') return text
  const escaped = escapeForRegExp(apiKey)
  return text
    .replace(new RegExp(`Bearer\\s+${escaped}`, 'gi'), '[redacted]')
    .replace(new RegExp(escaped, 'g'), '[redacted]')
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A counting semaphore. The slot is handed straight from a finishing task to
 * a waiting one rather than released and re-taken, so a caller arriving
 * between the two cannot slip in and push the in-flight count over the limit.
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

  /** Everything that reaches `JevError.body` goes through here: redacted, then capped. */
  const asBody = (text: string): string => redact(text, opts.apiKey).slice(0, BODY_LIMIT)
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

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
   * One request, with retries. A retryable answer is a 429, a 529 or a
   * transport failure (a network error, an aborted timeout, or a 2xx whose
   * body cannot be parsed as JSON is NOT one of these: the request was billed
   * and answered, just not the way the contract promises, so resending it
   * would only re-bill it); everything else is either the payload or a
   * {@link JevError} the caller has to look at. `Retry-After` wins over the
   * computed backoff when the response carries one.
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
          if (response.ok) {
            // Read once as text, then parse, so a malformed body is caught
            // here rather than inside the retry machinery below. A read
            // failure here (a timeout partway through the body) is thrown as
            // a JevError, not left to the transport-failure branch below: the
            // response was already received and billed, so retrying would
            // only re-bill a request that already succeeded.
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
              return {
                status: response.status,
                payload: text === '' ? undefined : JSON.parse(text),
              }
            } catch {
              throw new JevError(
                response.status,
                asBody(text),
                `TypeSafe returned HTTP ${response.status} with a body that is not valid JSON`,
              )
            }
          }
          // Unlike the JSON body above, an unreadable non-OK body is not
          // discarded as an empty string: an empty body and an unreadable one
          // are different failures, and folding them together would hide a
          // read failure as if the server had said nothing.
          const text = asBody(await response.text().catch(() => '(body unreadable)'))
          if (!RETRYABLE.has(response.status)) throw new JevError(response.status, text)
          lastStatus = response.status
          lastBody = text
          const stated = retryAfterMs(response.headers.get('retry-after'), Date.now())
          if (stated !== null) waitMs = Math.min(stated, RETRY_AFTER_CEILING_MS)
        } catch (error) {
          if (error instanceof JevError) throw error
          lastStatus = 0
          lastBody = redact(messageOf(error), opts.apiKey)
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
    const refuse = (why: string): JevError =>
      new JevError(status, asBody(safeStringify(payload)), why)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw refuse('TypeSafe returned a body that is not an object')
    }
    const record = payload as {
      answers?: unknown
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    if (
      typeof record.answers !== 'object' ||
      record.answers === null ||
      Array.isArray(record.answers)
    ) {
      throw refuse('TypeSafe returned no answers')
    }
    totals.inputTokens += record.usage?.input_tokens ?? 0
    totals.outputTokens += record.usage?.output_tokens ?? 0
    const answers = record.answers as AnswerBag
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
