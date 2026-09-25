---
paths:
  - "plugins/**"
  - "lib/**"
---

# Plugin Directories

Claude Code copies a plugin's whole directory, and `lib/` through `src/lib`, into each user's
cache. So a plugin directory holds only the files an installed plugin uses at run time (ADR 004).

- Tests and test helpers go in `tests/plugins/<plugin>/`, at the mirror of `src/`. Tests of
  `lib/` go in `tests/lib/`. Fixtures go in a `fixtures/` directory beside those tests.
- Flow diagrams go in `docs/flows/<plugin>/<skill>/` (`.claude/rules/file-skill-md.md`).
- Give a directory a component name (`commands`, `agents`, `skills`, `hooks`, `output-styles`,
  `workflows`, `themes`, `monitors`, `bin`, `evals`) only when it is that component at the plugin
  root. Dispatcher targets go in `src/subcommands/`.

`tests/repo/repo-layout.test.ts` enforces this (`developmentFiles`, `reservedDirectoryNames`).
