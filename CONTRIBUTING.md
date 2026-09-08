# Contributing

## Tests

```bash
uv sync --locked                      # create .venv and install the dev toolchain
uv run --locked pytest -n auto --cov  # the whole suite, with coverage
uv run --locked ruff check . && uv run --locked ruff format --check .
```

That is the whole of it. Every plugin script is Python and pytest is the only harness, so `uv` is
the only requirement for the suite; tests that need `jq` or a package manager skip themselves
without it (the `gh` stubs shell out to `jq` for `--jq`), and the pre-commit hooks additionally
need `claude`.

Tests live in `tests/<plugin>/`, with their fixtures beside them: a `conftest.py`, a stub `gh`
under `bin/`, and any canned data the tests read. See `tests/gh/README.md`. Test module basenames
are unique across the suite, so a new one gets its plugin in the name.

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

## Pre-commit hooks

```bash
uv sync --locked && uv run --locked pre-commit install --allow-missing-config
```

Run this once, from the root checkout, not per worktree: `pre-commit install` writes a single hook
into the clone's shared `.git/hooks/`, which every worktree of the clone already shares (a worktree
does not set `core.hooksPath`), so one install covers the clone and all its worktrees. The generated
hook records the `.venv` python it was installed from, so if that checkout is removed the hook falls
back to a `pre-commit` on PATH, and commits fail outright if there is none; re-run the install from a
surviving checkout to fix it. `--allow-missing-config` keeps commits working on branches that predate
`.pre-commit-config.yaml` instead of refusing them.

The hooks are ruff (lint and format check), the Python suite minus the examples marked `slow`,
which run a real package-manager install (`pytest -n auto -x -q -m "not slow"`; CI runs those
too), and `claude plugin validate --strict` over the marketplace manifest and every plugin. They
need `uv` and `claude` on PATH.
Nothing here is the enforcement layer: CI runs the same checks whether or not you installed them.

Run them without committing:

```bash
uv run --locked pre-commit run --all-files
```

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
/plugin install workstreams@bje
/plugin install field-test@bje
```
