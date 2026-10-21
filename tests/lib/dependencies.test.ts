// This tests the shared dependency check (`.claude/rules/_design-principles.md`,
// "Dependencies outside a plugin"). The seam is the exported function. It
// takes the table and the lookup as arguments, rather than read `PATH`
// itself. So a plugin's own hook decides what "present" means. This file
// stays a pure function over what it is given.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandbox } from '#harness/sandbox.ts'
import {
  absentDependencies,
  type Dependency,
  deadlineClock,
  exists,
  type FileReads,
  ghDataDirectory,
  hasGhExtension,
  isPresent,
  nodeFileReads,
  onPath,
  which,
  withinDeadline,
} from '#lib/dependencies.ts'

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
  it('answers the path of an executable on PATH, and null when PATH is unset', async () => {
    const sandbox = createSandbox()
    const file = binWith(sandbox.join('bin'), 'tool', 0o755)

    expect(await which('tool', { PATH: sandbox.join('bin') }, nodeFileReads)).toBe(file)
    expect(await which('tool', {}, nodeFileReads)).toBeNull()
  })

  it('reads a PATH set to nothing as no PATH, and an empty entry as the cwd', async () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'tool', 0o755)
    // An empty PATH entry resolves against the process's own directory.
    // vitest runs the tests of one file one at a time, so no other test in
    // this file runs between the change and the restore.
    const before = process.cwd()
    process.chdir(sandbox.join('bin'))
    try {
      expect(await which('tool', { PATH: '' }, nodeFileReads)).toBeNull()
      const listed = `${path.delimiter}${sandbox.join('nowhere')}`
      expect(await which('tool', { PATH: listed }, nodeFileReads)).toBe('tool')
    } finally {
      process.chdir(before)
    }
  })

  it('refuses a directory named like the tool', async () => {
    const sandbox = createSandbox()
    // A directory has the traverse bit, which passes an executable check.
    mkdirSync(sandbox.join('bin', 'tool'), { recursive: true })

    expect(await which('tool', { PATH: sandbox.join('bin') }, nodeFileReads)).toBeNull()
  })

  it('refuses a file that is not executable', async () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'tool', 0o644)

    expect(await which('tool', { PATH: sandbox.join('bin') }, nodeFileReads)).toBeNull()
  })

  it('walks past a directory and a plain file to a later executable', async () => {
    const sandbox = createSandbox()
    mkdirSync(sandbox.join('one', 'tool'), { recursive: true })
    binWith(sandbox.join('two'), 'tool', 0o644)
    const file = binWith(sandbox.join('three'), 'tool', 0o755)

    const listed = ['one', 'two', 'three'].map((name) => sandbox.join(name)).join(path.delimiter)
    expect(await which('tool', { PATH: listed }, nodeFileReads)).toBe(file)
  })

  it('answers the first match', async () => {
    const sandbox = createSandbox()
    const first = binWith(sandbox.join('one'), 'tool', 0o755)
    binWith(sandbox.join('two'), 'tool', 0o755)

    const listed = [sandbox.join('one'), sandbox.join('two')].join(path.delimiter)
    expect(await which('tool', { PATH: listed }, nodeFileReads)).toBe(first)
  })
})

