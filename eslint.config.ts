// The ESLint gate's whole configuration (ADR 005 decisions 1 and 5). It turns
// on only the recommended rules of the two official language plugins:
// @eslint/markdown for Markdown, and @eslint/json for JSON. Biome keeps
// TypeScript, JSON format, and its own rules (ADR 005 decision 8); this
// config never lints a file Biome already lints for the same concern.
//
// ESLint reads this file with node's own TypeScript type stripping, behind
// the --flag unstable_native_nodejs_ts_config flag (ADR 005 consequences).
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  {
    ignores: ['node_modules/**', '.claude/worktrees/**', 'coverage/**'],
  },
  {
    files: ['**/*.md'],
    plugins: { markdown },
    language: 'markdown/commonmark',
    languageOptions: {
      frontmatter: 'yaml',
    },
    extends: ['markdown/recommended'],
  },
  {
    // jsonc, not json: biome.json and tsconfig.json both carry comments
    // (biome.json's own parser.allowComments is true), so strict JSON
    // parsing fails on files this repository already treats as valid.
    files: ['**/*.json'],
    ignores: ['**/package-lock.json'],
    plugins: { json },
    language: 'json/jsonc',
    extends: ['json/recommended'],
  },
])
