// This tests the shared dependency check (`.claude/rules/_design-principles.md`,
// "Dependencies outside a plugin"). The seam is the exported function. It
// takes the table and the lookup as arguments, rather than read `PATH`
// itself. So a plugin's own hook decides what "present" means. This file
// stays a pure function over what it is given.
import { describe, expect, it } from 'vitest'

import { absentDependencies, type Dependency } from '#lib/dependencies.ts'

const TABLE: readonly Dependency[] = [
  { tool: 'git', label: 'git' },
  { tool: 'gh', label: 'GitHub CLI (gh)' },
]

describe('absentDependencies', () => {
  it('answers an empty list when every dependency is present', () => {
    expect(absentDependencies(TABLE, () => true)).toEqual([])
  })

  it('answers every dependency when none is present', () => {
    expect(absentDependencies(TABLE, () => false)).toEqual(TABLE)
  })

  it('keeps the table order, and asks the lookup by tool name', () => {
    const asked: string[] = []
    const present = (tool: string): boolean => {
      asked.push(tool)
      return tool === 'gh'
    }

    expect(absentDependencies(TABLE, present)).toEqual([{ tool: 'git', label: 'git' }])
    expect(asked).toEqual(['git', 'gh'])
  })

  it('answers an empty list for an empty table', () => {
    expect(absentDependencies([], () => false)).toEqual([])
  })
})
