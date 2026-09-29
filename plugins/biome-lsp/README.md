# biome-lsp

Runs Biome's language server (`biome lsp-proxy`) from the project's `node_modules/@biomejs/biome`.
It covers `.json`, which `typescript7-lsp` does not claim
([`plugins/typescript7-lsp/.lsp.json`](../typescript7-lsp/.lsp.json)) but Biome lints here
(`biome.json:9`).

Claude Code starts one server for each extension. When two enabled servers claim an extension,
the first registered server handles it
([plugins components](https://code.claude.com/docs/en/plugins/components#lsp-servers)). So this
plugin does not claim `.ts`, `.tsx`, `.js` or `.jsx`, which `typescript7-lsp` covers. A probe
with `claude -p --plugin-dir` confirmed this, in both load orders, on a build that claimed `.ts`.
With Biome first, the `LSP` tool's `hover` on a `.ts` file failed with `Method not found`.

Diagnostics reach the session in headless mode too. With Claude Code 2.1.283, a `Write` of
`{"a": 1, "a": 2}` to a `.json` file gave Claude this Biome diagnostic:
`The key a was already declared. [lint/suspicious/noDuplicateObjectKeys]`. Format problems did
not show as diagnostics.

## Requirements

- `node` on `PATH`.
- `@biomejs/biome` at `${CLAUDE_PROJECT_DIR}/node_modules/@biomejs/biome` (install first).

Without that path the server fails to start, and Claude Code reports it. Causes include Yarn
Plug'n'Play, pnpm `node-linker=pnp`, or a custom pnpm `modules-dir`. Another cause is a pnpm
(isolated) monorepo with `@biomejs/biome` only in a workspace package.
