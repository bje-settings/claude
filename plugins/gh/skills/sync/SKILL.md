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

## Flow

```mermaid
flowchart TD
    A[Working directory] --> B{Is it a git repo?}
    B -->|Yes| C[Sync this repo]
    B -->|No| D[Sync each immediate subdir that is a repo]
    D --> C

    C --> E{Tree clean, origin present,<br/>no operation in progress?}
    E -->|No| F([Skip the repo, say why]):::stop
    E -->|Yes| G[Fetch, then move to the default branch]

    G --> H{Can it fast-forward?}
    H -->|No| I([Report diverged, leave it alone]):::stop
    H -->|Yes| J[Fast-forward]
    J --> K{Did a lock file change?}
    K -->|Yes| L[Install dependencies]
    K -->|No| M[For each local branch]
    L --> M

    M --> N{Merge proof?}
    N -->|Merged PR at this commit| O[Delete branch]
    N -->|Ancestor of default branch| O
    N -->|Name matched, other commit| P([Keep: not this commit]):::stop
    N -->|Lookup failed| Q([Keep: never checked]):::stop
    N -->|Nothing found| R([Keep: no proof]):::stop

    O --> S{Branch has a worktree?}
    S -->|Clean| T[Remove worktree, then delete]
    S -->|Dirty or unreadable| U([Keep both, say why]):::stop
    S -->|None| V[Delete, report its SHA]

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

Every path that keeps a branch says which of the four reasons applied. The distinction matters:
"never checked" is not "no proof", and reporting one as the other asserts something the command
did not establish.

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
it is restored with `git branch <name> <sha>`; if it also had a worktree, that needs
`git worktree add` and a fresh dependency install.
