---
type: Reference
description: What the /gh:shepherd skill does, and every way it declines to act, given an optional label.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-19
---

# /gh:shepherd skill flow

```mermaid
flowchart TD
    subgraph discover [scope from the working directory]
        direction TB
        A{Inside a git repo?}
        A -->|Yes| A1[That checkout only]
        A -->|No| A2[Each immediate subdir that is a checkout root]
        A2 -.->|Not a repo, or inside one but not its root| A3([Skipped silently]):::stop
        A2 --> A4{Any found?}
        A4 -->|No| A5([Stop: no git repositories directly inside cwd]):::stop
    end

    A1 --> B[List open, non-draft, auto-merge PRs per repo,<br/>narrowed to one label when given]
    A4 -->|Yes| B
    B --> RR{Without --all: do the review rules of its base<br/>leave the PR out?}
    RR -->|Needs an approval, or has unresolved review threads| NR([Not ready: named in the report with its reasons]):::stop
    RR -->|Ready, or --all, or the rules could not be read| B2[Targets]
    B2 -->|--dry-run| Z2([Print each repo's plan and its not-ready list, change nothing]):::stop
    B2 -->|Targets remain| C[One worker per repo, repos in parallel]

    subgraph worker [inside one repo, one PR at a time]
        direction TB
        S[Next PR, lowest merge risk then oldest] --> T{PR state}
        T -->|Already merged or closed| S
        T -->|Auto-merge turned off since selection| SN([Skipped: auto-merge is off]):::stop --> S
        T -->|Without --all: approval missing or threads unresolved| NA([Skipped: needs an approval, or has unresolved review threads]):::stop --> S
        T -->|Head behind the base, no conflict, whatever the merge state| R[Rebase without a checkout,<br/>read until the head moves] --> W[Wait one CI cycle]
        T -->|Conflicts, any author| MG[Merge the base in a worktree, resolve, verify, plain push] --> W
        MG -->|Cannot resolve or verify| E([Skipped: unresolved or unexplained, reason names the files and checks]):::stop --> S
        T -->|Head holds the base tip: checks running or already decided| W
        W -->|Merged by auto-merge| S
        W -->|Base moved: head behind| T
        W -->|Three behind results after a rebase that did not move the head| BH([Skipped: rebase did not move a head that stays behind its base]):::stop --> S
        W -->|Checks green| P[Settle: read until GitHub decides]
        P -->|Merged| S
        P -->|GitHub named a cause: BLOCKED, or a review decision| BL([Skipped: reason names only what was read]):::stop --> S
        P -->|Bound passed, nothing reported against it| BL
        P -->|Base moved: BEHIND or DIRTY| T
        P -->|Closed while settle runs| CS([Closed, terminal]):::stop --> S
        W -->|Still in progress| W
        W -->|Still in progress after three waits, head unchanged| BP([Skipped: checks did not finish]):::stop --> S
        W -->|Checks failed| K{Cause of the failure?}
        K -->|Mechanical, or caused by the base, within the fix cap| F[Fix in a throwaway worktree, plain push] --> W
        K -->|Logic or config check already failing on the PR's own head| SK([Skipped: failed before shepherd]):::stop --> S
        K -->|Cannot explain, or unverifiable locally| E
    end

    C --> D[Collate worker reports]
    D --> V{Skipped, CLEAN or UNKNOWN, auto-merge on,<br/>no cause named?}
    V -->|Yes: one merged read| V2{Merged after all?}
    V2 -->|Yes| V3[Move it to merged] --> Z3
    V2 -->|No| Z3
    V -->|No: a cause was named| Z3([Table per repo; suggest resolve-alerts<br/>when something merged])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The `discover` subgraph is shared with `/gh:sync`, byte for byte. Both skills resolve their
scope by the same rule, `plugins/gh/src/discover.ts`. So the two diagrams must describe it
identically.
