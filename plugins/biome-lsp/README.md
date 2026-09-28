# biome-lsp

Runs Biome's language server (`biome lsp-proxy`) from the project's `node_modules/@biomejs/biome`.
It covers `.json`, which `typescript7-lsp` does not claim
([`plugins/typescript7-lsp/.lsp.json`](../typescript7-lsp/.lsp.json)) but Biome lints here
(`biome.json:9`).

This plugin does not claim `.ts`, `.tsx`, `.js` or `.jsx`, even though Biome lints those files
too. A probe with the real `claude` binary showed why: only one server can handle a given
extension. The probe loaded `typescript7-lsp` and a build of this plugin that did claim `.ts`,
with `claude -p --plugin-dir`, one load order at a time, and asked the session to call the `LSP`
tool's `hover` operation on a `.ts` file. With `typescript7-lsp` loaded first, `hover` returned
real TypeScript type information. With the Biome build loaded first, the same call failed with
`LSP request 'textDocument/hover' failed for server 'plugin:biome-lsp:biome': Method not found`,
because Biome's server does not implement `hover`. Reversing the load order reversed which server
answered. Neither run showed both servers active on the same file. This result did not test
`enabledPlugins` order in `.claude/settings.json` directly, only `--plugin-dir` order; the two
are assumed, not proven, to work the same way.

`typescript7-lsp` already covers `.ts`, `.tsx`, `.js` and `.jsx`
([`plugins/typescript7-lsp/README.md`](../typescript7-lsp/README.md)), so claiming those
extensions here would only start a server that never runs, or that silences `typescript7-lsp`
depending on load order. `.json` has no such contention: no other plugin in this marketplace
claims it.

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
