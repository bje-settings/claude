// The output envelope: what a command function answers with, and the one
// place that turns an answer into a stdout/stderr pair and an exit code.
//
// CLAUDE.md states the contract this serves: "a script's exit codes and
// stdout are a contract with the skills/agents that call it". RFC 001
// decision 3 makes the command function the seam, which means the command
// returns a value and the `bin` adapter writes it; an outcome that is a value
// rather than a control-flow event is what keeps that contract checkable by
// the compiler instead of by a reviewer's memory, and what puts back the one
// property the process boundary used to give for free, a failure the caller
// sees as a status.
//
// **Three outcomes, because the scripts have three.** `plugins/mermaid`'s
// `scripts/mermaid-url.py` is the port this round serves (#126): status 0 with
// the URL on stdout, status 2 for a refusal it diagnoses (no diagram on
// stdin, input that is not UTF-8) with the reason on stderr, and status 1 for
// an internal error. Python's `argparse` also exits 2 on a bad flag, so
// `refused` covers argument parsing too (see `args.ts`) and the port keeps
// that status rather than inventing a new one.
//
// This file ships. It imports nothing at all and stays inside the erasable
// subset (ADR 001, RFC 001 decision 12).

/** Anything `JSON.stringify` round-trips, which is what a payload may be. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A JSON object, the shape a payload usually takes. */
export type JsonObject = { [key: string]: JsonValue }

export type ExitCode = 0 | 1 | 2

/**
 * The table, spelled once. A caller responds differently to each, which is the
 * whole reason there is more than "zero or not": a refusal is the caller's
 * input to fix, a failure is this code's.
 */
export const EXIT_CODES: { readonly ok: 0; readonly failed: 1; readonly refused: 2 } = {
  ok: 0,
  failed: 1,
  refused: 2,
}

/**
 * A refusal the command diagnosed, or a failure it did not. Split so that a
 * failure is a type of its own: `Envelope<never>` still admits the success
 * arm, so a value known to be a failure has to say so to be read as one.
 */
export type Failure =
  | { readonly outcome: 'refused'; readonly error: string }
  | { readonly outcome: 'failed'; readonly error: string }

export type Envelope<T> = { readonly outcome: 'ok'; readonly value: T } | Failure

export const ok = <T>(value: T): Envelope<T> => ({ outcome: 'ok', value })

/** Exit 2: the request cannot be carried out as asked, and the reason says why. */
export const refused = (message: string): Failure => ({ outcome: 'refused', error: message })

/** Exit 1: this code went wrong, which is not the caller's input to fix. */
export const failed = (message: string): Failure => ({ outcome: 'failed', error: message })

export const isOk = <T>(envelope: Envelope<T>): envelope is { outcome: 'ok'; value: T } =>
  envelope.outcome === 'ok'

export const exitCodeFor = (envelope: Envelope<unknown>): ExitCode => EXIT_CODES[envelope.outcome]

/** What the process writes and exits with. */
export interface Rendered {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: ExitCode
}

/**
 * A failure writes nothing to stdout.
 *
 * The SurveyMonkey/skills baseline puts `{"error": ...}` on stdout as well,
 * because every one of its callers is an agent prompt reading stdout as JSON.
 * Here stdout is a payload channel a skill may pipe into something else, and
 * the scripts being ported write their refusals to stderr alone. Keeping that
 * means a caller parsing stdout can never parse a refusal into a result,
 * which is the failure this whole contract exists to prevent; the reason is
 * still reported, on the stream a human and an agent both read.
 *
 * Neither string carries a trailing newline: the entry point writes one, and
 * a renderer that embedded it would double-space a caller writing through
 * `console.log`.
 */
const renderFailure = (failure: Failure): Rendered => ({
  stdout: '',
  stderr: failure.error,
  exitCode: EXIT_CODES[failure.outcome],
})

/** A payload rendered as the JSON one line of stdout a caller parses. */
export const renderJson = (envelope: Envelope<JsonValue>): Rendered =>
  envelope.outcome === 'ok'
    ? { stdout: JSON.stringify(envelope.value), stderr: '', exitCode: EXIT_CODES.ok }
    : renderFailure(envelope)

/**
 * A payload that is already the text to print, written verbatim.
 *
 * `mermaid-url.py` prints a bare URL, and its skills read that line as a URL
 * rather than as JSON (#126 is a parity port, so the shape it prints is
 * fixed). Rendering it through {@link renderJson} would wrap it in quotes and
 * escape it, which is a different contract wearing the same exit code.
 */
export const renderText = (envelope: Envelope<string>): Rendered =>
  envelope.outcome === 'ok'
    ? { stdout: envelope.value, stderr: '', exitCode: EXIT_CODES.ok }
    : renderFailure(envelope)
