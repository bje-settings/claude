// A RuleTester for each language, wired to vitest. RuleTester looks for
// global `describe` and `it`. This suite does not turn on vitest globals,
// so the tester gets them here.
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

Object.assign(RuleTester, { describe, it, itOnly: it.only })

export const markdownTester = new RuleTester({
  plugins: { markdown },
  language: 'markdown/gfm',
  languageOptions: { frontmatter: 'yaml' },
})

export const jsonTester = new RuleTester({
  plugins: { json },
  language: 'json/json',
})

export const json5Tester = new RuleTester({
  plugins: { json },
  language: 'json/json5',
})
