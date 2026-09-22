# context: flow

What `/audit:context` does, and every way it can decline to act or come back incomplete.

```mermaid
flowchart TD
    A[/audit:context run/] --> B{One root, whole-number<br/>counts, 0-1 threshold?}
    B -->|No| Z1([Refused: bad argument, exit 2]):::stop
    B -->|Yes| C{--out given and<br/>cannot be opened?}
    C -->|Yes| Z2([Refused: --out unwritable, exit 2]):::stop
    C -->|No| D{Root inside a git checkout?}
    D -->|No, git missing| Z3([Refused: missing git, exit 2]):::stop
    D -->|No, git present| Z4([Refused: not a git repository, exit 2]):::stop
    D -->|Yes| E[Tier 0: extract and resolve every ref,<br/>one batched issue lookup]

    E --> F{TYPESAFE_API_KEY set<br/>and no --no-jev?}
    F -->|No| G[classify, pairs, evidence:<br/>skipped, no_key or no_jev]
    F -->|Yes| H[classify stage runs]
    H --> I{Any unit classified?}
    I -->|No| J[pairs, evidence:<br/>skipped, classify_failed]
    I -->|Yes| K[pairs and evidence stages run]

    G --> L[Findings printed]
    J --> L
    K --> L
    L --> M{Any model call failed?}
    M -->|Yes| N([failed: n model calls failed, exit 1]):::stop
    M -->|No| O([ok, exit 0]):::stop
    N --> P[Triage: absent refs, then expired<br/>volatile units, then duplicate pairs by<br/>confidence, evidence contradictions last]
    O --> P

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A stage marked skipped is never read as "nothing found": the report says which reason applied,
and a reviewer acts on tier 0's findings the same way whether or not the model stages ran.
