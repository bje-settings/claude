# Contributing

## Tests

```bash
spec/run.sh
```

That is still the one command: it lints, then runs both harnesses. shellspec covers the scripts
that are bash, pytest covers the ones that are Python.

Requires `uv`, `shellspec` and `jq`; `shellcheck` is used if present.

Specs live in `spec/`, tests in `tests/`, fixtures in `fixtures/<plugin>/`. See
`fixtures/gh/README.md` and `fixtures/workstreams/README.md`.

To work on the Python side alone:

```bash
uv sync --locked                      # create .venv and install the dev toolchain
uv run --locked pytest -n auto --cov  # the Python suite, with coverage
uv run --locked ruff check . && uv run --locked ruff format .
```

`--locked` everywhere, as in CI: without it uv silently re-resolves and rewrites `uv.lock` when
`pyproject.toml` has moved, and the versions you tested are not the ones anyone reviewed. Drop it
only when you mean to update the lock, and commit the result.

`uv sync` builds the environment on Python 3.9, the floor every plugin script targets, because
that is what macOS ships at `/usr/bin/python3`.

## Pre-commit hooks

```bash
uv sync --locked && uv run pre-commit install
```

Opt in once per clone and once per worktree: `pre-commit install` writes a hook into the shared
`.git/hooks/`, but the config it needs is read from the working tree you commit from.

The hooks are ruff (lint and format check), the Python suite (`pytest -n auto -x -q`, about two
seconds), `claude plugin validate --strict` over the marketplace manifest and every plugin, and
`shellcheck` over the `.sh` files that remain. They need `uv`, `claude` and `shellcheck` on PATH.
Nothing here is the enforcement layer: CI runs the same checks whether or not you installed them.

Run them without committing:

```bash
uv run pre-commit run --all-files
```

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
/plugin install workstreams@bje
/plugin install field-test@bje
```
