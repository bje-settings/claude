---
name: sync
description: >
  Move a checkout to its default branch, fast-forward it, and prune local branches
  and worktrees whose work has already landed. Scope comes from the working
  directory. Inside a git repo, it syncs that repo. Outside one, it syncs every
  immediate subdirectory that is a git repo. It never clones, and it skips any
  repo with uncommitted changes.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" *)
disable-model-invocation: true
---

Sync the current checkout, or every checkout one level down.

## Step 1 — Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" sync $ARGUMENTS
```

The command detects its own scope. Do not inspect the directory or classify it first. Pass the
user's arguments straight through. Supported flags: `--dry-run`, `--no-install`, `-j N`.

The command installs dependencies for pnpm only. It syncs a checkout whose lock file is
`yarn.lock` or `package-lock.json` as a repository with no dependencies to install. Install those
by hand.

If the user asked to preview rather than apply, add `--dry-run`.

## Step 2 — Report

Print the command output verbatim. Then list any skipped repositories, each with its reason, but
only if there were any. Do not re-run git commands to verify or expand on the report.

A non-zero exit means at least one repository's sync failed outright, not merely skipped. The
report already names which one, and why. Stderr adds which repository (one repo), or how many of
how many (several). State this plainly. Do not treat the run as successful.

The report prints deleted branches with their SHA. If the user thinks one was removed in error,
restore it with `git branch <name> <sha>`. If it also had a worktree, that needs
`git worktree add` and a fresh dependency install.
