// This tests the shared dependency check (`.claude/rules/_design-principles.md`,
// "Dependencies outside a plugin"). The seam is the exported function. It
// takes the table and the lookup as arguments, rather than read `PATH`
// itself. So a plugin's own hook decides what "present" means. This file
// stays a pure function over what it is given.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandbox } from '#harness/sandbox.ts'
import { absentDependencies, type Dependency, which } from '#lib/dependencies.ts'

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

/** A directory in the sandbox that holds `tool`, executable or not. */
const binWith = (dir: string, tool: string, mode: number): string => {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, tool)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, mode)
  return file
}

// These cases pinned both plugin copies of `which` before they moved here.
describe('which', () => {
  it('answers the path of an executable on PATH, and null when PATH is unset', () => {
    const sandbox = createSandbox()
    const file = binWith(sandbox.join('bin'), 'tool', 0o755)

    expect(which('tool', { PATH: sandbox.join('bin') })).toBe(file)
    expect(which('tool', {})).toBeNull()
  })

  it('reads a PATH set to nothing as no PATH, and an empty entry as the cwd', () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'tool', 0o755)
    // An empty PATH entry resolves against the process's own directory. The
    // change and the restore are in one synchronous block, so no other test
    // in this file runs between them.
    const before = process.cwd()
    process.chdir(sandbox.join('bin'))
    try {
      expect(which('tool', { PATH: '' })).toBeNull()
      expect(which('tool', { PATH: `${path.delimiter}${sandbox.join('nowhere')}` })).toBe('tool')
    } finally {
      process.chdir(before)
    }
  })

  it('refuses a directory named like the tool', () => {
    const sandbox = createSandbox()
    // A directory has the traverse bit, which passes an executable check.
    mkdirSync(sandbox.join('bin', 'tool'), { recursive: true })

    expect(which('tool', { PATH: sandbox.join('bin') })).toBeNull()
  })

  it('refuses a file that is not executable', () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'tool', 0o644)

    expect(which('tool', { PATH: sandbox.join('bin') })).toBeNull()
  })

  it('walks past a directory and a plain file to a later executable', () => {
    const sandbox = createSandbox()
    mkdirSync(sandbox.join('one', 'tool'), { recursive: true })
    binWith(sandbox.join('two'), 'tool', 0o644)
    const file = binWith(sandbox.join('three'), 'tool', 0o755)

    const listed = ['one', 'two', 'three'].map((name) => sandbox.join(name)).join(path.delimiter)
    expect(which('tool', { PATH: listed })).toBe(file)
  })

  it('answers the first match', () => {
    const sandbox = createSandbox()
    const first = binWith(sandbox.join('one'), 'tool', 0o755)
    binWith(sandbox.join('two'), 'tool', 0o755)

    const listed = [sandbox.join('one'), sandbox.join('two')].join(path.delimiter)
    expect(which('tool', { PATH: listed })).toBe(first)
  })
})
