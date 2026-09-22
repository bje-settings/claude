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
// **What it deliberately does not add, to `parseArguments`.** No positionals:
// `parseArgs` refuses them and the refusal travels as an envelope, which is
// what every command but one wants; `parseCommandLine` is the widened sibling
// for the one command that needs them (`plugins/audit`'s `/audit:context`,
// #170), so every other caller keeps the untested path closed rather than
// inheriting a positional it never asked for. No `--help` handling: help text
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

/** What a parsed command line answers with when it may carry positionals:
 *  every declared option, and the words `parseArgs` did not consume as one. */
export type CommandLine<S extends ArgSpec> = {
  readonly options: Options<S>
  readonly positionals: readonly string[]
}

/**
 * A spec as the two exports take it. The intersection is what makes
 * {@link Options}'s promise above true rather than merely written down.
 * `const S` at the call site fixes literal types at the argument
 * *expression*, so an inline spec or one declared `as const` keeps its keys
 * and its `choices`; a spec that arrives already annotated `: ArgSpec` does
 * not, and `Options<S>` silently degrades to an index signature, where every
 * value gains `| undefined` and an option nobody declared reads clean.
 * `string extends keyof S` is true of exactly that degraded spec and of
 * nothing else, so it is refused at the call site with the type of the
 * argument named, rather than surfacing later as a missing narrowing the
 * caller works around.
 */
type ExactSpec<S extends ArgSpec> = S & (string extends keyof S ? never : unknown)

/**
 * The core both exports share: build `parseArgs`' own option table from
 * `spec`, audit defaults against their own `choices`, parse, and check the
 * parsed values against `choices` again. `allowPositionals` is the one
 * difference between {@link parseArguments} and {@link parseCommandLine}, so
 * it is a parameter here rather than two copies of the checks around it.
 */
// No {@link ExactSpec} here: both callers already carry that constraint on
// their own type parameter before they reach this function, and repeating it
// on a second, independently inferred type parameter is what defeated `tsc`
// (the two conditional types normalise differently, so the call site's
// already-narrowed spec stopped satisfying the callee's version of the same
// check).
const parseCore = <S extends ArgSpec>(
  argv: readonly string[],
  spec: S,
  allowPositionals: boolean,
): Envelope<CommandLine<S>> => {
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

  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals })
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
    const value = parsed.values[name] as string
    if (!option.choices.includes(value)) {
      return refused(`--${name} must be one of ${option.choices.join(', ')}, not "${value}"`)
    }
  }

  return ok({ options: parsed.values as Options<S>, positionals: parsed.positionals })
}

/**
 * Parse `process.argv.slice(2)` against `spec`. A stray positional is refused
 * here; a command that wants one asks for {@link parseCommandLine} instead
 * (the header says why that is the default).
 *
 * A refusal is exit 2 (`envelope.ts`), carrying node's own wording for an
 * unknown option, a missing value or a stray positional. Its message is not
 * rewritten: node names the offending token, which is what a caller needs,
 * and a tidied spelling would be one this repository then owns.
 */
export const parseArguments = <const S extends ArgSpec>(
  argv: readonly string[],
  spec: ExactSpec<S>,
): Envelope<Options<S>> => {
  const parsed = parseCore(argv, spec, false)
  return parsed.outcome === 'ok' ? ok(parsed.value.options) : parsed
}

/**
 * `parseArguments` widened to also hand back the words `parseArgs` did not
 * consume as an option or its value, for the one command that needs them.
 */
export const parseCommandLine = <const S extends ArgSpec>(
  argv: readonly string[],
  spec: ExactSpec<S>,
): Envelope<CommandLine<S>> => parseCore(argv, spec, true)
