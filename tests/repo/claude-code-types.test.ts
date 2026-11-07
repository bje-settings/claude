// The committed `types/claude-code/index.d.ts` is the engine's declaration
// file for the pinned Claude Code (ADR 007). Its first line names the
// version that wrote it. A bump of the pin without a new file would type
// hooks modules against the wrong engine.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '#harness/paths.ts'

const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-validate.yml')
const TYPES = path.join(ROOT, 'types', 'claude-code', 'index.d.ts')

/** The version in the workflow's `CLAUDE_CODE_VERSION`, or undefined. */
const pinnedVersion = (workflow: string): string | undefined =>
  /^\s*CLAUDE_CODE_VERSION:\s*"([^"]+)"/m.exec(workflow)?.[1]

/** The version in the first line, `// Written by Claude Code <version>.`. */
const writtenBy = (declarations: string): string | undefined =>
  /^\/\/ Written by Claude Code (\S+?)\.$/.exec(declarations.split('\n')[0] ?? '')?.[1]

describe('types/claude-code/index.d.ts', () => {
  it('names the version that plugin-validate.yml pins', () => {
    const pin = pinnedVersion(readFileSync(WORKFLOW, 'utf8'))
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(writtenBy(readFileSync(TYPES, 'utf8'))).toBe(pin)
  })

  it('reads a mismatch as different versions', () => {
    const pin = pinnedVersion('  CLAUDE_CODE_VERSION: "2.1.320"\n')
    expect(writtenBy('// Written by Claude Code 2.1.319.\n')).not.toBe(pin)
  })

  it('reads nothing from a file that is not in the expected shape', () => {
    expect(pinnedVersion('name: x\n')).toBeUndefined()
    expect(writtenBy('')).toBeUndefined()
  })
})
