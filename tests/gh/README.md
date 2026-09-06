# tests/gh

The pytest side of the `gh` plugin: the tests for the scripts that are Python, and the fixtures
they build their state from.

`/gh:sync` deletes branches and removes worktrees, so its behaviour is asserted against real
repositories rather than mocks. Every fixture builds an actual git repository with an actual
(local, bare) origin, so `git fetch`, `git merge --ff-only`, ancestry checks, and worktree
operations all behave exactly as they do in production. Nothing here reaches the network for the
code under test; the examples marked `slow` do run a real package manager, which is given the
developer's own corepack cache (`COREPACK_HOME`) so its shim has nothing left to download.

The bash half of the plugin still has its shellspec specs in `spec/gh/` and its own fixtures in
`fixtures/gh/`, documented in `fixtures/gh/README.md`. Those are a port behind; the two sets are
deliberately independent, so deleting a shell script never means editing a Python test.

## Layout

| Path | What it is |
| --- | --- |
| `conftest.py` | The repository, package-manager, and pull-request builders, plus the `gh` and `sync_repo` fixtures. |
| `bin/gh` | A stand-in for the `gh` CLI, put on `PATH` for every test. |
| `scenarios.py` | The repository states whose whole report is compared against the shell version. |
| `golden/bash-output.json` | What `gh-sync-repo.sh` printed for each of those, captured before it was deleted. |
| `test_*.py` | The ported spec examples (the source spec is named in each module docstring), the direct tests for `lib/`, and the parity check. |

## The fixtures

`conftest.py` gives every test a `gh` fixture: a private temp directory, an empty canned
pull-request set, the stub `gh` ahead of any real one on `PATH`, and one repository at
`gh.repo`. `sync_repo` runs `gh-sync-repo.py` against it. Both build on `sandbox` and
`run_script` from `tests/conftest.py`.

Two constructors, because the two scopes need different shapes:

- `gh.create(root)` puts the work tree at `<root>/work` and the bare origin beside it at
  `<root>/origin.git`. Use it for single-repo tests.
- `gh.create_at(parent, name)` puts the work tree at `<parent>/<name>` and parks the bare origin
  in `<parent>/.origins`. Use it for fan-out tests, where the scanned directory must contain work
  trees and nothing else. The origins directory is hidden, so the non-recursive scan skips it.

Everything else composes on top:

| Builder | State it produces |
| --- | --- |
| `branch_with_work` | A branch carrying one real commit. |
| `merge_commit` | Merged with a merge commit, leaving the branch strictly **behind** the default branch, which is where ancestry is the interesting signal. |
| `merge_ff` | Fast-forwarded, leaving the branch **at** the default tip, which is where the tip guard takes over instead. |
| `merge_squash` | Squashed, leaving **no** ancestry, so only a pull-request signal can prove it. |
| `dirty` / `untracked` | Tracked modification (blocks a sync) versus an untracked file (must not). |
| `corrupt_index` | `git status` exits non-zero with empty stdout, the exact shape the fail-closed preflight guards against. |
| `in_progress` | A rebase or merge marker, in the main worktree or a linked one. |
| `worktree` | A linked worktree on a given branch. |
| `diverge` | A local commit and an origin commit, so the default branch cannot fast-forward. |
| `remote_advance` | Origin gains a commit the clone lacks, optionally touching a lock file. |
| `lockfile` | A committed lock file, for the install-detection tests. |
| `js_project` | A `package.json` plus lock file with no dependencies, so a real install succeeds offline. Takes `pnpm` (the default), `yarn`, or `npm`. Yarn means Berry, pinned per project through the `packageManager` field so the fixture does not depend on which yarn is on `PATH`. |
| `remote_update_lock` | Origin regenerates the lock file legitimately, by adding a dependency on a directory inside the repo. Appending to a lock file would corrupt it instead. A `file:` path resolves without the network and every manager records a real dependency, so one mechanism covers all three. |
| `remote_break_lock` | Origin pushes an unparseable lock file, so the install fails for a real reason. |
| `remote_drop_lockfile` | Origin deletes the lock file: a lock-file change with nothing left to install. |
| `remove_origin` | Drops the `origin` remote, so the preflight refuses before anything is written. |
| `drop_remote_branches` | Removes every remote-tracking branch, so no default branch resolves at all. |
| `break_origin` | The remote exists but is unreachable, so fetch fails while the preflight still passes. |
| `forget_origin_head` | Drops the cached `origin/HEAD`. It is a *symbolic* ref, so it must be deleted as one; `update-ref -d` leaves it resolvable. |
| `lock_index` | An index lock, which `git status` tolerates but ref-updating commands refuse, so a mid-run git failure can be provoked without corrupting anything. |
| `git_shim` | A `PATH` whose `git` refuses the named subcommands and forwards everything else, for the guards that fire when an enumeration cannot be read. |
| `dep_pr` | One `dependencies` pull request as the shepherd scripts see it: number, state, merge state, a check rollup in one of several shapes, auto-merge on or off, Dependabot or human author, an optional merge-risk label. |
| `many_prs` | Filler merged pull requests, plus any passed explicitly. When the filler count reaches the script's bulk limit, the explicit ones sit past the window and are reachable only by a per-branch query. |

