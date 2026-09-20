// Argument parsing. The spec below is `mermaid-url.py`'s own command line,
// the first caller this has (#126), so the rows are the cases that script's
// `argparse` answers today rather than invented ones.
import { describe, expect, it } from 'vitest'

import { type ArgSpec, parseArguments } from './args.ts'

const MERMAID: ArgSpec = {
  route: { type: 'string', default: 'view', choices: ['edit', 'ink-img', 'ink-svg', 'view'] },
  theme: { type: 'string', default: 'default' },
  help: { type: 'boolean' },
}

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

  it('checks choices on a spec that declares only a boolean', () => {
    // The loop over the spec has to skip a boolean rather than read a
    // `choices` it cannot have.
    expect(parseArguments(['--quiet'], { quiet: { type: 'boolean' } })).toEqual({
      outcome: 'ok',
      value: { quiet: true },
    })
  })
})
