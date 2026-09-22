// Cases ported one at a time from the spike's split.test.ts (#164,
// wktr-164-context-audit-spike, spike/context-audit/split.test.ts), as
// independent literal expectations rather than a computed oracle. Order
// follows the spike file so a diff against it is easy to audit.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { splitMarkdown } from './split.ts'

const FILE = 'a.md'
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

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

  it('turns a paragraph line ending in ":" directly before a list into leadIn, never a unit', () => {
    const source = ['Read the following:', '', '- alpha', '- beta'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).not.toContain('Read the following:')
    const items = units.filter((u) => u.block === 'list_item')
    expect(items[0]?.leadIn).toBe('Read the following:')
    expect(items[1]?.leadIn).toBe('Read the following:')
  })

  it('keeps a paragraph ending in ":" a sentence when no list directly follows', () => {
    const source = ['This is a claim:', '', 'It stands alone.'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).toContain('This is a claim:')
  })

  it('splits sentences only on . ? ! followed by whitespace then an uppercase/backtick/[ start', () => {
    const source =
      'Foo bar. Baz qux! Is this real? Sure, `run(x)` works. See [the link](https://example.com) too.'
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).toEqual([
      'Foo bar.',
      'Baz qux!',
      'Is this real?',
      'Sure, `run(x)` works.',
      'See [the link](https://example.com) too.',
    ])
  })

  it('does not split on an abbreviation, or on a period inside a code span', () => {
    const source = 'See the guide, e.g. Foo bar. A span like `x. A y` stays whole. Next one starts.'
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).toEqual([
      'See the guide, e.g. Foo bar.',
      'A span like `x. A y` stays whole.',
      'Next one starts.',
    ])
  })

  it('does not split on a period inside a markdown link', () => {
    const source = 'Read [the docs. See it](https://example.com/a.b) for more. Then this.'
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).toEqual([
      'Read [the docs. See it](https://example.com/a.b) for more.',
      'Then this.',
    ])
  })

  it('gives a hard-wrapped sentence a startLine/endLine spanning exactly the lines it occupies', () => {
    const source = [
      'Line one starts a thought that',
      'wraps onto line two.',
      'A new sentence begins here.',
    ].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units).toHaveLength(2)
    expect(units[0]?.startLine).toBe(1)
    expect(units[0]?.endLine).toBe(2)
    expect(units[1]?.startLine).toBe(3)
    expect(units[1]?.endLine).toBe(3)
  })

  it('turns a GFM table into header: cell rows, never units for the header or separator', () => {
    const source = [
      '| Name | Note |',
      '| --- | --- |',
      '| a\\|b | plain |',
      '| `x|y` | code span |',
    ].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units).toHaveLength(2)
    expect(units.every((u) => u.block === 'table_row')).toBe(true)
    expect(units[0]?.text).toBe('Name: a|b\nNote: plain')
    expect(units[1]?.text).toBe('Name: `x|y`\nNote: code span')
    expect(units[0]?.startLine).toBe(3)
    expect(units[1]?.startLine).toBe(4)
  })

  it('renders a table row as header: cell lines, not JSON, so quotes and backslashes reach verbatim', () => {
    const source = ['| Name | Note |', '| --- | --- |', '| a "quoted" \\value | plain |'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units[0]?.text).toBe('Name: a "quoted" \\value\nNote: plain')
  })

  it('falls an empty table header cell back to col<N>', () => {
    const source = ['|  | Note |', '| --- | --- |', '| a | plain |'].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units[0]?.text).toBe('col1: a\nNote: plain')
  })

  it('closes a backtick fence on a fence of the same char and at least the same length', () => {
    const source = [
      'Intro.',
      '',
      '````ts',
      'const x = 1',
      '```',
      'still inside',
      '````',
      '',
      'After.',
    ].join('\n')
    const { units, opaque } = splitMarkdown(FILE, source)
    expect(opaque).toHaveLength(1)
    expect(opaque[0]?.kind).toBe('code')
    expect(opaque[0]?.lang).toBe('ts')
    expect(opaque[0]?.text).toBe('const x = 1\n```\nstill inside')
    expect(opaque[0]?.startLine).toBe(3)
    expect(opaque[0]?.endLine).toBe(7)
    expect(units.map((u) => u.text)).toEqual(['Intro.', 'After.'])
  })

  it('tags a mermaid fence with kind mermaid, and tilde fences work the same way', () => {
    const source = ['~~~mermaid', 'graph TD', 'A --> B', '~~~'].join('\n')
    const { opaque } = splitMarkdown(FILE, source)
    expect(opaque).toHaveLength(1)
    expect(opaque[0]?.kind).toBe('mermaid')
    expect(opaque[0]?.lang).toBe('mermaid')
    expect(opaque[0]?.text).toBe('graph TD\nA --> B')
  })

  it('reads YAML frontmatter as an opaque block, only when line 1 opens it', () => {
    const source = [
      '---',
      'title: Spike',
      'draft: true',
      '---',
      '',
      '# Heading',
      '',
      'Body sentence.',
    ].join('\n')
    const { units, opaque } = splitMarkdown(FILE, source)
    expect(opaque).toHaveLength(1)
    expect(opaque[0]?.kind).toBe('frontmatter')
    expect(opaque[0]?.text).toBe('title: Spike\ndraft: true')
    expect(opaque[0]?.startLine).toBe(1)
    expect(opaque[0]?.endLine).toBe(4)
    expect(units.find((u) => u.text === 'Body sentence.')?.headingPath[0]).toBe('Heading')
  })

  it('produces no units for HTML comments, blank lines, thematic breaks or blockquote markers', () => {
    const source = [
      '<!-- a full-line comment -->',
      '',
      '***',
      '',
      '> A quoted sentence.',
      '',
      '<!-- a multi-line',
      'comment that spans lines -->',
      '',
      'A plain sentence.',
    ].join('\n')
    const { units } = splitMarkdown(FILE, source)
    expect(units.map((u) => u.text)).toEqual(['A quoted sentence.', 'A plain sentence.'])
  })

  it('turns a fence inside a list item into its own opaque block', () => {
    const source = [
      '- an item with code',
      '',
      '  ```bash',
      '  echo hi',
      '  ```',
      '',
      '- next item',
    ].join('\n')
    const { units, opaque } = splitMarkdown(FILE, source)
    expect(opaque).toHaveLength(1)
    expect(opaque[0]?.kind).toBe('code')
    expect(opaque[0]?.text).toBe('echo hi')
    const items = units.filter((u) => u.block === 'list_item')
    expect(items.map((u) => u.text)).toEqual(['an item with code', 'next item'])
  })

  it('handles CRLF input with exact line numbers', () => {
    const source = ['# Heading', '', 'A sentence here.', '', '- an item'].join('\r\n')
    const { units } = splitMarkdown(FILE, source)
    const sentence = units.find((u) => u.block === 'sentence')
    expect(sentence?.startLine).toBe(3)
    expect(sentence?.endLine).toBe(3)
    const item = units.find((u) => u.block === 'list_item')
    expect(item?.startLine).toBe(5)
  })

  it('produces no units and no opaque blocks for an empty file', () => {
    const { units, opaque } = splitMarkdown(FILE, '')
    expect(units).toEqual([])
    expect(opaque).toEqual([])
  })

  it('links prev/next only within the same heading section', () => {
    const source = [
      '# Section',
      '',
      'First sentence.',
      '',
      'Second sentence.',
      '',
      '## Sub',
      '',
      'Third sentence.',
    ].join('\n')
    const { units } = splitMarkdown(FILE, source)
    const first = units.find((u) => u.text === 'First sentence.')
    const second = units.find((u) => u.text === 'Second sentence.')
    const third = units.find((u) => u.text === 'Third sentence.')
    expect(first?.prev).toBe(null)
    expect(first?.next).toBe('Second sentence.')
    expect(second?.prev).toBe('First sentence.')
    expect(second?.next).toBe(null)
    expect(third?.prev).toBe(null)
    expect(third?.next).toBe(null)
  })

  it('leaves refs empty from the splitter, on units and opaque blocks alike', () => {
    const { units, opaque } = splitMarkdown(
      FILE,
      ['- item one', '', '```', 'code', '```'].join('\n'),
    )
    for (const u of units) expect(u.refs).toEqual([])
    for (const o of opaque) expect(o.refs).toEqual([])
  })

  // A fixture with hand-written expected units, standing in for the spike's
  // real-CLAUDE.md line-invariant check: that check computed its expectations
  // from the source it was checking, which is a tautological test, and it
  // read this repository's own CLAUDE.md, which a plugin meant to work on any
  // repository cannot depend on. Every expectation below is a literal typed
  // by hand against fixtures/sample.fixture.md.
  it('splits a hand-written fixture into the exact units it was written to produce', () => {
    const source = readFileSync(path.join(FIXTURES, 'sample.fixture.md'), 'utf8')
    const { units } = splitMarkdown('sample.fixture.md', source)

    const intro = units.find((u) => u.text === 'Intro sentence here.')
    const second = units.find((u) => u.text === 'Second one follows.')
    expect(intro?.id).toBe('sample.fixture.md:3-3')
    expect(second?.id).toBe('sample.fixture.md:3-3#2')
    expect(intro?.headingPath).toEqual(['Guide'])
    expect(intro?.next).toBe('Second one follows.')
    expect(second?.prev).toBe('Intro sentence here.')

    const items = units.filter((u) => u.block === 'list_item')
    expect(items.map((u) => u.text)).toEqual(['First item', 'Second item'])
    expect(items[0]?.startLine).toBe(7)
    expect(items[0]?.headingPath).toEqual(['Guide', 'Details'])
    expect(items[0]?.next).toBe('Second item')
    expect(items[1]?.prev).toBe('First item')

    const row = units.find((u) => u.block === 'table_row')
    expect(row?.text).toBe('Name: a\nNote: b')
    expect(row?.startLine).toBe(12)
    expect(row?.headingPath).toEqual(['Guide', 'Details'])
  })

  it('keeps prose between two comments on one line, rather than skipping it as a comment', () => {
    const { units } = splitMarkdown('a.md', '<!-- a --> Kept text here. <!-- b -->\n')
    expect(units).toHaveLength(1)
    expect(units[0]?.text.includes('Kept text here.')).toBe(true)
  })

  it('treats a comment holding only its own markers as a full comment', () => {
    expect(splitMarkdown('a.md', '<!---->\n<!-- -->\n').units).toHaveLength(0)
  })
})
