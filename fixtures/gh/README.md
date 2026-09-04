# fixtures/gh

Test fixtures for the `gh` plugin. Used by the specs in `spec/gh/`.

`/gh:sync` deletes branches and removes worktrees, so its behaviour is asserted against real
repositories rather than mocks. Every fixture builds an actual git repository with an actual
(local, bare) origin, so `git fetch`, `git merge --ff-only`, ancestry checks, and worktree
operations all behave exactly as they do in production. Nothing here touches the network.

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
| `fixture_merge_commit` | Merged with a merge commit, leaving the branch strictly **behind** the default branch, which is where ancestry is the interesting signal. |
| `fixture_merge_ff` | Fast-forwarded, leaving the branch **at** the default tip, which is where the tip guard takes over instead. |
| `fixture_merge_squash` | Squashed, leaving **no** ancestry, so only a pull-request signal can prove it. |
| `fixture_dirty` / `fixture_untracked` | Tracked modification (blocks a sync) versus an untracked file (must not). |
| `fixture_corrupt_index` | `git status` exits non-zero with empty stdout, the exact shape the fail-closed preflight guards against. |
| `fixture_in_progress` | A rebase or merge marker, in the main worktree or a linked one. |
| `fixture_worktree` | A linked worktree on a given branch. |
| `fixture_diverge` | A local commit and an origin commit, so the default branch cannot fast-forward. |
| `fixture_remote_advance` | Origin gains a commit the clone lacks, optionally touching a lock file. |
| `fixture_lockfile` | A committed lock file, for the install-detection specs. |

The distinction between the three merge builders is load-bearing. A fast-forward merge leaves the
branch pointing at the same commit as the default branch, so the tip guard keeps it and the
ancestry path is never reached. `spec/gh/fixtures_spec.sh` asserts each of these claims directly,
so a fixture that quietly stopped producing its state cannot make the other specs pass for the
wrong reason.

## The `gh` stub

`bin/gh` does **not** fake the output of the command under test. It holds a canned set of pull
requests, applies the same filtering the real `gh pr list` applies server-side (`--state`,
`--base`, `--limit`), projects the fields named by `--json`, and then runs the caller's own
`--jq` expression through real `jq`. The filter in `gh-sync-repo.sh`, including the fork
exclusion, is therefore exercised rather than assumed.

Controlled by three environment variables:

| Variable | Effect |
| --- | --- |
| `GH_FIXTURE_PRS` | Path to a JSON array of pull requests. Write it with `fixture_prs`. |
| `GH_FIXTURE_FAIL` | Non-empty makes every call exit non-zero, exercising the degraded path. |
| `GH_FIXTURE_DEFAULT` | Default branch reported by `gh repo view`. |

Build the pull-request set with the helpers, which take the head ref name, the head commit, and
optionally a base branch and a cross-repository flag:

```bash
fixture_prs "$GH_FIXTURE_PRS" \
  "$(fixture_pr feature-a "$(fixture_sha "$REPO" feature-a)")" \
  "$(fixture_pr patch-1 abc123 main true)"     # a fork PR, which must be ignored
```

## Running

```bash
spec/run.sh              # lint, then the suite under bash 5 and bash 3.2
spec/run.sh --quick      # the suite once, under the default shell
shellspec spec/gh/gh_sync_repo_spec.sh:129   # a single example, by line
```

Requires `shellspec` and `jq`; `shellcheck` is used if present. `brew install shellspec jq shellcheck`.
