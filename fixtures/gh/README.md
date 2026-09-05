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
| `fixture_js_project` | A `package.json` plus lock file with no dependencies, so a real install succeeds offline. Takes `pnpm` (the default), `yarn`, or `npm`. Yarn means Berry, pinned per project through the `packageManager` field so the fixture does not depend on which yarn is on `PATH`. |
| `fixture_remote_update_lock` | Origin regenerates the lock file legitimately, by adding a dependency on a directory inside the repo. Appending to a lock file would corrupt it instead. A `file:` path resolves without the network and every manager records a real dependency, so one mechanism covers all three. |
| `fixture_remote_break_lock` | Origin pushes an unparseable lock file, so the install fails for a real reason. |
| `fixture_break_origin` | The remote exists but is unreachable, so fetch fails while the preflight still passes. |
| `fixture_forget_origin_head` | Drops the cached `origin/HEAD`. It is a *symbolic* ref, so it must be deleted as one; `update-ref -d` leaves it resolvable. |
| `fixture_lock_index` | An index lock, which `git status` tolerates but ref-updating commands refuse, so a mid-run git failure can be provoked without corrupting anything. |
| `fixture_many_prs` | Filler merged pull requests, plus any passed explicitly. When the filler count reaches the script's bulk limit, the explicit ones sit past the window and are reachable only by a per-branch query. |

`fixture_corrupt_index` resolves the real git dir rather than assuming `$work/.git` is a
directory, because in a linked worktree it is a file.

The distinction between the three merge builders is load-bearing. A fast-forward merge leaves the
branch pointing at the same commit as the default branch, so the tip guard keeps it and the
ancestry path is never reached. `spec/gh/fixtures_spec.sh` asserts each of these claims directly,
so a fixture that quietly stopped producing its state cannot make the other specs pass for the
wrong reason.

Package managers change behaviour when `CI` is set, and the fixtures have to opt out of it.
Yarn Berry enables immutable installs on its own under CI, which forbids creating a lock file
(`YN0028`) and so breaks the very fixture whose job is to write one; it is run with
`--no-immutable`. The code under test still performs a plain `--immutable` install. `spec/run.sh`
exports `CI=true` for this reason, so a local run exercises the same behaviour the runner does.

Do not perturb manager-specific metadata to force a lock change. An override for a package
nothing depends on moved the lock under pnpm 10 and was dropped by pnpm 11, so the install spec
passed locally and failed in CI. A real dependency is recorded by every version of every manager.

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
| `GH_FIXTURE_FAIL_HEAD` | Non-empty fails only `--head` calls, so a bulk lookup can succeed while the per-branch one does not. |
| `GH_FIXTURE_CALL_LOG` | If set, every invocation appends its arguments to this file, so a spec can assert how many calls were made and of what shape. |
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
