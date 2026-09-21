import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { splitMarkdown } from './split.ts'

const FILE = 'CLAUDE.md'

/** Strips markdown punctuation from the ends of a word, so "sentence." matches "sentence". */
const stripMdPunct = (w: string): string => w.replace(/^[`*_"'([]+|[`*_"'.,!?:;)\]]+$/g, '')

/**
 * Every unit's claimed lines must actually contain its words, verbatim. Words
 * under 4 characters are skipped for the whole-span containment check (too
 * short to prove anything by coincidence), but the first and last word of the
 * unit must additionally appear on its exact start/end line, so widening a
 * range by one line cannot pass merely because the word occurs somewhere else
 * in the wider span.
 */
const assertLineInvariant = (source: string, units: ReturnType<typeof splitMarkdown>['units']) => {
  const lines = source.split(/\r\n|\r|\n/)
  for (const unit of units) {
    assert.ok(unit.startLine >= 1 && unit.endLine >= unit.startLine, `${unit.id} has a sane range`)
    const span = lines.slice(unit.startLine - 1, unit.endLine).join('\n')

    if (unit.block === 'table_row') {
      const cells = unit.text.split('\n').map((line) => line.slice(line.indexOf(': ') + 2).trim())
      for (const cell of cells) {
        if (cell === '') continue
        assert.ok(
          span.includes(cell),
          `${unit.id}: expected cell "${cell}" within line ${unit.startLine}`,
        )
      }
      continue
    }

    const words = unit.text
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w !== '')
    for (const word of words) {
      if (word.length < 4) continue
      assert.ok(
        span.includes(word),
        `${unit.id}: expected "${word}" within lines ${unit.startLine}-${unit.endLine}`,
      )
    }

    const firstWord = stripMdPunct(words[0] ?? '')
    const lastWord = stripMdPunct(words[words.length - 1] ?? '')
    const startLineText = lines[unit.startLine - 1] ?? ''
    const endLineText = lines[unit.endLine - 1] ?? ''
    if (firstWord !== '') {
      assert.ok(
        startLineText.includes(firstWord),
        `${unit.id}: first word "${firstWord}" not found on start line ${unit.startLine}`,
      )
    }
    if (lastWord !== '') {
      assert.ok(
        endLineText.includes(lastWord),
        `${unit.id}: last word "${lastWord}" not found on end line ${unit.endLine}`,
      )
    }
  }
}

/** Every unit's id must be unique within a run. */
const assertUniqueIds = (units: ReturnType<typeof splitMarkdown>['units']) => {
  const seen = new Set<string>()
  for (const unit of units) {
    assert.ok(!seen.has(unit.id), `duplicate id: ${unit.id}`)
    seen.add(unit.id)
  }
}

test('ATX headings never become units and build a popping headingPath stack', () => {
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
  assert.equal(opaque.length, 0)
  const texts = units.map((u) => u.text)
  assert.ok(!texts.some((t) => t.includes('Top') && t.startsWith('#')))
  const intro = units.find((u) => u.text === 'Intro sentence.')
  assert.deepEqual(intro?.headingPath, ['Top'])
  const child = units.find((u) => u.text === 'Child sentence.')
  assert.deepEqual(child?.headingPath, ['Top', 'Child'])
  const other = units.find((u) => u.text === 'Other sentence.')
  // A level-1 heading pops the level-2 child too.
  assert.deepEqual(other?.headingPath, ['Second Top'])
  assertLineInvariant(source, units)
})

test('list items become units, continuation lines join with one space', () => {
  const source = [
    '- First line of the item',
    '  continued on the next line.',
    '- Second item',
  ].join('\n')
  const { units } = splitMarkdown(FILE, source)
  const items = units.filter((u) => u.block === 'list_item')
  assert.equal(items.length, 2)
  assert.equal(items[0]?.text, 'First line of the item continued on the next line.')
  assert.equal(items[0]?.startLine, 1)
  assert.equal(items[0]?.endLine, 2)
  assert.equal(items[1]?.text, 'Second item')
  assertLineInvariant(source, units)
})

test('nested lists three deep: a leaf item leads in from its immediate parent', () => {
  const source = ['- top item', '  - middle item', '    - leaf item'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  const items = units.filter((u) => u.block === 'list_item')
  assert.equal(items.length, 3)
  const top = items.find((u) => u.text === 'top item')
  const middle = items.find((u) => u.text === 'middle item')
  const leaf = items.find((u) => u.text === 'leaf item')
  assert.equal(top?.leadIn, null)
  assert.equal(middle?.leadIn, 'top item')
  assert.equal(leaf?.leadIn, 'middle item')
  assertLineInvariant(source, units)
})

test('an ordered list marker is recognised the same way as a bullet', () => {
  const source = ['1. first', '2. second'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  const items = units.filter((u) => u.block === 'list_item')
  assert.deepEqual(
    items.map((u) => u.text),
    ['first', 'second'],
  )
})

test('a paragraph line ending in ":" directly before a list becomes leadIn, never a unit', () => {
  const source = ['Read the following:', '', '- alpha', '- beta'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  const texts = units.map((u) => u.text)
  assert.ok(!texts.includes('Read the following:'))
  const items = units.filter((u) => u.block === 'list_item')
  assert.equal(items[0]?.leadIn, 'Read the following:')
  assert.equal(items[1]?.leadIn, 'Read the following:')
  assertLineInvariant(source, units)
})

test('a paragraph ending in ":" NOT directly before a list stays a sentence', () => {
  const source = ['This is a claim:', '', 'It stands alone.'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  const texts = units.map((u) => u.text)
  assert.ok(texts.includes('This is a claim:'))
})

test('sentences split only on . ? ! followed by whitespace then an uppercase/backtick/[ start', () => {
  const source =
    'Foo bar. Baz qux! Is this real? Sure, `run(x)` works. See [the link](https://example.com) too.'
  const { units } = splitMarkdown(FILE, source)
  const texts = units.map((u) => u.text)
  assert.deepEqual(texts, [
    'Foo bar.',
    'Baz qux!',
    'Is this real?',
    'Sure, `run(x)` works.',
    'See [the link](https://example.com) too.',
  ])
})

test('abbreviations do not split, and a period inside a code span does not either', () => {
  const source = 'See the guide, e.g. Foo bar. A span like `x. A y` stays whole. Next one starts.'
  const { units } = splitMarkdown(FILE, source)
  const texts = units.map((u) => u.text)
  assert.deepEqual(texts, [
    'See the guide, e.g. Foo bar.',
    'A span like `x. A y` stays whole.',
    'Next one starts.',
  ])
})

test('a period inside a markdown link does not split', () => {
  const source = 'Read [the docs. See it](https://example.com/a.b) for more. Then this.'
  const { units } = splitMarkdown(FILE, source)
  const texts = units.map((u) => u.text)
  assert.deepEqual(texts, [
    'Read [the docs. See it](https://example.com/a.b) for more.',
    'Then this.',
  ])
})

test('sentence startLine/endLine span exactly the lines the sentence occupies', () => {
  const source = [
    'Line one starts a thought that',
    'wraps onto line two.',
    'A new sentence begins here.',
  ].join('\n')
  const { units } = splitMarkdown(FILE, source)
  assert.equal(units.length, 2)
  assert.equal(units[0]?.startLine, 1)
  assert.equal(units[0]?.endLine, 2)
  assert.equal(units[1]?.startLine, 3)
  assert.equal(units[1]?.endLine, 3)
  assertLineInvariant(source, units)
})

test('GFM table: header and separator are never units, escaped pipes and code-span pipes do not split cells', () => {
  const source = [
    '| Name | Note |',
    '| --- | --- |',
    '| a\\|b | plain |',
    '| `x|y` | code span |',
  ].join('\n')
  const { units } = splitMarkdown(FILE, source)
  assert.equal(units.length, 2)
  assert.ok(units.every((u) => u.block === 'table_row'))
  assert.equal(units[0]?.text, 'Name: a|b\nNote: plain')
  assert.equal(units[1]?.text, 'Name: `x|y`\nNote: code span')
  assert.equal(units[0]?.startLine, 3)
  assert.equal(units[1]?.startLine, 4)
})

test('a table row is rendered as header: cell lines, not JSON, so a backslash or quote reaches later stages verbatim', () => {
  const source = ['| Name | Note |', '| --- | --- |', '| a "quoted" \\value | plain |'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  assert.equal(units[0]?.text, 'Name: a "quoted" \\value\nNote: plain')
})

test('an empty table header cell falls back to col<N>', () => {
  const source = ['|  | Note |', '| --- | --- |', '| a | plain |'].join('\n')
  const { units } = splitMarkdown(FILE, source)
  assert.equal(units[0]?.text, 'col1: a\nNote: plain')
})

test('fenced code with backticks: closes on a fence of the same char and at least the same length', () => {
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
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.kind, 'code')
  assert.equal(opaque[0]?.lang, 'ts')
  assert.equal(opaque[0]?.text, 'const x = 1\n```\nstill inside')
  assert.equal(opaque[0]?.startLine, 3)
  assert.equal(opaque[0]?.endLine, 7)
  assert.deepEqual(
    units.map((u) => u.text),
    ['Intro.', 'After.'],
  )
})

test('mermaid fences are tagged as kind mermaid, tilde fences work the same way', () => {
  const source = ['~~~mermaid', 'graph TD', 'A --> B', '~~~'].join('\n')
  const { opaque } = splitMarkdown(FILE, source)
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.kind, 'mermaid')
  assert.equal(opaque[0]?.lang, 'mermaid')
  assert.equal(opaque[0]?.text, 'graph TD\nA --> B')
})

test('YAML frontmatter is an opaque block, only recognised on line 1', () => {
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
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.kind, 'frontmatter')
  assert.equal(opaque[0]?.text, 'title: Spike\ndraft: true')
  assert.equal(opaque[0]?.startLine, 1)
  assert.equal(opaque[0]?.endLine, 4)
  assert.equal(units.find((u) => u.text === 'Body sentence.')?.headingPath[0], 'Heading')
})

test('HTML comments, blank lines, thematic breaks and blockquote markers produce no units', () => {
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
  const texts = units.map((u) => u.text)
  assert.deepEqual(texts, ['A quoted sentence.', 'A plain sentence.'])
  assertLineInvariant(source, units)
})

test('a fence inside a list item becomes its own opaque block', () => {
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
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.kind, 'code')
  assert.equal(opaque[0]?.text, 'echo hi')
  const items = units.filter((u) => u.block === 'list_item')
  assert.deepEqual(
    items.map((u) => u.text),
    ['an item with code', 'next item'],
  )
})

test('CRLF input is handled with exact line numbers', () => {
  const source = ['# Heading', '', 'A sentence here.', '', '- an item'].join('\r\n')
  const { units } = splitMarkdown(FILE, source)
  const sentence = units.find((u) => u.block === 'sentence')
  assert.equal(sentence?.startLine, 3)
  assert.equal(sentence?.endLine, 3)
  const item = units.find((u) => u.block === 'list_item')
  assert.equal(item?.startLine, 5)
  assertLineInvariant(source, units)
})

test('an empty file produces no units and no opaque blocks', () => {
  const { units, opaque } = splitMarkdown(FILE, '')
  assert.deepEqual(units, [])
  assert.deepEqual(opaque, [])
})

test('prev/next link neighbouring units within the same heading section only', () => {
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
  assert.equal(first?.prev, null)
  assert.equal(first?.next, 'Second sentence.')
  assert.equal(second?.prev, 'First sentence.')
  assert.equal(second?.next, null)
  assert.equal(third?.prev, null)
  assert.equal(third?.next, null)
})

test('refs is always empty from the splitter', () => {
  const { units, opaque } = splitMarkdown(FILE, ['- item one', '', '```', 'code', '```'].join('\n'))
  for (const u of units) assert.deepEqual(u.refs, [])
  for (const o of opaque) assert.deepEqual(o.refs, [])
})

test('splitting the real CLAUDE.md: every unit obeys the line-number invariant and has non-empty text', () => {
  const source = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8')
  const { units, opaque } = splitMarkdown('CLAUDE.md', source)
  assert.ok(units.length > 0, 'CLAUDE.md should produce at least one unit')
  for (const unit of units) {
    assert.ok(unit.text.trim().length > 0, `${unit.id} has non-empty text`)
  }
  assertLineInvariant(source, units)
  for (const block of opaque) {
    assert.ok(
      block.startLine >= 1 && block.endLine >= block.startLine,
      `${block.file} opaque block has a sane range`,
    )
  }
  assertUniqueIds(units)

  // path-docs-adr.md carries two sentences on one source line (its Context
  // section), which used to collide on one id before ids were disambiguated.
  const adrPath = '.claude/rules/path-docs-adr.md'
  const adrSource = readFileSync(new URL(`../../${adrPath}`, import.meta.url), 'utf8')
  const { units: adrUnits } = splitMarkdown(adrPath, adrSource)
  assertUniqueIds(adrUnits)
})

test('prose between two comments on one line is kept, not skipped as a comment', () => {
  const { units } = splitMarkdown('a.md', '<!-- a --> Kept text here. <!-- b -->\n')
  assert.equal(units.length, 1)
  assert.ok(units[0]?.text.includes('Kept text here.'))
})

test('a comment holding only its markers is still a full comment', () => {
  assert.equal(splitMarkdown('a.md', '<!---->\n<!-- -->\n').units.length, 0)
})

test('two sentences on the same source line get distinct ids, the second suffixed', () => {
  const source = 'Foo bar. Baz qux!'
  const { units } = splitMarkdown('a.md', source)
  assert.equal(units.length, 2)
  assert.equal(units[0]?.id, 'a.md:1-1')
  assert.equal(units[1]?.id, 'a.md:1-1#2')
})

test('a third unit sharing a span gets #3', () => {
  const source = 'One. Two. Three sentences here.'
  const { units } = splitMarkdown('a.md', source)
  assert.equal(units.length, 3)
  assert.deepEqual(
    units.map((u) => u.id),
    ['a.md:1-1', 'a.md:1-1#2', 'a.md:1-1#3'],
  )
})

test('list items come out in document order even when a sibling closes before its parent', () => {
  const source = ['- A', '  - B', '  - C', '- D'].join('\n')
  const { units } = splitMarkdown('a.md', source)
  const items = units.filter((u) => u.block === 'list_item')
  assert.deepEqual(
    items.map((u) => u.text),
    ['A', 'B', 'C', 'D'],
  )
  const a = items.find((u) => u.text === 'A')
  const b = items.find((u) => u.text === 'B')
  const d = items.find((u) => u.text === 'D')
  assert.equal(a?.next, 'B')
  assert.equal(b?.prev, 'A')
  assert.equal(d?.prev, 'C')
})

test('three levels deep, nested lists also come out in document order', () => {
  const source = ['- A', '  - B', '    - C', '    - D', '  - E', '- F'].join('\n')
  const { units } = splitMarkdown('a.md', source)
  const items = units.filter((u) => u.block === 'list_item')
  assert.deepEqual(
    items.map((u) => u.text),
    ['A', 'B', 'C', 'D', 'E', 'F'],
  )
})

test('a fenced block inside a blockquote closes on the quoted closing fence', () => {
  const source = '# T\n\n> ```bash\n> ls\n> ```\n\nRule after quote.\n'
  const { units, opaque } = splitMarkdown('a.md', source)
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.kind, 'code')
  assert.equal(opaque[0]?.lang, 'bash')
  assert.equal(opaque[0]?.text, 'ls')
  assert.equal(opaque[0]?.startLine, 3)
  assert.equal(opaque[0]?.endLine, 5)
  assert.deepEqual(
    units.map((u) => u.text),
    ['Rule after quote.'],
  )
})

test('an unclosed fence still runs to EOF and warns', () => {
  const source = ['Intro.', '', '```ts', 'const x = 1'].join('\n')
  const { opaque, warnings } = splitMarkdown('a.md', source)
  assert.equal(opaque.length, 1)
  assert.equal(opaque[0]?.endLine, 4)
  assert.deepEqual(warnings, [{ file: 'a.md', line: 3, kind: 'unclosed_fence' }])
})

test('an unclosed HTML comment warns and does not swallow the rest of the file', () => {
  const source = ['<!-- never closes', '', 'A sentence after.'].join('\n')
  const { units, warnings } = splitMarkdown('a.md', source)
  assert.deepEqual(warnings, [{ file: 'a.md', line: 1, kind: 'unclosed_comment' }])
  assert.deepEqual(
    units.map((u) => u.text),
    ['A sentence after.'],
  )
})

test('text after --> on a multi-line comment close line is kept as paragraph text', () => {
  const source = ['<!-- comment', 'spans b --> Trailing rule.'].join('\n')
  const { units, warnings } = splitMarkdown('a.md', source)
  assert.equal(warnings.length, 0)
  assert.deepEqual(
    units.map((u) => u.text),
    ['Trailing rule.'],
  )
  assert.equal(units[0]?.startLine, 2)
  assert.equal(units[0]?.endLine, 2)
})
