# fixtures/gh

Test fixtures for the `gh` plugin. Used by the specs in `spec/gh/`. The Python side has its
own fixtures and its own README, `tests/gh/README.md`; the two sets are deliberately independent.

Only what the remaining specs use lives here. The builders for package-manager projects,
worktrees, in-progress markers, a corrupt index, a diverged branch and the rest went with the sync
specs when `gh-sync-repo` was ported; those states are built by `tests/gh/conftest.py` now, and
`tests/gh/README.md` documents them. A builder no spec outside `spec/gh/fixtures_spec.sh` uses
does not belong here: it makes that spec assert claims about states nothing else exercises.

These scripts push, rebase and read history, so their behaviour is asserted against real
repositories rather than mocks. Every fixture builds an actual git repository with an actual
(local, bare) origin, so `git fetch`, `git merge --ff-only` and ancestry checks all behave exactly
as they do in production. Nothing here touches the network.

## Layout

| Path | What it is |
| --- | --- |
| `fixtures.sh` | Sourceable library of repository builders. |
| `bin/gh` | A stand-in for the `gh` CLI, put on `PATH` during specs. |

## Repository builders

Two constructors, because the two scopes need different shapes:

- `fixture_create <root>` puts the work tree at `<root>/work` and the bare origin beside it at
  `<root>/origin.git`. Use it for single-repo specs.
- `fixture_create_at <parent> <name>` puts the work tree at `<parent>/<name>` and parks the bare
  origin in `<parent>/.origins`. Use it for fan-out specs, where the scanned directory must
  contain work trees and nothing else. The origins directory is hidden, so the non-recursive
  scan skips it.

Everything else composes on top:

| Builder | State it produces |
| --- | --- |
| `fixture_branch_with_work` | A branch carrying one real commit. |
| `fixture_merge_commit` | Merged with a merge commit, leaving the branch strictly **behind** the default branch, which is where ancestry is the interesting signal. A fast-forward would leave it **at** the tip, where the tip guard takes over instead. |
| `fixture_dirty` | An uncommitted change to a tracked file, which blocks a sync. |
| `fixture_forget_origin_head` | Drops the cached `origin/HEAD`. It is a *symbolic* ref, so it must be deleted as one; `update-ref -d` leaves it resolvable. |
| `fixture_commit` / `fixture_push` | The primitives the builders above compose; usable directly. |
| `fixture_prs` / `fixture_no_prs` | Writes the canned pull-request set the `gh` stub answers from. |
| `fixture_dep_pr` | One `dependencies` pull request as the shepherd scripts see it: number, state, merge state, a check rollup in one of several shapes, auto-merge on or off, Dependabot or human author, an optional merge-risk label. The stub answers `pr view`, `pr checks`, `pr update-branch`, and `pr comment` from the same object, so a spec's claims about checks and its claims about the loop cannot drift apart. |

`spec/gh/fixtures_spec.sh` asserts each of these claims directly, so a fixture that quietly
stopped producing its state cannot make the other specs pass for the wrong reason.

## The `gh` stub

`bin/gh` does **not** fake the output of the command under test. It holds a canned set of pull
requests, applies the same filtering the real `gh pr list` applies server-side (`--state`,
`--base`, `--limit`), projects the fields named by `--json`, and then runs the caller's own
`--jq` expression through real `jq`. The filters in the shepherd scripts, including their fork
exclusion, are therefore exercised rather than assumed.

Controlled by:

| Variable | Effect |
| --- | --- |
| `GH_FIXTURE_PRS` | Path to a JSON array of pull requests. Write it with `fixture_prs`. |
| `GH_FIXTURE_FAIL` | Non-empty makes every call exit non-zero, exercising the degraded path. |
| `GH_FIXTURE_FAIL_HEAD` | Non-empty fails only `--head` calls, so a bulk lookup can succeed while the per-branch one does not. |
| `GH_FIXTURE_CALL_LOG` | If set, every invocation appends its arguments to this file, so a spec can assert how many calls were made and of what shape. |
| `GH_FIXTURE_DEFAULT` | Default branch reported by `gh repo view`. |

Build the pull-request set with `fixture_prs`, composing entries with `fixture_dep_pr`:

```bash
fixture_prs "$GH_FIXTURE_PRS" \
  "$(fixture_dep_pr 1 checks=failed)" \
  "$(fixture_dep_pr 2 merge=BEHIND auto=false)"
```

## Running

```bash
spec/run.sh              # lint, then the suite under bash 5 and bash 3.2
spec/run.sh --quick      # the suite once, under the default shell
shellspec spec/gh/discover_spec.sh:10        # a single example, by line
```

Requires `shellspec` and `jq`; `shellcheck` is used if present. `brew install shellspec jq shellcheck`.
