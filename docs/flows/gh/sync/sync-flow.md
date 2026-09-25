---
type: Reference
description: How `gh.ts sync` finds its checkouts, syncs each one in process, and which outcome sets its exit status.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# sync flow

`node scripts/gh.ts sync` syncs the current checkout, or every checkout one level down. The
`/gh:sync` skill runs it. Each repository job is the `sync-repo` work, called in this process.

```mermaid
flowchart TD
    A[sync run] --> B{Arguments valid?<br/>known flags, -j a positive whole number}
    B -->|Help asked| H([Print usage, exit 0])
    B -->|No| Z1([Refused: unknown flag or bad -j, exit 2]):::stop
    B -->|Yes| C{Target is a directory?}
    C -->|No| Z2([Refused: not a directory, exit 2]):::stop
    C -->|Yes| D{Target inside a checkout?}
    D -->|Yes| E[Scope: that checkout]
    D -->|No| F{Target can be listed?}
    F -->|No| Z3([Refused: could not read, exit 2]):::stop
    F -->|Yes| G[Scope: each subdirectory that is a checkout root]
    E --> I{git can run?}
    G --> I
    I -->|No| Z4([Refused: missing git, exit 2]):::stop
    I -->|Yes, one checkout from inside it| J[Run the job; its lines go straight out]
    I -->|Yes, a directory of checkouts| K{Any checkout found?}
    K -->|No| Z5([No git repositories directly inside, exit 0]):::stop
    K -->|Yes| L[Run up to -j jobs at a time, each report held,<br/>then print a header and each report in directory order]
    J --> M{Job threw?}
    M -->|Yes| Z6([Failure line, then failed:<br/>the sync to the repo failed, exit 1]):::stop
    M -->|No| OK1([ok, exit 0])
    L --> N{Any job threw?}
    N -->|Yes| Z7([Failure line in that section, then failed:<br/>n of m repositories failed to sync, exit 1]):::stop
    N -->|No| OK2([ok, exit 0])

    subgraph job [one repository job: answers 0 unless it throws]
        direction TB
        R1{Checkout, origin remote, no operation<br/>in progress, tree readable and clean?}
        R1 -->|No| RS([skipped: the reason]):::stop
        R1 -->|Yes| R2{Default branch known? origin HEAD,<br/>then gh, then main or master}
        R2 -->|No| RS
        R2 -->|Yes| R3{Fetch succeeded?}
        R3 -->|No| RF([fetch failed; nothing changed]):::stop
        R3 -->|Yes| R4{origin default branch there locally?}
        R4 -->|No| RS
        R4 -->|Yes| R5{On the default branch,<br/>or the switch worked?}
        R5 -->|No: prune only| R7
        R5 -->|Yes| R6[Fast-forward when it can, or report diverged;<br/>after a move, install with pnpm if a lock file changed]
        R6 --> R7{Merged pull requests or<br/>ancestry readable?}
        R7 -->|Neither| RP([No branch pruned: no merge proof can be read]):::stop
        R7 -->|Yes| R8{Worktrees and branches listable,<br/>and no other worktree mid-operation?}
        R8 -->|No| RS
        R8 -->|Yes| R9{Branch has merge proof, a clean or no worktree,<br/>and a tip not at the origin default?}
        R9 -->|No| RK([Keep the branch, say why]):::stop
        R9 -->|Yes| RD([Remove its worktree, delete the branch])
    end

    J -.-> R1
    L -.-> R1

    X[Any error outside a job<br/>that it did not expect] --> Z8([node's own stack trace, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A skipped repository and a kept branch are normal outcomes, and the job still answers 0. Only a
job that throws makes `sync` exit 1, and the report is on stdout before the verdict. With
`--dry-run`, each change becomes a `would ...` line and nothing changes. `--no-install` removes
the install step. `gh.ts` has no catch-all, so an error outside a job ends in node's own stack
trace.
