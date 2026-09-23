# question, flow

What `/workstreams:question` does to one sweep report, and every way it declines to act.

```mermaid
flowchart TD
    A[preflight] --> B{anything missing?}
    B -->|Yes| B1([Stop: print each hint verbatim]):::stop
    B -->|No| C{sequencing comment posted?}
    C -->|Yes| C1[Read it: unblocked, next tier,<br/>file map, collisions, shape, sizing,<br/>hidden dependencies]
    C -->|No| C2([Invoke /workstreams:sweep: it continues into<br/>the question phase itself; stop here on return]):::stop
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
    K -->|Yes| L[Plan comment on every issue in the round]

    L --> M{gh plugin present?}
    M -->|Yes| M1[Ask the person to run /gh:sync] --> M2
    M -->|No| M3[Fast-forward the default branch itself] --> M2
    M2[Ask the person about ignored leftovers under plugins/] --> N
    N{a local hook runs a full suite?}
    N -->|No| P[Note any open pull request that shares files]
    N -->|Yes, records say CI is the boundary| O1[Propose core.hooksPath at empty,<br/>human present, restore at close] --> P
    N -->|Yes, records silent| O2([Ask: disable it, per-push cost stated]):::pause --> P

    P --> Q([Report: what was asked, what was ruled,<br/>the two comments, housekeeping])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

The hook question, when the records are silent, is the one case in the whole skill where a
cheap ruling is not taken: disabling a push-time suite changes what protects the round, so
it is asked rather than ruled even though it is, in every other sense, reversible.
