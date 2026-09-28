# Contributing

## Tests

```bash
pnpm install   # the toolchain (and the git hooks, below)
pnpm test      # the suite, with coverage
pnpm exec biome ci . --error-on-warnings && pnpm exec tsc -p tsconfig.json
```

The prerequisite is Node with corepack enabled. `package.json` pins the pnpm version, and
`.npmrc` pins the 22.x release pnpm runs by default. Plugin code is TypeScript, run directly by
node (`.claude/rules/type-ts.md`).

The git hooks' steps need `node_modules` and `claude` between them. Each step warns to stderr
when it lacks the one it needs. It does not fail the commit.

Every test lives under `tests/`. `tests/plugins/<plugin>/` mirrors `plugins/<plugin>/src/`, with
fixtures at `tests/plugins/<plugin>/fixtures/`. Nothing test-only goes in a plugin or in `lib/`,
because both ship to each user (ADR 004). The shared harness is `harness/` at the repository
root. See `harness/README.md`.

`pnpm test` enforces vitest's coverage thresholds: 100 on lines, branches, functions and
statements.

## Language server

This marketplace's `typescript7-lsp` and `biome-lsp` run their language servers from this
repository's own `node_modules`. Add the marketplace and run `pnpm install` before you start a
session.

## Git hooks

```bash
pnpm install
```

`pnpm install` installs the hooks. lefthook's own postinstall runs `lefthook install`, through
`pnpm.onlyBuiltDependencies` in `package.json` (pnpm 10 blocks a dependency's lifecycle scripts
otherwise). Or run `pnpm exec lefthook install` by hand. Do this once, from the root checkout,
not per worktree. lefthook resolves the hooks directory with `git rev-parse --git-path hooks`,
the clone's shared `.git/hooks/`. So one install covers the clone and every worktree of it.

The installed hook script finds the lefthook binary through a hardcoded absolute path. That path
points into the checkout that ran the install, or into the checkout where the commit runs. Each
pnpm-based step still needs that checkout's own `node_modules`.

As long as the checkout that ran the install still has `node_modules`, a worktree can find
lefthook through it. This works even before that worktree runs its own `pnpm install`, and the
hooks run there too. Each pnpm-based step still checks for its own `node_modules`, though. When
a step's `node_modules` is missing, that step warns and skips, so the commit goes through
unchecked. This also happens when no checkout with a working lefthook binary exists at all. Then
the hook script itself prints `Can't find lefthook in PATH`, and the commit goes through the same
way.

Either way, the worktree gains real hooks the moment it runs its own `pnpm install`.

`pre-commit` runs Biome, `tsc`, `vitest related`, and `claude plugin validate --strict`. Each one
scopes to what is staged, except `tsc`, which checks the whole project. None of them runs a suite
(ADR 002). `lefthook.yml` holds the exact steps.

There is no `pre-push` key, so a fresh `lefthook install` writes no pre-push hook file. A prior
install may have written one, under an earlier `lefthook.yml` that had the key. The new install
does not remove that old file. For that, run `pnpm exec lefthook uninstall`, then reinstall.

Nothing here is the enforcement layer: CI runs the same checks whether or not the hooks ran.

Run these without a commit:

```bash
pnpm exec lefthook run pre-commit --all-files
```

`--all-files` only widens the steps that lefthook itself scopes with `{staged_files}`: `vitest
related` and `plugin-validate`. `biome` still checks the index only, because `--staged` is
Biome's own selection, not a lefthook file list. So `biome` reports success on a clean tree, even
though it checked nothing.

`vitest related` runs the whole suite instead of a related subset. `plugin-validate` runs on
every plugin in the tree, not only the ones with staged files. Run
`pnpm exec biome check . --error-on-warnings` to check every file with Biome directly.

## Local install

Add the marketplace locally, to test it:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
```
