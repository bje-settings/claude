// Tests for the parser in this file. The spec below is `mermaid-url.py`'s
// own command line, the first caller this file has (#126). The rows are the
// cases that script's `argparse` answers today, not invented ones.
import { describe, expect, it } from 'vitest'

import { type ArgSpec, type Options, parseArguments, parseCommandLine } from '#lib/args.ts'

// Deliberately not annotated `: ArgSpec`. The annotation widens every key
// to `string`, and every value to `OptionSpec`. This collapses `Options<S>`
// to an index signature. It also throws away both properties that the type
// exists to give. These are one property per declared option, and a value
// narrowed to the choices the option declared.
//
// `satisfies ArgSpec` is not the safe alternative it looks like. It types
// `choices` against `readonly string[]`, so the literals widen. The
// narrowing is then gone again, with nothing refused. Only an inline spec,
// or one declared `as const`, keeps it.
const MERMAID = {
  route: { type: 'string', default: 'view', choices: ['edit', 'ink-img', 'ink-svg', 'view'] },
  theme: { type: 'string', default: 'default' },
  help: { type: 'boolean' },
} as const

// Compile-time assertions. This is the only venue these properties have.
// On purpose, they test that `tsc` refuses a bad value, not that a good
// one compiles.
//
// A positive declaration like `const r: ParsedRoute = 'ink-svg'` compiles
// whether `ParsedRoute` is the union or a bare `string`. So it proves
// nothing. `@ts-expect-error` fails the `types` job when the error it names
// no longer happens. That is exactly what would happen if the narrowing
// were lost.
//
// `expect` below only makes the constants used. It adds no branch here.
type ParsedRoute = Options<typeof MERMAID>['route']
type ParsedTheme = Options<typeof MERMAID>['theme']
const ROUTE: ParsedRoute = 'ink-svg'
const THEME: ParsedTheme = 'forest'
// @ts-expect-error `--route` parses to the choices it declared. A route it
// never declared is not one of them.
const NOT_A_ROUTE: ParsedRoute = 'ink-pdf'

