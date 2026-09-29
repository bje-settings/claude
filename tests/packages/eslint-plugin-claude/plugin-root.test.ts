import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isPluginRoot } from '#eslint-plugin-claude/plugin-root.ts'

let scratch = ''
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

it('knows a plugin root by its manifest, and nothing else', () => {
  scratch = mkdtempSync(path.join(tmpdir(), 'plugin-root-'))
  mkdirSync(path.join(scratch, 'p', '.claude-plugin'), { recursive: true })
  writeFileSync(path.join(scratch, 'p', '.claude-plugin', 'plugin.json'), '{}')
  mkdirSync(path.join(scratch, 'q', '.claude-plugin'), { recursive: true })

  expect(isPluginRoot(path.join(scratch, 'p'))).toBe(true)
  expect(isPluginRoot(path.join(scratch, 'q'))).toBe(false)
  expect(isPluginRoot(scratch)).toBe(false)
})