/** A promise that never settles: a read on a filesystem that hangs. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('nodeFileReads', () => {
  it('reads text, tells a directory from a file, and rejects a target that is not there', async () => {
    const sandbox = createSandbox()
    const file = binWith(sandbox.join('bin'), 'tool', 0o755)

    expect(await nodeFileReads.readText(file)).toBe('#!/bin/sh\nexit 0\n')
    expect(await nodeFileReads.kindOf(sandbox.join('bin'))).toBe('directory')
    expect(await nodeFileReads.kindOf(file)).toBe('other')
    await expect(nodeFileReads.kindOf(sandbox.join('nowhere'))).rejects.toThrow('ENOENT')
    await expect(nodeFileReads.canRun(file)).resolves.toBeUndefined()
  })
})

describe('exists', () => {
  it('answers true for a directory and a file, and false for a target that is not there', async () => {
    const sandbox = createSandbox()
    const file = binWith(sandbox.join('bin'), 'tool', 0o644)

    expect(await exists(nodeFileReads, sandbox.join('bin'))).toBe(true)
    expect(await exists(nodeFileReads, file)).toBe(true)
    expect(await exists(nodeFileReads, sandbox.join('nowhere'))).toBe(false)
  })
})

describe('withinDeadline', () => {
  it('answers what the task answers when it settles in time', async () => {
    expect(await withinDeadline(Promise.resolve(null), 1_000, 'late')).toBeNull()
  })

  it('answers the late value when the task does not settle in time', async () => {
    expect(await withinDeadline(never<string>(), 10, 'late')).toBe('late')
  })

  it('passes on a rejection that comes in time', async () => {
    await expect(
      withinDeadline(Promise.reject(new Error('read failed')), 1_000, 'late'),
    ).rejects.toThrow('read failed')
  })
})

describe('onPath', () => {
  it('answers true and false from the walk, and null when the walk does not finish', async () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'tool', 0o755)
    const env = { PATH: sandbox.join('bin') }
    const hung: FileReads = { ...nodeFileReads, canRun: () => never() }

    expect(await onPath('tool', env, nodeFileReads, 1_000)).toBe(true)
    expect(await onPath('other', env, nodeFileReads, 1_000)).toBe(false)
    expect(await onPath('tool', env, hung, 10)).toBeNull()
  })
})

describe('ghDataDirectory', () => {
  // gh's own order (go-gh `config.DataDir`, read on 2026-10-20).
  it('takes XDG_DATA_HOME first, on any platform', () => {
    const env = { XDG_DATA_HOME: '/x', LOCALAPPDATA: '/l', HOME: '/h' }
    expect(ghDataDirectory(env, 'darwin')).toBe(path.join('/x', 'gh'))
    expect(ghDataDirectory(env, 'win32')).toBe(path.join('/x', 'gh'))
  })

  it('takes LOCALAPPDATA on Windows only, then the home directory', () => {
    const env = { XDG_DATA_HOME: '', LOCALAPPDATA: '/l', HOME: '/h', USERPROFILE: '/u' }
    expect(ghDataDirectory(env, 'win32')).toBe(path.join('/l', 'GitHub CLI'))
    expect(ghDataDirectory(env, 'linux')).toBe(path.join('/h', '.local', 'share', 'gh'))
    expect(ghDataDirectory({ USERPROFILE: '/u' }, 'win32')).toBe(
      path.join('/u', '.local', 'share', 'gh'),
    )
  })

  it('answers null when the environment names no home', () => {
    expect(ghDataDirectory({}, 'linux')).toBeNull()
    expect(ghDataDirectory({ HOME: '' }, 'darwin')).toBeNull()
  })
})

describe('hasGhExtension', () => {
  it('answers true for an extension directory, false for none or a file, null when late', async () => {
    const sandbox = createSandbox()
    const extensions = sandbox.join('home', '.local', 'share', 'gh', 'extensions')
    mkdirSync(path.join(extensions, 'gh-stack'), { recursive: true })
    writeFileSync(path.join(extensions, 'gh-flat'), '')
    const env = { HOME: sandbox.join('home') }
    const hung: FileReads = { ...nodeFileReads, kindOf: () => never() }

    expect(await hasGhExtension('stack', env, nodeFileReads, 1_000, 'darwin')).toBe(true)
    expect(await hasGhExtension('flat', env, nodeFileReads, 1_000, 'darwin')).toBe(false)
    expect(await hasGhExtension('other', env, nodeFileReads, 1_000, 'darwin')).toBe(false)
    expect(await hasGhExtension('stack', {}, nodeFileReads, 1_000, 'darwin')).toBe(false)
    expect(await hasGhExtension('stack', env, hung, 10, 'darwin')).toBeNull()
  })
})

describe('isPresent', () => {
  it('reads a tool on PATH, and a gh extension in gh’s directory', async () => {
    const sandbox = createSandbox()
    binWith(sandbox.join('bin'), 'stack', 0o755)
    const env = { PATH: sandbox.join('bin'), HOME: sandbox.join('home') }
    const tool: Dependency = { tool: 'stack', label: 'a tool named stack' }
    const extension: Dependency = { tool: 'stack', label: 'gh stack', via: 'gh-extension' }

    expect(await isPresent(tool, env, nodeFileReads, 1_000, 'darwin')).toBe(true)
    expect(await isPresent(extension, env, nodeFileReads, 1_000, 'darwin')).toBe(false)
  })
})

describe('deadlineClock', () => {
  it('gives the time left of the deadline, and never less than 1 ms', async () => {
    const remaining = deadlineClock(1_000)
    const first = remaining()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(first).toBeLessThanOrEqual(1_000)
    expect(first).toBeGreaterThan(900)
    expect(remaining()).toBeLessThan(first)
    expect(deadlineClock(-5)()).toBe(1)
  })
})
