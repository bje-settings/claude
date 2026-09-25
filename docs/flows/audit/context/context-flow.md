---
type: Reference
description: How `audit.ts context` checks its arguments and checkout, runs tier 0 and the model stages, and which outcome sets its exit status.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# context flow

`node scripts/audit.ts context` reports the references in a checkout's context files that no
longer resolve. The `/audit:context` skill runs it.

```mermaid
flowchart TD
    A[context run] --> B{-h or --help anywhere?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{Flags known, choices valid, one root at most,<br/>whole-number counts, 0-1 threshold?}
    C -->|No| Z1([Refused: bad argument, exit 2]):::stop
    C -->|Yes| E{--out given and cannot be opened?}
    E -->|Yes| Z2([Refused: --out unwritable, exit 2]):::stop
    E -->|No| F{Root inside a git checkout?}
    F -->|No, git cannot run| Z3([Refused: missing git, exit 2]):::stop
    F -->|No, git runs| Z4([Refused: not a git repository, exit 2]):::stop
    F -->|Yes| G{Tracked files listable?}
    G -->|No| Z5([Refused: cannot list tracked files, exit 2]):::stop
    G -->|Yes| I[Pick tracked Markdown: context files,<br/>or every .md with --scope all]
    I --> J{Every file picked readable?}
    J -->|No| Z6([Refused: a tracked file<br/>cannot be read, exit 2]):::stop
    J -->|Yes| K[Split each file into units and opaque blocks]

    subgraph tier0 [tier 0: no model]
        direction TB
        L[Extract the refs of every block] --> L1{Issue numbers cited, and the<br/>one batched lookup failed?}
        L1 -->|Yes| L2[Those issue refs read as unavailable;<br/>the reason goes in the report]
        L1 -->|No| L3
        L2 --> L3[Resolve paths, lines, packages, issues]
        L3 --> L4{Ignore check failed?}
        L4 -->|Yes| L5[The reason goes in the report]
    end

    subgraph model [model stages]
        direction TB
        M{TYPESAFE_API_KEY set<br/>and no --no-jev?}
        M -->|No| M1[All three stages skipped: no_key or no_jev]
        M -->|Yes| M2[Classify every unit]
        M2 --> M3{Had units, but none<br/>came back labelled?}
        M3 -->|Yes| M4[pairs, evidence skipped: classify_failed;<br/>at least one failure recorded]
        M3 -->|No| M5[Pairs: similar units over the threshold, history<br/>and structural units left out, top --max-pairs]
        M5 --> M6[Evidence: repo facts that cite a found file<br/>inside the root, first --max-evidence]
    end

    K --> L
    L4 -->|No| M
    L5 --> M
    M1 --> N[Print findings, or the JSON report with --json;<br/>also write JSON to --out when given]
    M4 --> N
    M6 --> N
    N --> O{Any model call failed?}
    O -->|Yes| P([failed: n model calls failed, exit 1])
    O -->|No| Q([ok, exit 0])
    X[Any error it did not expect] --> Z7([audit: the message, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

An issue lookup or ignore check that fails does not stop the run. The report states the reason,
and the exit status does not change. A `classify_failed` run always exits 1, because that
branch always records at least one failure.
