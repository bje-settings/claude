---
type: ADR
description: Each plugin holds byte-equal copies of the root lib/ files it imports, in src/lib/, in place of a symlink. The root lib/ stays the one place to edit. scripts/sync-lib.ts writes the copies, and its --check mode proves they match.
status: stable
created: 2026-10-12
owner: brianespinosa
related_issues: [417, 341]
---

# ADR 006: Plugins hold copies of lib

This ADR supersedes one decision of [ADR 001](001-typescript-on-node-22-18.md): "Code shared
between plugins lives in one root `lib/`, reached by a committed symlink". The other decisions of
ADR 001 stay in force.

## Context

Each plugin reached the root `lib/` through a committed symlink, `src/lib -> ../../../lib`. The
target is outside the plugin and inside the marketplace.

The Claude Code docs give two results for such a link
([Share files within a marketplace with symlinks](https://code.claude.com/docs/en/plugins/host-marketplace#share-files-within-a-marketplace-with-symlinks)).
A marketplace install copies the target into the cache. An install from a local path, or from a
`command` source in copy mode, "preserves only symlinks that resolve within the plugin's own
directory and skips all others". Then `src/lib` is not there, and each command fails at import.
The [plugin loading reference](https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins)
also says that a copied plugin cannot read a path above its root. So the plugin works after one
install method and fails after another.

The `eslint-plugin-claude` rule `plugin-symlink-escapes-plugin` reports each of the four links
for this reason. #341 turned the rule off until #417. The ruling on #341 was to fix the finding,
not to keep the rule off.

The shared code must stay in one place to edit. Four plugins import it, and a fix to one
function must reach each of them.

## Decision

1. Each plugin's `src/lib/` is a directory of real files. It holds a copy of each root `lib/`
   file that the plugin imports, and each file that those files import. It holds no other file.
2. Each copy is byte-equal to its source in `lib/`. A copy gets no header and no edit.
3. The root `lib/` stays the one place to edit. `scripts/sync-lib.ts` writes the copies. It reads
   the imports of each plugin's `.ts` files in `src/`, `scripts/` and `hooks/`.
4. `node scripts/sync-lib.ts --check` writes nothing. It exits 1 when a copy is missing, extra
   or different, and names each one. `tests/repo/sync-lib.test.ts` runs it on the repository.
5. No plugin holds a symlink, and no import leaves a plugin. `tests/repo/repo-layout.test.ts`
   enforces both (`pluginSymlinks`, `crossPluginImports`). The lint rule is on again.

## Consequences

- **Every install method gets the same files.** A local-path install, a copy-mode `command`
  source and a marketplace install each copy real files.
- **A copy can drift from `lib/`.** An edit to `lib/` without a sync leaves a copy behind. The
  check in the test suite fails, so CI refuses the pull request.
- **A diff to `lib/` shows each copy too.** A change to a file that four plugins import adds four
  more changed files to the pull request.
- **Tests load one `lib/`.** Node loads a copy and its source as two modules, and a class from
  one fails `instanceof` against the other. A `resolveId` plugin in `vitest.config.ts` sends each
  test import of a copy to `lib/`. The spawned tests run the copies as they ship.
- **Coverage measures `lib/` once.** `vitest.config.ts` excludes `plugins/*/src/lib/**`, because
  no test loads a copy.
- **Symlink support is not necessary for contributors.** ADR 001 named this as a cost. It no
  longer applies.
