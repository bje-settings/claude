// A `commands/` directory is a command only where Claude Code reads it:
// `.claude/commands/`, or `commands/` beside `.claude-plugin/plugin.json`.
// The plugin case needs a real manifest on disk.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCommandFile, rule } from '#eslint-plugin-claude/rules/command-legacy-format.ts'
import { markdownTester } from '../rule-tester.test-support.ts'

const scratch = mkdtempSync(path.join(tmpdir(), 'command-legacy-format-'))
const plugin = path.join(scratch, 'plugins', 'p')
mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}')

describe('isCommandFile', () => {
  it('finds a command under .claude/commands, at any depth', () => {
    expect(isCommandFile(path.join(scratch, '.claude', 'commands', 'a.md'))).toBe(true)
    expect(isCommandFile(path.join(scratch, '.claude', 'commands', 'ns', 'a.md'))).toBe(true)
  })

  it('finds a command under the commands directory of a plugin root', () => {
    expect(isCommandFile(path.join(plugin, 'commands', 'a.md'))).toBe(true)
  })

  it('ignores a commands directory that Claude Code does not read', () => {
    expect(isCommandFile(path.join(scratch, 'docs', 'commands', 'a.md'))).toBe(false)
    expect(isCommandFile(path.join(plugin, 'skills', 'commands', 'a.md'))).toBe(false)
    expect(isCommandFile(path.join(scratch, 'commands.md'))).toBe(false)
  })

  it('reads a relative path from the working directory', () => {
    expect(isCommandFile(path.join('.claude', 'commands', 'a.md'))).toBe(true)
  })

  it('checks a commands directory at the file system root', () => {
    expect(isCommandFile(`${path.sep}commands${path.sep}a.md`)).toBe(false)
  })
})

markdownTester.run('command-legacy-format', rule as never, {
  valid: [
    { code: '# Doc\n', filename: path.join(scratch, 'docs', 'commands', 'a.md') },
    { code: '# Skill\n', filename: path.join(plugin, 'skills', 's', 'SKILL.md') },
  ],
  invalid: [
    {
      code: '---\ndescription: x\n---\n',
      filename: path.join(scratch, '.claude', 'commands', 'a.md'),
      errors: [{ messageId: 'legacy', line: 1, column: 1 }],
    },
    {
      code: '# A\n',
      filename: path.join(plugin, 'commands', 'a.md'),
      errors: [{ messageId: 'legacy' }],
    },
  ],
})
