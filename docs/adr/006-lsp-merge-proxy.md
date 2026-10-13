---
type: ADR
description: Deprecated. The plugins moved to SurveyMonkey/lsps. The lsp-merge plugin is one language server that runs the servers in a repository's .claude/lsp-merge.json and joins them. Requests go to one primary child for each file. Diagnostics from all children are merged, with pulls for children that only answer pulls. It is the first plugin here that runs as a long-lived process.
status: deprecated
created: 2026-09-29
owner: brianespinosa
related_issues: [316, 315, 313]
---

# ADR 006: lsp-merge, one language server that runs several

The plugins moved to `SurveyMonkey/lsps`. [ADR 002 there](https://github.com/SurveyMonkey/lsps/blob/main/docs/adr/002-lsp-merge-proxy.md) is the record in force.

## Context

**Claude Code gives each file extension to one language server.** When two enabled servers claim
an extension, the first registered server gets it, and the other never starts
([plugins components](https://code.claude.com/docs/en/plugins/components#lsp-servers)). #315
confirmed this with a probe. So `biome-lsp` claims `.json` only. TypeScript and Biome cannot both
report on `.ts`, and a type checker and a linter find different problems.

**An `lspServers` entry cannot refer to other servers.** The schema is strict: an unknown key
fails validation ([plugins reference](https://code.claude.com/docs/en/plugins-reference#lspservers)).
The upstream request, anthropics/claude-code#27692, closed as not planned.

**Claude Code only takes pushed diagnostics.** It never sends `textDocument/diagnostic`. Ruling 13
on #313 found that `vscode-eslint-language-server` only answers pulls. The #316 probe found the
same for TypeScript 7: `tsc --lsp` declares `diagnosticProvider`, answers a pull with the type
error, and never pushes. So `typescript7-lsp` alone gives hover and definition, but no type
errors.

**Probe results, Claude Code 2.1.284** (#316):

- `extensionToLanguage` has no catch-all. At run time, a key must start with `.` and have two or
  more characters, so `"*"` fails. `claude plugin validate --strict` accepts `"*"`, so the
  validator is looser than the run time. `".*"` loads, but it matches only the literal
  extension.
- `${CLAUDE_PLUGIN_ROOT}` works in `lspServers.args`.
- Claude Code honours full document sync. It sends `initialize`, `initialized`, `didOpen`,
  `didChange`, `didSave` and `shutdown`. `didOpen` carries the language id from the manifest of
  the server that claims the extension.
- `claude plugin list --json` lists the enabled plugins. `claude plugin details <id>` shows
  `LSP servers (N)`. Each call takes about 350 ms.
- Language servers do not start in a Claude Code on the web session.

## Decision

1. **One proxy server.** The `lsp-merge` plugin has one `lspServers` entry. It runs the child
   servers in the repository's `.claude/lsp-merge.json`, read on each start. Each entry is a copy
   of a server from a plugin's `.lsp.json`, keyed by name. The proxy never reads another plugin's
   files from the plugin cache, because that layout is not documented.
2. **A static set of extensions.** The manifest claims a fixed, wide set of extensions, because
   there is no catch-all key. Inside the proxy, each child keeps its own `extensionToLanguage`.
   A file that no child claims gets empty answers.
3. **Routing.** For a file, the first entry that claims its extension is the primary. It answers
   requests about the file. The other claimants get document sync only, each with its own
   language id. A request with no file goes to the first entry. `initialize` and `shutdown` go to
   all children, and the proxy answers once.
4. **Full sync.** The proxy declares `TextDocumentSyncKind.Full`. Each `didChange` carries the
   whole text, which any child accepts, so the proxy keeps no copy of a document.
5. **Merged diagnostics.** The proxy keeps the last list of each child for each file, keyed by
   file path, and pushes the union when one list changes. A child that declares
   `diagnosticProvider` is pulled after each `didOpen`, `didChange` and `didSave`. The proxy
   answers a child's `workspace/diagnostic/refresh` itself, and pulls each open file of that
   child again. It sends a pull again when the child cancels it with `retriggerRequest`. A closed
   file's lists are dropped. A child's name fills a missing `source`.
6. **Crashes.** When any child exits before `shutdown`, the proxy exits with status 1. Claude
   Code's `restartOnCrash` then restarts all of them. When the proxy stops, a child that is still
   there after the grace time gets SIGKILL.
7. **Requests from children** go to Claude Code under an id from the proxy. The response goes
   back to that child, under its own id.
8. **A `SessionStart` hook** checks that the `claude` CLI is present, that the config is valid,
   and that no other enabled plugin runs a language server. It uses `claude plugin list --json`,
   then `claude plugin details` for each enabled plugin in parallel. When `details` cannot
   answer in time, the `*-lsp` name convention decides.

## Consequences

- **A type checker and a linter both report on one file.** In a real `claude -p` session, one
  `Write` of a `.ts` file gave Claude one TypeScript error and two Biome diagnostics.
- **The cost is small.** Over 50 hovers on a `.ts` file, the proxy added 0.2 to 0.4 ms at p50
  (about 0.45 ms direct, 0.6 to 0.85 ms through the proxy).
- **lsp-merge takes every extension in its set.** Any other enabled language server plugin can
  take an extension from it, or lose one to it, in plugin load order. So each language server
  goes into `lsp-merge.json`, and the other plugins stay disabled. The hook says so at session
  start.
- **Pulls can bring back ESLint** (#313), with an entry for `vscode-eslint-language-server`.
- **A crash in one child restarts all of them.** A linter that crashes in a loop also stops
  type checking, until Claude Code's `maxRestarts` ends the loop.
- **A long-lived process in a plugin.** Every other plugin here runs short commands. The proxy
  still follows the dispatcher pattern (`scripts/lsp-merge.ts`, `src/subcommands/serve.ts`),
  and its tests drive real fake child servers.
- **Local install:** the hook reaches the root `lib/` through `src/lib`. So test the plugin
  through `/plugin marketplace add` or `claude --plugin-dir`, which keep that link. A local path
  install or a `command` source in copy mode drops it.
