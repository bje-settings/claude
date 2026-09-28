# eslint-lsp

Runs the VS Code ESLint language server, `vscode-eslint-language-server`, from
`node_modules/vscode-langservers-extracted`
([hrsh7th/vscode-langservers-extracted](https://github.com/hrsh7th/vscode-langservers-extracted),
extracted from VS Code's own ESLint extension). It covers `.md` and `.json`, and it runs the
project's own `eslint` and `eslint.config.ts`.

`plugins/typescript7-lsp/.lsp.json` claims neither extension, so there is no contention with
`typescript7-lsp`. `biome-lsp` claims `.json` too. `plugins/biome-lsp/README.md` shows that only
one server can handle a given extension, decided by which server registers first: the probe used
a build of `biome-lsp` that claimed `.ts`, against `typescript7-lsp`, not `eslint-lsp` against
`biome-lsp` on `.json`. The same one-server-per-extension behavior is assumed to apply here, not
separately proven.

Order this plugin after `biome-lsp` in `.claude/settings.json`, so `.json` diagnostics stay with
Biome, the JSON linter of record here (`biome.json:9`). This plugin's practical value in this
repository is then `.md`:

```json
{
  "enabledPlugins": {
    "biome-lsp@bje": true,
    "eslint-lsp@bje": true
  }
}
```

The `.lsp.json` `settings` block sets `eslint.validate: ["markdown", "json"]` and
`eslint.run: "onType"`, because `vscode-eslint-language-server` expects a client to send these
through `workspace/didChangeConfiguration`; Claude Code is not that client, so the plugin sends
them once at startup instead. This setup was not exercised against a live diagnostic in this
layer: see `plugins/biome-lsp/README.md` for why the `Found N new diagnostic issues` line did
not appear in any headless probe, for either server. A confirmed failure mode: without the
`--stdio` argument, `vscode-eslint-language-server` exits immediately with `Connection input
stream is not set`.

## Requirements

- `node` on `PATH`.
- `vscode-langservers-extracted` at `${CLAUDE_PROJECT_DIR}/node_modules/vscode-langservers-extracted`
  (install first).
- `eslint` and a config the project's `eslint` can load, at the project root.

Without that path the server fails to start, and Claude Code reports it. Causes include Yarn
Plug'n'Play, pnpm `node-linker=pnp`, or a custom pnpm `modules-dir`.
