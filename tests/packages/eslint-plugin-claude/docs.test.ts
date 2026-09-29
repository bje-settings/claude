// Each rule links to its own doc (ADR 005). A rule with no doc, or a URL
// that names another file, sends the reader of a report to a 404.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { docsUrl } from '#eslint-plugin-claude/docs-url.ts'
import plugin from '#eslint-plugin-claude/index.ts'

const DOCS = path.resolve(import.meta.dirname, '../../../packages/eslint-plugin-claude/docs/rules')

it('gives each rule a doc and a URL that names it', () => {
  const rules = Object.entries(plugin.rules ?? {})
  expect(rules.length).toBeGreaterThan(0)
  for (const [name, rule] of rules) {
    expect(rule.meta?.docs?.url).toBe(docsUrl(name))
    expect(existsSync(path.join(DOCS, `${name}.md`)), `${name}.md`).toBe(true)
  }
})