describe('parseArguments', () => {
  it('answers with every declared option, even on an empty command line', () => {
    // Never partial: each option has a default. A command reads a value,
    // and does not need to check for one. No caller grows a fallback
    // branch for a flag that was not passed.
    expect(parseArguments([], MERMAID)).toEqual({
      outcome: 'ok',
      value: { route: 'view', theme: 'default', help: false },
    })
  })

  it('reads a value flag and a boolean flag', () => {
    expect(parseArguments(['--route', 'ink-svg', '--theme', 'forest', '--help'], MERMAID)).toEqual({
      outcome: 'ok',
      value: { route: 'ink-svg', theme: 'forest', help: true },
    })
  })

  it('accepts the --flag=value spelling', () => {
    const parsed = parseArguments(['--route=edit'], MERMAID)
    expect(parsed).toEqual({
      outcome: 'ok',
      value: { route: 'edit', theme: 'default', help: false },
    })
  })

  it('passes a value through unrestricted when the option declares no choices', () => {
    // `--theme` is deliberately open. Mermaid accepts custom theme names
    // beside its built-in set. A typo then renders with the wrong theme,
    // rather than fail. That is what the script does today.
    expect(parseArguments(['--theme', 'whatever'], MERMAID)).toMatchObject({
      outcome: 'ok',
      value: { theme: 'whatever' },
    })
  })

  it('refuses a value outside the declared choices, naming them', () => {
    const parsed = parseArguments(['--route', 'ink-pdf'], MERMAID)
    expect(parsed).toEqual({
      outcome: 'refused',
      error: '--route must be one of edit, ink-img, ink-svg, view, not "ink-pdf"',
    })
  })

  it("refuses an unknown flag, carrying node's own wording", () => {
    // Exit 2 is the status `argparse` uses for a bad command line. The
    // port keeps what a caller already branches on. node names the token
    // that is wrong, which is the part a user acts on.
    const parsed = parseArguments(['--rout', 'edit'], MERMAID)
    expect(parsed.outcome).toBe('refused')
    expect(parsed).toMatchObject({ error: expect.stringContaining('--rout') })
  })

  it('refuses a value flag with no value', () => {
    const parsed = parseArguments(['--route'], MERMAID)
    expect(parsed.outcome).toBe('refused')
    expect(parsed).toMatchObject({ error: expect.stringContaining('route') })
  })

  it('refuses a positional', () => {
    // Nothing in front of this takes a positional. A stray word on the
    // command line is far more often a quoting mistake than a request.
    const parsed = parseArguments(['diagram.mmd'], MERMAID)
    expect(parsed.outcome).toBe('refused')
    expect(parsed).toMatchObject({ error: expect.stringContaining('diagram.mmd') })
  })

  it("leaves the caller's argv untouched", () => {
    // `parseArgs` takes a mutable array, so the copy here is not
    // incidental. A caller that passes `process.argv.slice(2)` twice must
    // get the same answer.
    const argv = ['--route', 'edit']
    parseArguments(argv, MERMAID)
    expect(argv).toEqual(['--route', 'edit'])
  })

  it('narrows a value to the choices its option declared, and leaves the rest as text', () => {
    // The assertions are the declarations above, checked by `tsc`. A
    // `route` typed `string` would leave the directive on `NOT_A_ROUTE`
    // unused. `tsc` reports that as an error of its own. Without it, every
    // command would have to re-prove what this parser already refused.
    expect(ROUTE).toBe('ink-svg')
    expect(THEME).toBe('forest')
    expect(NOT_A_ROUTE).toBe('ink-pdf')
  })

  it('refuses a spec that arrives with its literal types already widened', () => {
    // This is the other half of the same property, and the reason
    // `MERMAID` above is written the way it is. An annotated spec cannot
    // give `Options<S>` one property per option, or a narrowed value. The
    // signature refuses it here. It does not hand back a result that
    // silently promises neither.
    const annotated: ArgSpec = { route: { type: 'string', default: 'view' } }
    // @ts-expect-error a widened spec is not assignable to the parameter.
    const parsed = parseArguments([], annotated)
    expect(parsed).toEqual({ outcome: 'ok', value: { route: 'view' } })
  })

  it('reports a default outside its own choices as this code going wrong', () => {
    // Exit 1, not 2. `parseArgs` fills in the default when the flag is
    // absent, so a spec like this refuses every command line. To blame the
    // caller for a flag they never typed is a refusal they cannot act on.
    expect(
      parseArguments([], {
        route: { type: 'string', default: 'ink-pdf', choices: ['edit', 'view'] },
      }),
    ).toEqual({
      outcome: 'failed',
      error: '--route declares a default of "ink-pdf", which is not one of edit, view',
    })
  })

  it('reports a bad default whatever the command line says', () => {
    // The verdict is a fact about the spec, so nothing in argv may hide
    // it. Three command lines each answer before the values are read.
    // One uses the flag correctly. One is a command line node cannot
    // parse at all. One has an earlier option that is itself wrong.
    //
    // A `failed` that surfaces only on a clean command line is a
    // programming error. A caller could otherwise hide the error, simply
    // because the command line happened to be correct. It is the one
    // verdict they cannot act on themselves.
    const BAD = { type: 'string', default: 'ink-pdf', choices: ['edit', 'view'] } as const
    const badDefault = {
      outcome: 'failed',
      error: '--route declares a default of "ink-pdf", which is not one of edit, view',
    }
    expect(parseArguments(['--route', 'edit'], { route: BAD })).toEqual(badDefault)
    expect(parseArguments(['--nope'], { route: BAD })).toEqual(badDefault)
    expect(
      parseArguments(['--theme', 'nonsense'], {
        theme: { type: 'string', default: 'default', choices: ['default', 'forest'] },
        route: BAD,
      }),
    ).toEqual(badDefault)
  })

  it('checks choices on a spec that declares only a boolean', () => {
    // The loop over the spec must skip a boolean. It cannot read a
    // `choices` value that a boolean does not have.
    expect(parseArguments(['--quiet'], { quiet: { type: 'boolean' } })).toEqual({
      outcome: 'ok',
      value: { quiet: true },
    })
  })
})

describe('parseCommandLine', () => {
  it('answers with the options and the positionals a command that widens itself wants', () => {
    // This is #170's first caller: a command that names issue numbers on
    // the command line, instead of through a flag.
    expect(parseCommandLine(['138', '164', '--help'], MERMAID)).toEqual({
      outcome: 'ok',
      value: {
        options: { route: 'view', theme: 'default', help: true },
        positionals: ['138', '164'],
      },
    })
  })

  it('answers with no positionals on a command line that names none', () => {
    // Never partial, the same promise `parseArguments` makes for options.
    // `positionals` is always an array, empty instead of absent.
    expect(parseCommandLine([], MERMAID)).toEqual({
      outcome: 'ok',
      value: { options: { route: 'view', theme: 'default', help: false }, positionals: [] },
    })
  })

  it('still refuses a bad flag, exactly as parseArguments does', () => {
    // The core is shared. Only `allowPositionals` differs, so a bad flag
    // or a bad choice is refused before positionals ever enter it.
    expect(parseCommandLine(['--route', 'ink-pdf'], MERMAID)).toEqual({
      outcome: 'refused',
      error: '--route must be one of edit, ink-img, ink-svg, view, not "ink-pdf"',
    })
  })
})

it('parseArguments still refuses a positional now that parseCommandLine exists beside it', () => {
  // The split is `allowPositionals` alone. A caller of the narrower
  // function must still receive the narrower refusal. It must not silently
  // widen because the shared core learned to allow a positional.
  expect(parseArguments(['138'], MERMAID)).toMatchObject({ outcome: 'refused' })
})
