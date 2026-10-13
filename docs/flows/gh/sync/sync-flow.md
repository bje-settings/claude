---
type: Reference
description: How `gh.ts sync` finds its checkouts, syncs each one in process, and which outcome sets its exit status.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-13
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

    subgraph job [one repository job: answers nothing unless it throws]
        direction TB
        R1{Checkout, origin remote, tree readable and clean,<br/>no operation in progress here or in<br/>any linked worktree?}
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
        R7 -->|Yes| R8{Worktrees and branches listable,<br/>and no linked worktree mid-operation now?}
        R8 -->|No| RS
        R8 -->|Yes| R9{Merge proof for the tip read now? A merged PR<br/>with its merge commit on the origin default, at this tip<br/>or with each commit patch-equal in its head;<br/>or this tip on the origin default}
        R9 -->|No, or a fetch or probe failed| RK([Keep the branch, say why]):::stop
        R9 -->|Yes| R10{A clean or no worktree on the same branch still,<br/>and a tip not at the origin default?}
        R10 -->|No| RK
        R10 -->|Yes| RD([Remove its worktree, delete the branch])
    end

    J -.-> R1
    L -.-> R1

    X[Any error, in a job or outside one,<br/>that it did not expect] --> Z8([scripts/gh.ts's own catch:<br/>gh: message, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The merge proof uses the tip that the prune loop read, not the branch name (#248). The query
for merged pull requests has no base filter, so a stacked pull request is in it (#348). A row
proves a merge only when its merge commit is on the origin default. A row at another commit
proves the branch when `git cherry` finds each local commit in the head (#351, #450). The proof
fetches a merge commit or a head that is not local, one time. Two notes keep a branch on a git
failure: `could not fetch a merged PR's commits` and `git could not compare its commits`. Each
ends `unproven, not disproven`.

A skipped repository is a normal outcome. So is a kept branch. The job answers nothing either
way. Only a throw makes `sync` exit 1. The report is on stdout before the verdict.

The in-progress check on another worktree runs twice. It runs early, in the same preflight step
as the other checkout guards, before the fetch and the advance. It runs again, fresh, right
before the prune loop, because a worktree can switch branch in between. So a stopped rebase there
skips the whole repository on sight. Nothing is fetched, and no line names the default branch. A
worktree that switches branch afterward is checked again, right before its branch would be
removed.

With `--dry-run`, each change becomes a `would ...` line and nothing changes. `--no-install`
removes the install step. `scripts/gh.ts` catches an error it did not expect, in a job or outside
one. It reports that error as one stderr line, rather than node's own stack trace.
