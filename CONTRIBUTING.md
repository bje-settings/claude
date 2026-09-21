# Contributing

## Tests

```bash
pnpm install                          # the TypeScript toolchain (and the git hooks, below)
uv sync --locked                      # create .venv and install the Python toolchain
pnpm test                             # the TypeScript suite, with coverage
uv run --locked pytest -n auto --cov  # the Python suite, with coverage
pnpm exec biome ci . --error-on-warnings && pnpm exec tsc -p tsconfig.json
uv run --locked ruff check . && uv run --locked ruff format --check .
```

Two toolchains, two prerequisites: Node with corepack enabled (`package.json` pins the pnpm
version, and `.npmrc` pins the 22.x release pnpm runs by default), and `uv`. New plugin code
is TypeScript, run directly by node (`.claude/rules/type-ts.md`), and the Python that remains
retires piece by piece, each against its own issue (`.claude/rules/type-py.md` names them).

Tests that need `jq` or a package manager skip themselves without it (the `gh` stubs shell out to
`jq` for `--jq`), and the git hooks' steps need, between them, `node_modules`, `claude` and `uv`,
each warning to stderr without the one it needs rather than failing the commit.

TypeScript tests are co-located with the code they cover, at `plugins/<plugin>/src/**/*.test.ts`,
with fixtures at `plugins/<plugin>/src/fixtures/`; the shared harness is `harness/` at the
repository root, imported only from test files. See `harness/README.md`.

Python tests live in `tests/<plugin>/`, with their fixtures beside them: a `conftest.py`, a stub
`gh` under `bin/`, and any canned data the tests read. Only `field-test` still has any. Test
module basenames are unique across the suite, so a new one gets its plugin in the name. Tests
that span plugins, or that cover the repo's own tooling under `scripts/`, sit at the root of
`tests/`.

vitest's thresholds gate TypeScript at 100 on lines, branches, functions and statements, and
`pnpm test` enforces them. Python coverage is gated at 95%, the same threshold CI enforces:

```bash
uv run --locked pytest -n auto --cov --cov-report=xml
python3 tests/coverage_check.py coverage/python.xml 95
```

`--locked` everywhere, as in CI: without it uv silently re-resolves and rewrites `uv.lock` when
`pyproject.toml` has moved, and the versions you tested are not the ones anyone reviewed. Drop it
only when you mean to update the lock, and commit the result.

`uv sync` builds the environment on Python 3.9, the floor the remaining Python scripts target,
because that is what macOS ships at `/usr/bin/python3`.

## Language server

Sessions on this checkout run the TypeScript language server, which expects the server on `PATH`.
Install it once per machine (`CLAUDE.md`'s "Language server" section has the why):

```bash
npm install -g typescript-language-server typescript
```

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
needs that checkout's own `node_modules` (ruff needs only `uv` on PATH: `uv run` provisions its own
`.venv` on demand, unlike the pnpm-based steps). As long as the installing checkout's
`node_modules` still exists, a worktree that has not run its own `pnpm install` yet still finds
lefthook through it and runs the hooks; each pnpm-based step's own `node_modules` guard is what
then warns and skips, letting the commit through unchecked. Only when no checkout with a working
lefthook binary can be found at all does the hook script itself print `Can't find lefthook in PATH`
and let the commit through the same way. Either way, the worktree gains real hooks the moment it
runs its own `pnpm install`.

`pre-commit` runs Biome, `tsc`, `vitest related`, `claude plugin validate --strict`, and ruff
(check and format), each scoped to what is staged, except `tsc` which checks the whole project.
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
`plugin-validate`, ruff): `biome` keeps checking the index (`--staged` is Biome's own selection, not
a lefthook file list), so it reports success having checked nothing on a clean tree, `vitest
related` runs the whole suite rather than a related subset, and `plugin-validate` runs on every
plugin in the tree rather than only the ones with staged files. Run
`pnpm exec biome check . --error-on-warnings` to check every file with Biome directly.

## Publishing a plugin downstream

`/publish <plugin> <dest>` mirrors one plugin into a repository that cannot read this one, as a
read-only copy. It runs the suite and manifest validation first, then
`scripts/publish-plugin.py`, then opens a pull request in the destination.

Run `python3 scripts/publish-plugin.py <plugin> <dest> --check` on its own any time to see whether
a copy is current; it writes nothing and exits 1 if there is drift. Bump the plugin's `version`
before publishing a content change, since downstream that is how one copy is told from another.

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
/plugin install field-test@bje
```
