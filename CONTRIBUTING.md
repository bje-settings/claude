# Contributing

## Tests

```bash
pnpm install   # the toolchain (and the git hooks, below)
pnpm test      # the suite, with coverage
pnpm exec biome ci . --error-on-warnings && pnpm exec tsc -p tsconfig.json
```

The prerequisite is Node with corepack enabled (`package.json` pins the pnpm version, and `.npmrc`
pins the 22.x release pnpm runs by default). Plugin code is TypeScript, run directly by node
(`.claude/rules/type-ts.md`).

The git hooks' steps need, between them, `node_modules` and `claude`, each warning to stderr
without the one it needs rather than failing the commit.

TypeScript tests are co-located with the code they cover, at `plugins/<plugin>/src/**/*.test.ts`,
with fixtures at `plugins/<plugin>/src/fixtures/`; the shared harness is `harness/` at the
repository root, imported only from test files. See `harness/README.md`.

vitest's thresholds gate TypeScript at 100 on lines, branches, functions and statements, and
`pnpm test` enforces them.

## Language server

This marketplace's `typescript7-lsp` runs the language server from `node_modules/typescript`: add
the marketplace and run `pnpm install` before starting a session.

## Git hooks

```bash
pnpm install
```

`pnpm install` installs the hooks: lefthook's own postinstall runs `lefthook install` (via
`pnpm.onlyBuiltDependencies` in `package.json`, since pnpm 10 blocks a dependency's lifecycle
scripts otherwise), or run `pnpm exec lefthook install` by hand. Do this once, from the root
checkout, not per worktree: lefthook resolves the hooks directory with
`git rev-parse --git-path hooks`, the clone's shared `.git/hooks/`, so one install covers the
clone and every worktree of it.

The hook script it installs finds the lefthook binary through a hardcoded absolute path into
whichever checkout ran the install, or the checkout the commit runs in. Each pnpm-based step still
needs that checkout's own `node_modules`. As long as the installing checkout's
`node_modules` still exists, a worktree that has not run its own `pnpm install` yet still finds
lefthook through it and runs the hooks; each pnpm-based step's own `node_modules` guard is what
then warns and skips, letting the commit through unchecked. Only when no checkout with a working
lefthook binary can be found at all does the hook script itself print `Can't find lefthook in PATH`
and let the commit through the same way. Either way, the worktree gains real hooks the moment it
runs its own `pnpm install`.

`pre-commit` runs Biome, `tsc`, `vitest related`, and `claude plugin validate --strict`,
each scoped to what is staged, except `tsc` which checks the whole project.
None of them runs a suite (ADR 002); `lefthook.yml` holds the exact steps. There is no `pre-push`
key, so a fresh `lefthook install` writes no pre-push hook file; it does not remove one a prior
install already wrote under an earlier revision of `lefthook.yml` that did have the key, for which
`pnpm exec lefthook uninstall` (then reinstall) is the fix. Nothing here is the enforcement layer:
CI runs the same checks whether or not the hooks ran.

Run them without committing:

```bash
pnpm exec lefthook run pre-commit --all-files
```

`--all-files` only widens the steps lefthook itself scopes with `{staged_files}` (`vitest related`,
`plugin-validate`): `biome` keeps checking the index (`--staged` is Biome's own selection, not
a lefthook file list), so it reports success having checked nothing on a clean tree, `vitest
related` runs the whole suite rather than a related subset, and `plugin-validate` runs on every
plugin in the tree rather than only the ones with staged files. Run
`pnpm exec biome check . --error-on-warnings` to check every file with Biome directly.

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
```
