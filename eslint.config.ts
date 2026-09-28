// ESLint for Markdown and JSON (ADR 005, draft). It turns on only the
// recommended rules of @eslint/markdown and @eslint/json. No script, hook or
// CI job runs it yet: ADR 005 decision 7 gives those to #223. Biome also
// lints JSON, so some rules overlap, such as duplicate keys.
//
// ESLint reads this file through node's type stripping only with its flag.
// Without the flag, ESLint needs jiti, which this repository does not have:
// pnpm exec eslint --flag unstable_native_nodejs_ts_config <files>
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  {
    // What .gitignore and biome.json exclude. ESLint does not read .gitignore.
    ignores: ['node_modules/**', '.claude/worktrees/**', 'coverage/**', '**/CLAUDE.local.md'],
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
    // jsonc, not json: tsconfig.json has comments, and biome.json lets JSON
    // files have comments (json.parser.allowComments). Strict JSON fails on
    // those files.
    files: ['**/*.json'],
    ignores: ['**/package-lock.json'],
    plugins: { json },
    language: 'json/jsonc',
    extends: ['json/recommended'],
  },
])
