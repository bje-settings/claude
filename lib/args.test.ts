// Argument parsing. The spec below is `mermaid-url.py`'s own command line,
// the first caller this has (#126), so the rows are the cases that script's
// `argparse` answers today rather than invented ones.
import { describe, expect, it } from 'vitest'

import { type ArgSpec, type Options, parseArguments, parseCommandLine } from './args.ts'

// Deliberately not annotated `: ArgSpec`. The annotation widens every key to
// `string` and every value to `OptionSpec`, which collapses `Options<S>` to an
// index signature and quietly throws away both properties the type exists to
// give: one property per declared option, and a value narrowed to the choices
// the option declared. `satisfies ArgSpec` is not the safe alternative it
// looks like: it types `choices` against `readonly string[]`, the literals
// widen, and the narrowing is gone again with nothing refused. Inline, or
// `as const`, and nothing else.
const MERMAID = {
  route: { type: 'string', default: 'view', choices: ['edit', 'ink-img', 'ink-svg', 'view'] },
  theme: { type: 'string', default: 'default' },
  help: { type: 'boolean' },
} as const

// Compile-time assertions, which is the only venue these properties have.
// They run the refusing direction on purpose: a positive declaration like
// `const r: ParsedRoute = 'ink-svg'` compiles whether `ParsedRoute` is the
// union or a bare `string`, so it proves nothing. `@ts-expect-error` fails
// the `types` job when the error it names stops happening, which is exactly
// what would happen if the narrowing were lost. `expect` below only makes the
// constants used; nothing here adds a branch.
type ParsedRoute = Options<typeof MERMAID>['route']
type ParsedTheme = Options<typeof MERMAID>['theme']
const ROUTE: ParsedRoute = 'ink-svg'
const THEME: ParsedTheme = 'forest'
// @ts-expect-error `--route` parses to the choices it declared, so a route it
// never declared is not one of them.
const NOT_A_ROUTE: ParsedRoute = 'ink-pdf'

describe('parseArguments', () => {
  it('answers with every declared option, even on an empty command line', () => {
    // Never partial: each option has a default, so a command reads a value
    // rather than checking for one, and no caller grows a fallback branch for
    // a flag that was not passed.
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
    // `--theme` is deliberately open: Mermaid accepts custom theme names
    // beside its built-in set, so a typo renders with the wrong theme rather
    // than failing, which is what the script does today.
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
    // Exit 2, the status `argparse` uses for a bad command line, so the port
    // keeps what a caller already branches on. node names the offending
    // token, which is the part a user acts on.
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
    // Nothing in front of this takes one, and a stray word on the command
    // line is far more often a quoting mistake than a request.
    const parsed = parseArguments(['diagram.mmd'], MERMAID)
    expect(parsed.outcome).toBe('refused')
    expect(parsed).toMatchObject({ error: expect.stringContaining('diagram.mmd') })
  })

  it("leaves the caller's argv untouched", () => {
    // `parseArgs` takes a mutable array, so the copy is not incidental: a
    // caller passing `process.argv.slice(2)` twice must get the same answer.
    const argv = ['--route', 'edit']
    parseArguments(argv, MERMAID)
    expect(argv).toEqual(['--route', 'edit'])
  })

  it('narrows a value to the choices its option declared, and leaves the rest as text', () => {
    // The assertions are the declarations above, made by `tsc`. A `route`
    // typed `string` would leave the directive on `NOT_A_ROUTE` unused, which
    // `tsc` reports as an error of its own, and would otherwise force every
    // command to re-prove what this parser already refused.
    expect(ROUTE).toBe('ink-svg')
    expect(THEME).toBe('forest')
    expect(NOT_A_ROUTE).toBe('ink-pdf')
  })

  it('refuses a spec that arrives with its literal types already widened', () => {
    // The other half of the same property, and the reason `MERMAID` above is
    // written the way it is. An annotated spec cannot give `Options<S>` one
    // property per option or a narrowed value, so the signature refuses it
    // here rather than handing back a result that silently promises neither.
    const annotated: ArgSpec = { route: { type: 'string', default: 'view' } }
    // @ts-expect-error a widened spec is not assignable to the parameter.
    const parsed = parseArguments([], annotated)
    expect(parsed).toEqual({ outcome: 'ok', value: { route: 'view' } })
  })

  it('reports a default outside its own choices as this code going wrong', () => {
    // Exit 1, not 2. `parseArgs` fills the default in when the flag is
    // absent, so a spec like this refuses every command line, and blaming the
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
    // The verdict is a fact about the spec, so nothing in argv may hide it.
    // Three command lines that each answer before the values are looked at:
    // one that uses the flag correctly, one node cannot parse at all, and one
    // whose earlier option is itself wrong. A `failed` that only surfaces on a
    // clean command line is a programming error a caller can suppress by
    // mistyping, and it is the one verdict they cannot act on themselves.
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
    // The loop over the spec has to skip a boolean rather than read a
    // `choices` it cannot have.
    expect(parseArguments(['--quiet'], { quiet: { type: 'boolean' } })).toEqual({
      outcome: 'ok',
      value: { quiet: true },
    })
  })
})

describe('parseCommandLine', () => {
  it('answers with the options and the positionals a command that widens itself wants', () => {
    // #170's first caller: a command that names issue numbers on the command
    // line rather than through a flag.
    expect(parseCommandLine(['138', '164', '--help'], MERMAID)).toEqual({
      outcome: 'ok',
      value: {
        options: { route: 'view', theme: 'default', help: true },
        positionals: ['138', '164'],
      },
    })
  })
})
