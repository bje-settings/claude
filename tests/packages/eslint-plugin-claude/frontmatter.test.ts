import { describe, expect, it } from 'vitest'
import { parseFrontmatter, stringField } from '#eslint-plugin-claude/frontmatter.ts'

describe('parseFrontmatter', () => {
  it('reads a mapping, folded scalars included', () => {
    expect(parseFrontmatter('name: a\ndescription: >-\n  one\n  two\n')).toEqual({
      name: 'a',
      description: 'one two',
    })
  })

  it('gives null for YAML that does not parse', () => {
    expect(parseFrontmatter('description: [unclosed')).toBeNull()
  })

  it('gives null when the top level is not a mapping', () => {
    expect(parseFrontmatter('')).toBeNull()
    expect(parseFrontmatter('just text')).toBeNull()
    expect(parseFrontmatter('- a\n- b')).toBeNull()
  })
})

describe('stringField', () => {
  it('gives the value of a string field, and the empty string for any other', () => {
    const data = { description: 'x', count: 3 }
    expect(stringField(data, 'description')).toBe('x')
    expect(stringField(data, 'count')).toBe('')
    expect(stringField(data, 'absent')).toBe('')
  })
})
