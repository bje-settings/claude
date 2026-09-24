# typescript7-lsp

The TypeScript 7 language server for Claude Code: go to definition, find references, hover types, symbols, call
hierarchy and diagnostics after edits, from the project's own TypeScript.

## Language server

Runs TypeScript 7's native language server, `tsc --lsp --stdio`, from the project's
`node_modules/typescript` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs` and `.cjs`.
The server that answers is the compiler the project type-checks with.

Use it in place of `typescript-lsp@claude-plugins-official`. That plugin runs
`typescript-language-server`, which wraps the JavaScript `tsserver`, and TypeScript 7 (the native
port) ships no `tsserver.js`, so every call fails with "provides no tsserver.js"
([anthropics/claude-plugins-official#4492](https://github.com/anthropics/claude-plugins-official/issues/4492)).
Disable it when enabling this one: when two enabled servers claim an extension, the first
registered handles it and the other never starts.

```json
{
  "enabledPlugins": {
    "typescript7-lsp@bje": true,
    "typescript-lsp@claude-plugins-official": false
  }
}
```

### Requirements

- `typescript` 7 or newer installed in the project, at `node_modules/typescript` under the
  project root (`${CLAUDE_PROJECT_DIR}`): run the project's install first. Nothing is installed
  globally. A project on TypeScript 6 or older keeps using `typescript-lsp`.
- Node on `PATH`.

The path is fixed, so it works with a `node_modules` layout at the project root: pnpm's default
(`node-linker=isolated`) or `hoisted`, npm, Yarn classic and Bun. It does not work when there is
no `node_modules/typescript` at the root:

- Yarn Berry's Plug'n'Play (its default) or pnpm's `node-linker=pnp`, which keep packages out of
  `node_modules`;
- pnpm with a custom `modules-dir`;
- a monorepo that lists `typescript` only in a workspace package, not in the root `package.json`.

In those projects the server fails to start and Claude Code reports it; nothing answers from a
different TypeScript.
