# typescript7-lsp

Runs TypeScript 7's native language server (`tsc --lsp --stdio`) from the project's
`node_modules/typescript` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs` and `.cjs`.

It replaces `typescript-lsp@claude-plugins-official`, which wraps `tsserver`; TypeScript 7 ships
no `tsserver.js`
([anthropics/claude-plugins-official#4492](https://github.com/anthropics/claude-plugins-official/issues/4492)).
Disable that plugin: when both are enabled, the first registered server handles the files and the
other never starts.

```json
{
  "enabledPlugins": {
    "typescript7-lsp@bje": true,
    "typescript-lsp@claude-plugins-official": false
  }
}
```

## Requirements

- `typescript` 7+ at `${CLAUDE_PROJECT_DIR}/node_modules/typescript` (run the project's install
  first). Stay on `typescript-lsp` for TypeScript 6 or older.
- `node` on `PATH`.

Without that path the server fails to start and Claude Code reports it: Yarn Plug'n'Play, pnpm
`node-linker=pnp`, a custom pnpm `modules-dir`, or a pnpm (isolated) monorepo with `typescript`
only in a workspace package.
