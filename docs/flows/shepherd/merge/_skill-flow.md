---
type: Reference
description: What the /shepherd:merge skill does for auto-merge pull requests and stacks, through the serial loop or the merge queue of the base, and every way it declines to act, given an optional label.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-21
---

# /shepherd:merge skill flow

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
    B --> SR{Each stack: a draft or closed layer, a failed required check,<br/>or without --all a missing approval or unresolved threads,<br/>by the rules of the stack base?}
    SR -->|Yes| NR
    SR -->|No: one target, after the PRs| B2
    B2 -->|--dry-run| Z2([Print each repo's plan and its not-ready list, change nothing]):::stop
    B2 -->|Targets remain| C[One worker per repo, repos in parallel]
    C --> QM{The base of the target in queue mode?<br/>A queue rule, and each required check<br/>from a merge_group workflow}
    QM -->|No, or the queue could not be read| S
    QM -->|Yes| QI

    subgraph queuemode [queue mode, inside one repo]
        direction TB
        QI{Target kind}
        QI -->|A PR| QP1{Conflicts?}
        QP1 -->|Yes| QP2[Merge the base in a worktree, resolve, plain push]
        QP1 -->|No| QP3[GitHub adds it through auto-merge;<br/>no rebase, no CI wait first]
        QP2 --> QP3
        QI -->|A stack| QS1{Shares a file with a target in the queue?}
        QS1 -->|Yes| QS2[Follow that target to its merge or drop first] --> QS1
        QS1 -->|No| QS3[Stack steps, then gh stack merge]
        QP3 --> QF[Follow it in the queue]
        QS3 --> QF
        QF -->|Merged| QFM([Merged, with its time in the queue])
        QF -->|Not added, checks failed| QFF[Fix it through the serial loop] --> QF
        QF -->|Not added for three reads| QFS([Skipped: not added to the queue]):::stop
        QF -->|Not in the queue, and nothing will add it| QFN([Recorded as step 1 says, or skipped]):::stop
        QF -->|Dropped, a first time| QD{Drop class}
        QD -->|merge_conflict| QD1[Merge the base, resolve, wait for CI]
        QD -->|stack_invalidated| QD2[Fix the layer to fix: the oldest drop<br/>of a class other than stack_invalidated]
        QD -->|invalid_merge_commit or other:<br/>same head, CI green| QD3[No fix]
        QD -->|invalid_merge_commit or other:<br/>head moved, or CI not green| QDS([Skipped, with GitHub's words]):::stop
        QD1 --> QR{Shares a file with a target in the queue?}
        QD2 --> QR
        QD3 --> QR
        QR -->|Yes| QR2[Follow that target to its merge or drop first] --> QR
        QR -->|No| QE[Put it in again: enqueue for a PR,<br/>gh stack merge for a stack; never jump] --> QF
        QE -->|GitHub refused the enqueue| QDS
        QF -->|Dropped a second time| QDS
    end

    subgraph worker [inside one repo, one PR at a time]
        direction TB
        S[Next PR, lowest merge risk then oldest] --> T{PR state}
        T -->|Already merged or closed| S
        T -->|Auto-merge turned off since selection| SN([Skipped: auto-merge is off]):::stop --> S
        T -->|Head out of sync with its branch ref| OS([Skipped: head out of sync with its branch, both SHAs named]):::stop --> S
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
        W -->|Still in progress: a check, job or step started or finished| W
        W -->|Stalled: no check, job or step started or finished for the stall bound| BP([Skipped: checks made no progress]):::stop --> S
        S -->|The target is a stack: one unit| SS{Every open layer still ready<br/>by the rules of the stack base,<br/>approval and threads too, even with --all?}
        SS -->|No| SSN([Skipped: the layer and the requirement]):::stop --> S
        SS -->|Yes| SU[Merge the base into each layer behind it,<br/>bottom up; never a force push]
        SU -->|Conflict on a layer| SC[Merge its base in a worktree, resolve, verify, plain push] --> SU
        SC -->|Cannot resolve or verify| E
        SU --> SW[Wait on the checks of every layer]
        SW -->|A layer behind its base| SU
        SW -->|Still in progress| SW
        SW -->|A layer stalled| BP
        SW -->|A layer failed| SF[Fix it as for a PR, within the fix cap] --> SW
        SF -->|Cannot explain or verify| E
        SW -->|Every layer green| SM[gh stack merge: all layers or none]
        SM -->|Merged| S
        SM -->|GitHub refused, or a layer not ready| SSN
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
    V -->|No: a cause was named| Z3([Table per repo, with the queue state and the time<br/>in the queue of each queue target, and each check<br/>that keeps a base with a queue serial;<br/>suggest resolve-alerts when something merged])
    QFM --> D
    QFS --> D
    QFN --> D
    QDS --> D

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The `discover` subgraph is shared with `/gh:sync`, byte for byte. Both skills resolve their
scope by the same rule, `lib/discover.ts`. So the two diagrams must describe it
identically.
