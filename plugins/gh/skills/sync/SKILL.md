---
name: sync
description: >
  Move a checkout to its default branch, fast-forward it, and prune local branches
  and worktrees whose work has already landed. Scope is detected from the working
  directory: inside a git repo it syncs that repo; outside one it syncs every
  immediate subdirectory that is a git repo. Never clones, and skips any repo with
  uncommitted changes.
allowed-tools: Bash
disable-model-invocation: true
---

Sync the current checkout, or every checkout one level down.

## Step 1 — Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/gh.ts" sync $ARGUMENTS
```

The command detects its own scope, so do not inspect the directory or classify it first.
Pass the user's arguments straight through. Supported flags: `--dry-run`, `--no-install`,
`-j N`.

Only pnpm is installed for. A checkout whose lock file is `yarn.lock` or `package-lock.json`
is synced as a repository with no dependencies to install; those are installed by hand.

If the user asked to preview rather than apply, add `--dry-run`.

## Step 2 — Report

Print the command output verbatim. Then, and only if there were any, list the repositories
that were skipped along with the reason given for each. Do not re-run git commands to
verify or expand on the report.

A non-zero exit means at least one repository's sync failed outright, not merely skipped;
the report already names which one and why, and stderr adds how many of how many. Say so
plainly rather than treating the run as successful.

Deleted branches are printed with their SHA. If the user thinks one was removed in error,
it is restored with `git branch <name> <sha>`; if it also had a worktree, that needs
`git worktree add` and a fresh dependency install.
