// Argument parsing, over `node:util`'s `parseArgs` (#125's scope line names
// it). Written once here rather than in each `bin`, because RFC 001 decision
// 3 keeps `bin` a thin adapter with no decisions in it, and because a parse
// with a return value is testable without a process.
//
// **What this adds to `parseArgs`, and why each addition has a caller.** node
// answers a bad command line by throwing a `TypeError`, which a `bin` would
// have to catch and translate; here it comes back as a `refused` envelope, so
// a bad flag exits 2 exactly as `argparse` does in the scripts being ported.
// `choices` is the one piece of `argparse` node has no answer for, and
// `mermaid-url.py`'s `--route` is the caller that needs it (#126).
//
// **What it deliberately does not add.** No positionals: `parseArgs` refuses
// them and the refusal travels as an envelope, which is what the one command
// in front of this wants, and a command that needs them can widen this with a
// test rather than inherit an untested path. No `--help` handling: help text
// is a command's own sentence about itself, so a command declares a `help`
// boolean and prints its own, which is one line there against a text
// generator here that every command would then have to fit.
//
// This file ships. It imports nothing outside the root lib and nothing from
// node beyond `util`, and stays inside the erasable subset (ADR 001).

import { parseArgs } from 'node:util'

import { type Envelope, failed, ok, refused } from './envelope.ts'

/**
 * One option. A string option carries a default, rather than admitting
 * `undefined`: every read is then a value, so no caller needs a fallback
 * branch for "the flag was not passed" that a test would have to reach.
 * A command that wants to know whether a flag was passed at all asks for a
 * boolean beside it.
 */
export type OptionSpec =
  | { readonly type: 'boolean' }
  | { readonly type: 'string'; readonly default: string; readonly choices?: readonly string[] }

export type ArgSpec = Readonly<Record<string, OptionSpec>>

/**
 * What one option parses to. An option that declares `choices` parses to
 * those choices and not to a bare `string`: the check below refuses anything
 * else before the envelope is built, so the narrower type is a fact about the
 * value rather than a hope, and a command switching on it does not re-prove
 * what the parser already refused.
 */
type ValueOf<S extends OptionSpec> = S extends { type: 'boolean' }
  ? boolean
  : S extends { choices: readonly (infer C extends string)[] }
    ? C
    : string

/** The parsed command line: one property per declared option, never partial. */
export type Options<S extends ArgSpec> = { readonly [K in keyof S]: ValueOf<S[K]> }

/**
 * Parse `process.argv.slice(2)` against `spec`.
 *
 * A refusal is exit 2 (`envelope.ts`), carrying node's own wording for an
 * unknown option, a missing value or a stray positional. Its message is not
 * rewritten: node names the offending token, which is what a caller needs,
 * and a tidied spelling would be one this repository then owns.
 */
export const parseArguments = <const S extends ArgSpec>(
  argv: readonly string[],
  spec: S,
): Envelope<Options<S>> => {
  const options: Record<string, { type: 'string' | 'boolean'; default: string | boolean }> = {}
  for (const [name, option] of Object.entries(spec)) {
    if (option.type === 'boolean') {
      options[name] = { type: 'boolean', default: false }
      continue
    }
    // A default outside the option's own choices is `failed` and not
    // `refused`, because `parseArgs` fills the default in whenever the flag is
    // absent: such a spec refuses every command line, naming a flag the caller
    // never typed and cannot correct. `envelope.ts` states the split this
    // keeps, that a refusal is the caller's input to fix and a failure is this
    // code's.
    //
    // Audited here, over the spec alone and before the command line is parsed,
    // so the verdict does not depend on argv. Asked from the loop below it
    // would lose to whatever returned first: an unparsable command line, or an
    // earlier option's bad value, would answer `refused` and leave the broken
    // spec unreported for as long as anyone kept mistyping.
    if (option.choices !== undefined && !option.choices.includes(option.default)) {
      return failed(
        `--${name} declares a default of "${option.default}", ` +
          `which is not one of ${option.choices.join(', ')}`,
      )
    }
    options[name] = { type: 'string', default: option.default }
  }

  let values: Record<string, unknown>
  try {
    values = parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }).values
  } catch (error) {
    // `parseArgs` throws a `TypeError` and nothing else, so the message is
    // read directly. An `instanceof` guard here would add an arm no input can
    // reach, which is the branch the coverage rule says to restructure away
    // rather than to exclude.
    return refused((error as Error).message)
  }

  for (const [name, option] of Object.entries(spec)) {
    if (option.type !== 'string' || option.choices === undefined) continue
    // Every declared option has a default, so this is a string by
    // construction; the cast is erased and adds no branch.
    const value = values[name] as string
    if (!option.choices.includes(value)) {
      return refused(`--${name} must be one of ${option.choices.join(', ')}, not "${value}"`)
    }
  }

  return ok(values as Options<S>)
}
