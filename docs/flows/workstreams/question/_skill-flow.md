---
type: Reference
description: What the /workstreams:question skill does, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-04
---

# /workstreams:question skill flow

What `/workstreams:question` does to one sweep report, and every way it declines to act.

```mermaid
flowchart TD
    C{sequencing comment posted?}
    C -->|Yes| C1[Read it: unblocked set, what it unlocks,<br/>file map, collisions, shape, size,<br/>hidden dependencies]
    C -->|No| C2([Stop: say there is no sequencing comment]):::stop
    C1 --> D

    D[Open the file, the record, or the docs an open item names]
    D --> E{answer already in the tree?}
    E -->|Yes| E1[Record it as a ruling, with a citation] --> H
    E -->|No| F{genuinely the human's to decide?}
    F -->|No, cheap to reverse| E1
    F -->|Yes| G[AskUserQuestion: recommendation first, argument against, 2-4 options]
    G --> H{another open item?}
    H -->|Yes| D
    H -->|No| I[Rulings comment on every issue in the round<br/>and any issue a ruling touches]

    I --> J[EnterPlanMode: write the plan]
    J --> K{ExitPlanMode: approved?}
    K -->|No| J
    K -->|Yes| KR{rounds --issues: a round in flight<br/>now holds one of the issues?}
    KR -->|Yes| KR1([Stop: name it; another session planned it first]):::stop
    KR -->|No| L[Plan comment on every issue in the round,<br/>its first line names it the plan,<br/>with a name no round in flight uses]

    L --> M{/gh:sync in own skill listing?}
    M -->|Yes| M1[Ask the person to run /gh:sync] --> M2
    M -->|No| M3[Fast-forward the default branch itself] --> M2
    M2[Remove ignored leftovers under plugins/] --> N
    N{a local hook runs a full suite?}
    N -->|No| P[Note any open pull request that shares files]
    N -->|Yes, records say CI is the boundary| O1[Propose core.hooksPath at empty,<br/>human present, restore at close] --> P
    N -->|Yes, records silent| O2([Ask: disable it, per-push cost stated]):::pause --> P

    P --> Q([Report: what was asked, what was ruled,<br/>the two comments, housekeeping])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

The hook question is the one case in the whole skill where a cheap ruling is not taken,
when the records are silent. If you disable a push-time suite, you change what protects
the round. So this question is asked, not ruled, even though it is, in every other
sense, reversible.
