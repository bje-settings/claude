# lsp-merge

One language server that runs several. Claude Code gives each file extension to one server
([plugins components](https://code.claude.com/docs/en/plugins/components#lsp-servers)). lsp-merge
takes that one place, runs the servers you list, and merges their diagnostics. So a type checker
and a linter both report on `.ts`.

[ADR 006](../../docs/adr/006-lsp-merge-proxy.md) records the design and the probe results.

## Config

lsp-merge reads `.claude/lsp-merge.json` in the project on each start. Each entry is a copy of a
server from a plugin's `.lsp.json`, keyed by name. The keys are the same, and
`${CLAUDE_PROJECT_DIR}` works in `command`, `args` and `env`. `${CLAUDE_PLUGIN_ROOT}` does not:
it names lsp-merge, not the plugin you copied from.

```json
{
  "typescript7": {
    "command": "node",
    "args": ["${CLAUDE_PROJECT_DIR}/node_modules/typescript/bin/tsc", "--lsp", "--stdio"],
    "extensionToLanguage": { ".ts": "typescript", ".js": "javascript" }
  },
  "biome": {
    "command": "node",
    "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@biomejs/biome/bin/biome", "lsp-proxy"],
    "extensionToLanguage": { ".ts": "typescript", ".json": "json" }
  }
}
```

- **Order matters.** For a file, the first entry that claims its extension answers requests
  (hover, definition, and so on). The other entries that claim it get the document, and add their
  diagnostics.
- `initializationOptions` goes to that server only. `settings` goes to that server as
  `workspace/didChangeConfiguration` after `initialized`.
- Other `.lsp.json` keys (`restartOnCrash`, timeouts, and so on) are accepted and ignored.

Then disable every other language server plugin, and enable lsp-merge:

```json
{
  "enabledPlugins": {
    "lsp-merge@bje": true,
    "typescript7-lsp@bje": false,
    "biome-lsp@bje": false,
    "typescript-lsp@claude-plugins-official": false
  }
}
```

## Extensions

The manifest claims this fixed set, because `extensionToLanguage` has no catch-all key:
`.ts .tsx .mts .cts .js .jsx .mjs .cjs .json .jsonc .css .scss .less .html .vue .svelte .astro
.graphql .gql .md .mdx .yaml .yml .toml .py .go .rs`. A file in the set that no entry claims gets
empty answers.

## Diagnostics

lsp-merge keeps the last list from each server for each file, and pushes the union. Claude Code
only takes pushed diagnostics. So for a server that declares `diagnosticProvider`, lsp-merge
pulls (`textDocument/diagnostic`) after each open, change and save. TypeScript 7's server only
answers pulls: without lsp-merge, its type errors never reach Claude.

When a server asks for a refresh (`workspace/diagnostic/refresh`), lsp-merge pulls each open file
of that server again. When a server cancels a pull while it is busy, lsp-merge pulls again. When
a file closes, lsp-merge drops its lists.

## Requirements

- `node` 22.18 or newer on `PATH`, and the `claude` CLI on `PATH` (for the session start check).
- Each server's own requirements, for example `node_modules` installed.
- Install through a marketplace (`/plugin marketplace add`). `claude --plugin-dir` drops the
  plugin's `src/lib` link, and the hook then fails at import.

## Failure modes

The `SessionStart` hook reports these at session start, as a `lsp-merge: ⚠️` line:

- **`.claude/lsp-merge.json is missing` or `is not valid`.** The proxy exits with the reason on
  stderr. lsp-merge still claims its extensions, so no other server gets them. Add the file, or
  disable lsp-merge.
- **`other language server plugins are enabled: <ids>`.** Claude Code gives an extension to the
  first registered server, so that plugin and lsp-merge can each take extensions from the other.
  Move the server into `lsp-merge.json`, and disable the plugin.
- **`the enabled plugins could not be checked`.** `claude plugin list --json` failed or timed out.

Other limits:

- **When any server exits, lsp-merge exits too**, and Claude Code restarts all of them, up to
  `maxRestarts` (3). When lsp-merge stops, a server that ignores SIGTERM gets SIGKILL.
- **Claude Code on the web** does not start language servers in its sessions.
- **Diagnostics arrive after the edit.** Claude sees them on its next turn. A pulled server can
  answer a few hundred milliseconds after a pushed one.
