# sweep, flow

What `/workstreams:sweep` does, and every way it declines to act.

```mermaid
flowchart TD
    A[preflight] --> B{anything missing?}
    B -->|Yes| B1([Stop: print each hint verbatim]):::stop
    B -->|No| C[sweep the tracker]

    C --> D{read complete?}
    D -->|No, unavailable is not empty| D1([Stop: the blocker graph has a hole in it]):::stop
    D -->|Yes| E{open pull requests?}
    E -->|Yes| E1([Name each one and whose it is, before going on]):::pause
    E -->|No| F
    E1 --> F{anything unblocked?}
    F -->|No| F1([Stop: say what the next tier is waiting on]):::stop
    F -->|Yes| G[Read every body and every comment]

    G --> H[Read the Decisions lists in docs/rfc and docs/adr]
    H --> I{a decision no issue body carries?}
    I -->|Yes| I1[Add it to the round, or record it as a blocker]
    I -->|No| J
    I1 --> J[Map the files each issue touches]

    J --> K{claim cited to a line just read?}
    K -->|No| K1[Grep for it; a remembered claim is not a claim]
    K1 --> J
    K -->|Yes| L[Classify, size, and estimate the review]

    L --> M{touch the same file, region, or CI workflow?}
    M -->|No| N[Parallel streams]
    M -->|Yes| O{would one layer reference what the next introduces?}
    O -->|Yes| P[One pull request closing both issues]
    O -->|No| Q{each layer has independent review or merge value?}
    Q -->|Yes| R[A stack, bottom to top]
    Q -->|No| P

    N --> S[Sequencing comment on every affected issue]
    P --> S
    R --> S
    S --> T{hidden dependencies checked against the code?}
    T -->|No| T1[Check them; the last one stated from bodies alone was wrong]
    T1 --> S
    T -->|Yes| U([Report: unblocked set, shape, what it unlocks,<br/>what nothing can reach yet])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

The three stops are different facts and are reported as different facts. A preflight
failure is a machine that cannot run the round; an incomplete read is a question that
could not be answered; an empty unblocked set is an answer, and the useful half of it is
what the next tier is waiting on.
