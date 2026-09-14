# Contributing

## Tests

```bash
uv sync --locked                      # create .venv and install the dev toolchain
uv run --locked pytest -n auto --cov  # the whole suite, with coverage
uv run --locked ruff check . && uv run --locked ruff format --check .
```

That is the whole of it. Every plugin script is Python and pytest is the only harness, so `uv` is
the only requirement for the suite; tests that need `jq` or a package manager skip themselves
without it (the `gh` stubs shell out to `jq` for `--jq`), and the git hooks' own steps
additionally need `claude` and `uv`, and warn to stderr without them rather than failing the commit.

Tests live in `tests/<plugin>/`, with their fixtures beside them: a `conftest.py`, a stub `gh`
under `bin/`, and any canned data the tests read. See `tests/gh/README.md`. Test module basenames
are unique across the suite, so a new one gets its plugin in the name. Tests that span plugins, or
that cover the repo's own tooling under `scripts/`, sit at the root of `tests/`.

Coverage is gated at 95%, the same threshold CI enforces:

```bash
uv run --locked pytest -n auto --cov --cov-report=xml
python3 tests/coverage_check.py coverage/python.xml 95
```

`--locked` everywhere, as in CI: without it uv silently re-resolves and rewrites `uv.lock` when
`pyproject.toml` has moved, and the versions you tested are not the ones anyone reviewed. Drop it
only when you mean to update the lock, and commit the result.

`uv sync` builds the environment on Python 3.9, the floor every plugin script targets, because
that is what macOS ships at `/usr/bin/python3`.

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

The hook script it installs finds the lefthook binary through whichever checkout ran the install,
or the checkout the commit runs in, but each step still needs that checkout's own `node_modules`
(and `.venv`, for the ruff steps). A worktree that has not run its own `pnpm install` yet prints
`Can't find lefthook in PATH` at commit time and lets the commit through unchecked; it gains the
hooks the moment that worktree runs its own `pnpm install`.

`pre-commit` runs Biome, `tsc`, `vitest related`, `claude plugin validate --strict`, and ruff
(check and format), each scoped to what is staged, except `tsc` which checks the whole project.
None of them runs a suite (ADR 002); `lefthook.yml` holds the exact steps. `pre-push` runs nothing.
Nothing here is the enforcement layer: CI runs the same checks whether or not the hooks ran.

Run them without committing:

```bash
pnpm exec lefthook run pre-commit --all-files
```

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
