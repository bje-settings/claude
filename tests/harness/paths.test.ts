// The paths that `harness/paths.ts` gives are real files in this repository.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { pluginFile, ROOT } from '#harness/paths.ts'

it('names the repository root', () => {
  expect(existsSync(path.join(ROOT, 'package.json'))).toBe(true)
  expect(existsSync(path.join(ROOT, 'plugins'))).toBe(true)
})

it('names a file inside a plugin', () => {
  expect(pluginFile('gh', 'scripts', 'gh.ts')).toBe(
    path.join(ROOT, 'plugins', 'gh', 'scripts', 'gh.ts'),
  )
  expect(existsSync(pluginFile('gh', 'scripts', 'gh.ts'))).toBe(true)
})
