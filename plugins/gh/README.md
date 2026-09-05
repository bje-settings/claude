# gh

GitHub and git workflow commands for the `bje` enterprise.

## `/gh:sync`

Moves a checkout to its default branch, fast-forwards it, and prunes local branches and
worktrees whose work has already landed.

Scope comes from the working directory:

| Working directory | What happens |
| --- | --- |
| A git repository | That repository is synced. |
| Not a git repository | Every **immediate** subdirectory that is a git repository is synced, in parallel. |

Detection is non-recursive and never clones. A directory with no git repositories directly
inside it is a no-op, so running this somewhere unexpected costs nothing.

### Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Fetch and report what would happen. No checkout, merge, install, or delete. The fetch itself still updates remote-tracking refs. |
| `--no-install` | Skip dependency installation even when a lock file changed. |
| `-j N` | Parallel jobs in fan-out mode (default 4). |

### What one repository gets

1. Skipped outright, before anything is modified, if it is not a git repo, has no `origin`,
   has a git operation in progress in any of its worktrees, has uncommitted changes, or has a
   working tree that cannot be read at all. Untracked files do not block it: the checkout,
   fast-forward, and branch deletion cannot touch them. A dependency install can.
   A repo is also skipped, after the fetch, if its default branch cannot be resolved or
   `origin/<default>` does not exist locally.
2. `git fetch --prune origin`.
3. Checkout of the default branch, then `git merge --ff-only`. Fast-forward only, so a
   diverged branch is reported for manual handling rather than merged automatically.
4. Dependency install, but only if the pull actually changed a lock file. Detected from
   `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`, and run with pnpm, Yarn Berry, or
   npm respectively. Yarn 1 and bun are deliberately out of scope: a repo on either gets the
   lock-file notice and installs by hand.
5. Branch and worktree pruning.

### How a branch is proven merged

A branch is deleted only with positive proof, from either of two independent signals:

- **A merged pull request.** It must have merged into the default branch, must have come from
  this repository rather than a fork, and its head commit must be exactly where your local
  branch still points. That last condition is what makes it evidence about your commits rather
  than about a branch name: a name that was reused, or a branch you committed to after the merge
  landed, no longer matches and is kept. This signal is what catches squash and rebase merges,
  which leave no ancestry behind. One `gh` call lists the 200 most recently merged pull requests.
  If that window fills up it may be hiding older ones, so any branch it cannot account for gets a
  second call asking about that branch alone, and a busy repository does not quietly stop pruning.
- **Ancestry**, via `git branch --merged origin/<default>`. This is what catches a branch merged
  locally and pushed with no pull request at all.

Either one is sufficient; neither one alone is complete. A branch with no proof is kept, and the
report says what was actually established rather than guessing at a cause:

| Report | What it means |
| --- | --- |
| `no merge proof` | No merged pull request from this repository used this name, and it is not an ancestor of the default branch. |
| `merged PRs used this name; none at this commit` | Something merged under this name, but not this commit. Either the branch was rebased before merging, or the name was reused for unrelated work. The two are indistinguishable here, so the branch is kept. |
| `too many merged PRs used this name to tell` | The per-branch lookup filled up, so "none at this commit" could not be established. |
| `could not ask about this branch` | The lookup did not complete. Nothing was established either way. |

The last three are all reasons to keep a branch, but they are different statements, and a report
that collapsed them would be asserting things it had not checked. A `gone` upstream is never
treated as proof on its own, since a pruned remote branch can equally mean the work was abandoned.

If **both** signals are unavailable (no `gh`, or the branch listing failed), the repo is
reported and pruning is skipped entirely rather than run on the surviving signal.

Two further branches are excluded even when they do have proof: the default branch itself, and
any branch whose tip is the same commit as `origin/<default>`, which has nothing to prune and is
typically a branch just created and not yet committed to.

Deletion uses `git branch -D`, which is required because a squash-merged branch is not an
ancestor of anything. Every deleted branch is reported with its SHA, so a mistake is undone with
`git branch <name> <sha>`. If the branch also had a worktree, that directory was removed too, and
restoring it needs `git worktree add` plus a fresh dependency install.

A worktree holding uncommitted changes outranks the merge proof: both the worktree and its
branch are left alone and reported.

## Session start hook

On session start only (not on resume, `/clear`, or compaction) the plugin runs a **report-only**
check and, if there is anything worth acting on, asks whether to run `/gh:sync`.

- Outside a git repository it runs the fan-out check in `--dry-run` and reports the findings.
- Inside a git repository, if HEAD is not on the default branch, it says so. This branch is
  purely local and does not hit the network.
- Otherwise it stays silent.

JSON on both ends (reading the payload, writing the response) is handled by `hooks/hook-io.py`,
which also holds the message text. Doing that inline with `python3 -c` buried it in quoted
heredocs inside the shell, where it could not be linted or tested.

The hook never changes a branch, worktree, or working tree, and always exits 0, so it cannot
block a session from starting or surprise you with a change you did not ask for. In fan-out mode
it does fetch, which updates remote-tracking refs, and that is one network round trip per
repository against the hook's 60 second budget.

## Credentials

`direnv` sets `GH_CONFIG_DIR` per directory, and these scripts inherit the environment of the
directory they were invoked from. Run the command from inside the org tree you are targeting so
the correct GitHub account is active. This is also why `~/Code/@bje/` itself is a no-op: its
immediate children are org directories rather than repositories, and an enterprise-wide sync
would need different credentials per org anyway.

## Running outside Claude Code

Both scripts are plain bash with no dependency on the plugin runtime:

```bash
plugins/gh/scripts/gh-sync.sh --dry-run ~/Code/@bje/@bje-settings
plugins/gh/scripts/gh-sync-repo.sh --dry-run ~/Code/@bje/@bje-settings/terraform
```

They are written for bash 3.2, the version macOS ships at `/bin/bash`.

## Tests

Because this command deletes branches and removes worktrees, its behaviour is asserted against
real git repositories rather than mocks. Specs live in `spec/gh/`, fixtures in `fixtures/gh/`.

```bash
spec/run.sh              # lint, then the suite under bash 5 and bash 3.2
spec/run.sh --quick      # the suite once, under the default shell
```

The suite runs under both shells deliberately: bash 5 is what most contributors have on `PATH`,
but `/bin/bash` is 3.2 on macOS and is what actually executes these scripts.

CI adds a coverage job (`kcov`, measured over `plugins/gh` only) which fails below 95%, enforced
by `spec/coverage-check.py`. Run it locally with `spec/run.sh --coverage`, which needs kcov.
All three supported package managers have an install spec. The uncovered remainder is defensive branches
guarding states that cannot be provoked, such as a ref that resolves during enumeration and fails
immediately after.

Covered in particular: every path that can delete something (each merge signal, a reused branch
name, a fork's pull request, a pull request merged into another base, worktrees clean and dirty),
every preflight refusal, and the guarantee that `--dry-run` changes nothing it says it would
change. See `fixtures/gh/README.md` for how to build a scenario.
