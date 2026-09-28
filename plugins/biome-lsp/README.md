# biome-lsp

Runs Biome's language server (`biome lsp-proxy`) from the project's `node_modules/@biomejs/biome`.
It covers `.ts`, `.tsx`, `.js`, `.jsx`, and `.json`.

`typescript7-lsp` covers `.ts`, `.tsx`, `.js` and `.jsx` too, and Biome lints `.json` here
(`biome.json:9`) but no other plugin in this marketplace does. Only one server can handle a given
file. A probe with the real `claude` binary confirmed
`plugins/typescript7-lsp/README.md`'s claim: the first server that registers for an extension
handles every file of that extension, and the other server for that extension never starts.

The probe loaded both plugins with `claude -p --plugin-dir`, one order at a time, and asked the
session to call the `LSP` tool's `hover` operation on a `.ts` file. With `typescript7-lsp` loaded
first, `hover` returned real TypeScript type information. With `biome-lsp` loaded first, the same
call failed with `LSP request 'textDocument/hover' failed for server 'plugin:biome-lsp:biome':
Method not found`, because Biome's server does not implement `hover`. Reversing the load order
reversed which server answered. Neither run showed both servers active on the same file. This
result did not test `enabledPlugins` order in `.claude/settings.json` directly, only
`--plugin-dir` order; the two are assumed, not proven, to work the same way.

Order this plugin after `typescript7-lsp` to keep TypeScript diagnostics on `.ts`, `.tsx`, `.js`
and `.jsx`. Biome then handles only `.json`, which no other server here claims:

```json
{
  "enabledPlugins": {
    "typescript7-lsp@bje": true,
    "biome-lsp@bje": true
  }
}
```

The probe could not confirm the `Found N new diagnostic issues` line the
[code intelligence docs](https://code.claude.com/docs/en/plugins/code-intelligence) describe.
Six headless runs, with `Write` and `Edit`, on `typescript7-lsp` alone, `biome-lsp` alone, and
both together, never showed that line or any diagnostic text in the raw event stream. The
underlying server did work: the `LSP` tool's `hover` and `documentSymbol` operations returned
real answers. Whether the auto diagnostic line ever fires in a headless (`-p`) session is
unsettled; this README does not guess.

## Requirements

- `node` on `PATH`.
- `@biomejs/biome` at `${CLAUDE_PROJECT_DIR}/node_modules/@biomejs/biome` (install first).

Without that path the server fails to start, and Claude Code reports it. Causes include Yarn
Plug'n'Play, pnpm `node-linker=pnp`, or a custom pnpm `modules-dir`. Another cause is a pnpm
(isolated) monorepo with `@biomejs/biome` only in a workspace package.
