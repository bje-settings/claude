// Cases ported one at a time from the spike's split.test.ts (#164,
// wktr-164-context-audit-spike, spike/context-audit/split.test.ts), as
// independent literal expectations rather than a computed oracle. Order
// follows the spike file so a diff against it is easy to audit.
import { describe, expect, it } from 'vitest'

import { splitMarkdown } from './split.ts'

const FILE = 'a.md'

describe('splitMarkdown', () => {
  it('splits one paragraph of two sentences into two linked sentence units', () => {
    const { units } = splitMarkdown(FILE, 'Foo bar. Baz qux!')
    expect(units).toHaveLength(2)
    expect(units[0]?.id).toBe('a.md:1-1')
    expect(units[1]?.id).toBe('a.md:1-1#2')
    expect(units[0]?.headingPath).toEqual([])
    expect(units[1]?.headingPath).toEqual([])
    expect(units[0]?.next).toBe('Baz qux!')
    expect(units[1]?.prev).toBe('Foo bar.')
  })

  it('never turns an ATX heading into a unit, and pops the heading stack by level', () => {
    const source = [
      '# Top',
      '',
      'Intro sentence.',
      '',
      '## Child',
      '',
      'Child sentence.',
      '',
      '# Second Top ##',
      '',
      'Other sentence.',
    ].join('\n')
    const { units, opaque } = splitMarkdown(FILE, source)
    expect(opaque).toHaveLength(0)
    expect(units.some((u) => u.text.startsWith('#'))).toBe(false)
    expect(units.find((u) => u.text === 'Intro sentence.')?.headingPath).toEqual(['Top'])
    expect(units.find((u) => u.text === 'Child sentence.')?.headingPath).toEqual(['Top', 'Child'])
    // A level-1 heading pops the level-2 child too.
    expect(units.find((u) => u.text === 'Other sentence.')?.headingPath).toEqual(['Second Top'])
  })

  it('turns list items into units, joining a continuation line with one space', () => {
    const source = [
      '- First line of the item',
      '  continued on the next line.',
      '- Second item',
    ].join('\n')
    const { units } = splitMarkdown(FILE, source)
    const items = units.filter((u) => u.block === 'list_item')
    expect(items).toHaveLength(2)
    expect(items[0]?.text).toBe('First line of the item continued on the next line.')
    expect(items[0]?.startLine).toBe(1)
    expect(items[0]?.endLine).toBe(2)
    expect(items[1]?.text).toBe('Second item')
  })

  it('nests three deep, a leaf item leading in from its immediate parent', () => {
    const source = ['- top item', '  - middle item', '    - leaf item'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    const items = units.filter((u) => u.block === 'list_item')
    expect(items).toHaveLength(3)
    expect(items.find((u) => u.text === 'top item')?.leadIn).toBe(null)
    expect(items.find((u) => u.text === 'middle item')?.leadIn).toBe('top item')
    expect(items.find((u) => u.text === 'leaf item')?.leadIn).toBe('middle item')
  })

  it('recognises an ordered list marker the same way as a bullet', () => {
    const source = ['1. first', '2. second'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    const items = units.filter((u) => u.block === 'list_item')
    expect(items.map((u) => u.text)).toEqual(['first', 'second'])
  })
})
