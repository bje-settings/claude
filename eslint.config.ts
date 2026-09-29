// ESLint lints only the Claude Code configuration files here (ADR 005).
// Biome keeps TypeScript and JSON format. ESLint reads this file through
// `--flag unstable_native_nodejs_ts_config`, which the `lint` script in
// package.json passes. Without it, ESLint asks for `jiti`.
import type { Linter } from 'eslint'
import claude from './packages/eslint-plugin-claude/src/index.ts'

const config: Linter.Config[] = [{ ignores: ['.claude/worktrees/**'] }, ...claude.configs.bje]

export default config
