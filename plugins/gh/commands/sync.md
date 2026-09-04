---
description: >
  Move a checkout to its default branch, fast-forward it, and prune local branches
  and worktrees whose work has already landed. Scope is detected from the working
  directory: inside a git repo it syncs that repo; outside one it syncs every
  immediate subdirectory that is a git repo. Never clones, and skips any repo with
  uncommitted changes.
allowed-tools: Bash
---

Sync the current checkout, or every checkout one level down.

## Step 1 — Run

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-sync.sh $ARGUMENTS
```

The script detects its own scope, so do not inspect the directory or classify it first.
Pass the user's arguments straight through. Supported flags: `--dry-run`, `--no-install`,
`-j N`.

If the user asked to preview rather than apply, add `--dry-run`.

## Step 2 — Report

Print the script output verbatim. Then, and only if there were any, list the repositories
that were skipped along with the reason given for each. Do not re-run git commands to
verify or expand on the report.

Deleted branches are printed with their SHA. If the user thinks one was removed in error,
it is restored with `git branch <name> <sha>`.
