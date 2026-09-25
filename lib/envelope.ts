// The output envelope: what a command function answers with. This file
// holds the one place that turns an answer into a stdout and stderr pair,
// plus an exit code.
//
// CLAUDE.md states the contract this serves. It reads: "a script's exit
// codes and stdout are a contract with the skills and agents that call
// it". RFC 001 decision 3 makes the command function the seam. The command
// returns a value, and the `bin` adapter writes it.
//
// An outcome that is a value, not a control-flow event, keeps that
// contract checkable by the compiler. It does not rely on a reviewer's
// memory. It also puts back one property the process boundary used to
// give for free. That property is a failure the caller sees as a status.
//
// **Three outcomes, because the scripts have three.** `plugins/mermaid`'s
// `scripts/mermaid-url.py` is the port this round serves (#126). It answers
// with status 0 and the URL on stdout.
//
// It answers with status 2 for a refusal it diagnoses. Examples are no
// diagram on stdin, or input that is not UTF-8. It gives the reason on
// stderr. It answers with status 1 for an internal error.
//
// Python's `argparse` also exits 2 on a bad flag. `refused` also covers a
// bad argument (see `args.ts`). The port keeps that same status, rather
// than invent a new one.
//
// This file ships. It imports nothing at all, and stays inside the erasable
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
 * The table, spelled once. A caller responds differently to each. This is
 * the whole reason there is more than "zero or not." A refusal is the
 * caller's input to fix. A failure is this code's own fault.
 */
export const EXIT_CODES: { readonly ok: 0; readonly failed: 1; readonly refused: 2 } = {
  ok: 0,
  failed: 1,
  refused: 2,
}

/**
 * A refusal the command diagnosed, or a failure it did not. This is split
 * so a failure is a type of its own. `Envelope<never>` still admits the
 * success arm. A value known to be a failure must say so, to be read as
 * one.
 */
export type Failure =
  | { readonly outcome: 'refused'; readonly error: string }
  | { readonly outcome: 'failed'; readonly error: string }

export type Envelope<T> = { readonly outcome: 'ok'; readonly value: T } | Failure

export const ok = <T>(value: T): Envelope<T> => ({ outcome: 'ok', value })

/** Exit 2: the request cannot be carried out as asked. The reason says why. */
export const refused = (message: string): Failure => ({ outcome: 'refused', error: message })

/** Exit 1: this code went wrong. This is not the caller's input to fix. */
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
 * The SurveyMonkey/skills baseline puts `{"error": ...}` on stdout as well.
 * Every one of its callers is an agent prompt that reads stdout as JSON.
 * Here, stdout is a payload channel a skill may pipe into something else.
 * The scripts this file ports write their refusals to stderr alone.
 *
 * This choice means a caller that parses stdout can never read a refusal
 * as a result. That is the failure this whole contract exists to prevent.
 * The reason is still reported, on the stream a human and an agent both
 * read.
 *
 * Neither string carries a trailing newline. The entry point writes one.
 * A renderer that embedded it would double-space output for a caller that
 * writes through `console.log`.
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
 * `mermaid-url.py` prints a bare URL. Its skills read that line as a URL,
 * not as JSON. #126 is a parity port, so the shape it prints is fixed. To
 * render it through {@link renderJson} would wrap it in quotes and escape
 * it. That would be a different contract, with the same exit code.
 */
export const renderText = (envelope: Envelope<string>): Rendered =>
  envelope.outcome === 'ok'
    ? { stdout: envelope.value, stderr: '', exitCode: EXIT_CODES.ok }
    : renderFailure(envelope)
