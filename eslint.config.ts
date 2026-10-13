// ESLint lints only the Claude Code configuration files here. Biome keeps
// TypeScript and JSON format. ESLint reads this file through
// `--flag unstable_native_nodejs_ts_config`, which the `lint` script in
// package.json passes. Without it, ESLint asks for `jiti`.
import { defineConfig } from 'eslint/config'
import claude from 'eslint-plugin-claude'

export default defineConfig([
  { ignores: ['.claude/worktrees/**'] },
  {
    plugins: { claude },
    extends: ['claude/recommended'],
    rules: {
      // This repository ships no legacy `commands/` plugin. A new one is an error.
      'claude/command-legacy-format': 'error',
      // Off until #417. Each plugin reaches `lib/` through its `src/lib` symlink,
      // which leaves the plugin directory on purpose.
      'claude/plugin-symlink-escapes-plugin': 'off',
    },
  },
])
