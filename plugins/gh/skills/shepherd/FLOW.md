# /gh:shepherd flow

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

    A1 --> B[List dependencies PRs per repo]
    A4 -->|Yes| B
    B -->|PR has no auto-merge| N([Report it; never enable auto-merge]):::stop
    B -->|--dry-run| Z2([Print each repo's plan, change nothing]):::stop
    B -->|Targets remain| C[One worker per repo, repos in parallel]

    subgraph worker [inside one repo, one PR at a time]
        direction TB
        S[Next PR, lowest merge risk then oldest] --> T{PR state}
        T -->|Already merged or closed| S
        T -->|Behind the base| R[Rebase without a checkout] --> W[Wait one CI cycle]
        T -->|Conflicts, Dependabot branch| RC[Ask Dependabot to recreate]
        RC -->|Head moved| W
        RC -->|Closed, head unmoved: usually superseded by another PR| CS([Closed, terminal]):::stop --> S
        RC -->|Merged, head unmoved| S
        RC -->|Head never moved, comment failed, or PR unreadable| BR([Blocked: recreate did not land]):::stop --> S
        T -->|Conflicts, human branch| E([Needs escalation: a human or larger model decides]):::stop --> S
        T -->|Checks running or already decided| W
        W -->|Merged by auto-merge| S
        W -->|Checks green| P[Settle: read until GitHub decides]
        P -->|Merged| S
        P -->|GitHub named a cause: BLOCKED, or a review decision| BL([Blocked: reason names only what was read]):::stop --> S
        P -->|Bound passed, nothing reported against it| BL
        P -->|Base moved: BEHIND or DIRTY| T
        P -->|Closed while settling| CS
        W -->|Still running| W
        W -->|Still running after three waits, head unchanged| BP([Blocked: checks did not finish]):::stop --> S
        W -->|Checks failed| K{Fix is mechanical?}
        K -->|Yes, first attempt| F[Fix in a throwaway worktree, push] --> W
        K -->|No: touches logic, tests, or config meaning| SK([Skip, comment says why]):::stop --> S
        K -->|Cannot tell, or mechanical but unverifiable locally| E
    end

    C --> D[Collate worker reports]
    D --> V{Blocked, CLEAN or UNKNOWN, auto-merge on?}
    V -->|Yes: one merged read| V2{Merged after all?}
    V2 -->|Yes| V3[Move it to merged] --> Z3
    V2 -->|No| Z3
    V -->|No: GitHub named a cause| Z3([Table per repo; offer escalation; suggest resolve-alerts])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The `discover` subgraph is shared with `/gh:sync`, byte for byte: both skills resolve their
scope by the same rule, `scripts/lib/discover.py`, so the two diagrams must describe it
identically.
