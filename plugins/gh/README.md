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
| `--dry-run` | Fetch and report what would happen. No checkout, merge, install, or delete. |
| `--no-install` | Skip dependency installation even when a lock file changed. |
| `-j N` | Parallel jobs in fan-out mode (default 4). |

### What one repository gets

1. Skipped outright, before anything is modified, if it is not a git repo, has no `origin`,
   has a git operation in progress, or has uncommitted changes. Untracked files do not count:
   nothing this command does can touch them.
2. `git fetch --prune origin`.
3. Checkout of the default branch, then `git merge --ff-only`. Fast-forward only, so a
   diverged branch is reported for manual handling rather than merged automatically.
4. Dependency install, but only if the pull actually changed a lock file. Detected from
   `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, or `bun.lockb`.
5. Branch and worktree pruning.

### How a branch is proven merged

A branch is deleted only with positive proof, from either of two independent signals:

- **A merged pull request** whose head ref is that branch. This is what catches squash and
  rebase merges, which leave no ancestry behind. One `gh` call covers the whole repository.
- **Ancestry**, via `git branch --merged origin/<default>`. This is what catches a branch
  merged locally and pushed with no pull request at all.

Either one is sufficient; neither one alone is complete. A branch with no proof is kept and
reported. A `gone` upstream is never treated as proof on its own, since a pruned remote branch
can equally mean the work was abandoned.

Two branches are deliberately never deleted: the default branch, and any branch pointing exactly
at the default branch tip, which is a branch that was just created and has no commits yet. Once
the default branch moves past it, such a branch becomes an ordinary merged branch and is pruned;
that is safe, because every commit it contains is already in the default branch.

Deletion uses `git branch -D`, which is required because a squash-merged branch is not an
ancestor of anything. Every deleted branch is reported with its SHA, so a mistake is undone with
`git branch <name> <sha>`.

A worktree holding uncommitted changes outranks the merge proof: both the worktree and its
branch are left alone and reported.

## Session start hook

On session start only (not on resume, `/clear`, or compaction) the plugin runs a **report-only**
check and, if there is anything worth acting on, asks whether to run `/gh:sync`.

- Outside a git repository it runs the fan-out check in `--dry-run` and reports the findings.
- Inside a git repository, if HEAD is not on the default branch, it says so. This branch is
  purely local and does not hit the network.
- Otherwise it stays silent.

The hook never modifies a repository and always exits 0, so it cannot block a session from
starting or surprise you with a change you did not ask for.

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
