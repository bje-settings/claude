---
type: Reference
description: What the /workstreams:sweep skill does, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-04
---

# /workstreams:sweep skill flow

What `/workstreams:sweep` does, and every way it declines to act.

```mermaid
flowchart TD
    C[sweep the tracker]

    C --> D{read complete?}
    D -->|No, unavailable is not empty| D1([Stop: the blocker graph has a hole in it]):::stop
    D -->|Yes| E{open pull requests?}
    E -->|Yes| E1([Name each one first]):::pause
    E -->|No| F
    E1 --> F{anything unblocked?}
    F -->|No| F1([Stop: name the blocked issues]):::stop
    F -->|Yes| G[Read every body and every comment<br/>of the unblocked set only]

    G --> H[Read the Decisions lists in docs/rfc and docs/adr]
    H --> I{a decision no issue body carries?}
    I -->|Yes| I1[Add it to the round, or record it as a blocker]
    I -->|No| FX
    I1 --> FX{a fix issue whose defect no longer happens?}
    FX -->|Yes| FX1[Already fixed: do not schedule, comment the commit] --> S
    FX -->|No| J[Map the files each issue touches]

    J --> K{claim cited to a line just read?}
    K -->|No| K1[Grep for it; a remembered claim is not a claim]
    K1 --> J
    K -->|Yes| L[Classify, size, and estimate the review;<br/>an issue the caller leaves out is deferred, with its round]

    L --> M{touch the same file, region, or CI workflow,<br/>apart from a version line or separate README sections?}
    M -->|No| N[Parallel streams]
    M -->|Yes| O{would one layer reference what the next introduces,<br/>or do both rewrite one section?}
    O -->|Yes| P[One pull request that closes both issues]
    O -->|No| Q{a person would review or merge each layer alone?}
    Q -->|Yes| R[A stack, bottom to top]
    Q -->|No| P

    N --> FO{small issues of one plugin and one kind,<br/>one diff a reviewer reads in one pass?}
    P --> S
    R --> S
    FO -->|Yes| FO1[Fold them into one stream] --> S
    FO -->|No| S[Sequencing comment on every affected issue]
    S --> T{hidden dependencies checked against the code?}
    T -->|No| T1[Check them; the last one stated from bodies alone was wrong]
    T1 --> S
    T -->|Yes| U([Report: unblocked set, shape,<br/>what unlocks, blocked count])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```