`corrupt_index` resolves the real git dir rather than assuming `<work>/.git` is a directory,
because in a linked worktree it is a file.

The distinction between the three merge builders is load-bearing. A fast-forward merge leaves the
branch pointing at the same commit as the default branch, so the tip guard keeps it and the
ancestry path is never reached. `test_fixtures.py` asserts each of these claims directly, so a
fixture that quietly stopped producing its state cannot make the other tests pass for the wrong
reason.

Package managers change behaviour when `CI` is set, and the fixtures have to opt out of it.
Yarn Berry enables immutable installs on its own under CI, which forbids creating a lock file
(`YN0028`) and so breaks the very fixture whose job is to write one; it is run with
`--no-immutable`. The code under test still performs a plain `--immutable` install.

Do not perturb manager-specific metadata to force a lock change. An override for a package
nothing depends on moved the lock under pnpm 10 and was dropped by pnpm 11, so the install test
passed locally and failed in CI. A real dependency is recorded by every version of every manager.

## The `gh` stub

`bin/gh` does **not** fake the output of the command under test. It holds a canned set of pull
requests, applies the same filtering the real `gh pr list` applies server-side (`--state`,
`--base`, `--head`, `--limit`), and projects the fields named by `--json`. The scripts do their
own projection and their own fork exclusion in Python now, so answering with the projected JSON
is what exercises them; `test_fixtures.py` asserts the split, checking that `prs.own_rows` over
what the stub returns is what drops a fork.

`--jq` is still accepted and is applied by piping the projected JSON through real jq, so a caller
that uses it gets what real gh would give. Without jq on `PATH` a `--jq` call fails loudly rather
than quietly returning unfiltered JSON.

Controlled by:

| Variable | Effect |
| --- | --- |
| `GH_FIXTURE_PRS` | Path to a JSON array of pull requests. Write it with `gh.write_prs`. |
| `GH_FIXTURE_FAIL` | Non-empty makes every call exit non-zero, exercising the degraded path. |
| `GH_FIXTURE_FAIL_HEAD` | Non-empty fails only `--head` calls, so a bulk lookup can succeed while the per-branch one does not. |
| `GH_FIXTURE_CALL_LOG` | If set, every invocation appends its arguments to this file, so a test can assert how many calls were made and of what shape. |
| `GH_FIXTURE_DEFAULT` | Default branch reported by `gh repo view`. |
| `GH_FIXTURE_REPO` | `nameWithOwner` reported by `gh repo view`. |
| `GH_FIXTURE_RUNS` | JSON array for `gh run list`. |
| `GH_FIXTURE_RUN_LOG` | File whose content `gh run view --log-failed` prints. |
| `GH_FIXTURE_FAIL_REBASE` | Non-empty makes `pr update-branch` fail. |
| `GH_FIXTURE_WATCH_HANG` | Non-empty makes `pr checks --watch` never return, so a caller's own bound can be exercised. |

Build the pull-request set with the helpers, which take the head ref name, the head commit, and
optionally a base branch and a cross-repository flag:

```python
gh.write_prs(
    gh.pr("feature-a", gh.sha(gh.repo, "feature-a")),
    gh.pr("patch-1", "abc123", "main", True),  # a fork PR, which must be ignored
)
```

## Parity with the shell version

`gh-sync-repo.py` prints the same report `gh-sync-repo.sh` did, and that is asserted rather than
assumed. `scenarios.py` builds forty states — every skip reason, and the lines a normal run
produces — and `golden/bash-output.json` holds what the shell script printed for each, captured
before it was deleted, with commit hashes and the sandbox path normalised out.
`test_output_parity.py` runs the port over the same scenarios and compares.

Adding a scenario after the shell script is gone means adding a golden entry by hand; prefer an
ordinary test in `test_gh_sync_repo.py` for anything new, and keep the golden as the record of
what the port had to match.

## Running

```bash
uv run --locked pytest -n auto --cov       # the Python suite, with coverage
uv run --locked pytest tests/gh -q         # this directory alone
spec/run.sh                                # lint, then both harnesses
```

`jq` is needed only for the one test that exercises the stub's `--jq` passthrough, which is
skipped without it. The install tests are skipped wherever their package manager is missing or
cannot run.

Those install tests are marked `slow`: each writes a lock file with the real package manager and
then installs from it, which makes them the slowest examples here and the only ones that need a
package manager installed at all. The pre-commit `pytest` hook deselects them with
`-m "not slow"`; CI and `spec/run.sh` run the whole suite.
