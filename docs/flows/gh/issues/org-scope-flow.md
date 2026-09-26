---
type: Reference
description: How `gh.ts org-scope` finds whether each source owner shares an enterprise with a target owner, and why each doubt reads as outside.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# org-scope flow

`node scripts/gh.ts org-scope --target <owner> <source-owner>...` prints one JSON document with
the scope of each source owner. The `gh:issues` skill runs it before it files an issue in the
repository of a different owner.

```mermaid
flowchart TD
    A[org-scope run] --> B{Arguments parse?}
    B -->|No: unknown flag, or --target with no value| Z1([Refused: reason and usage, exit 2]):::stop
    B -->|Yes| C{--help or -h?}
    C -->|Yes| H([Print help, exit 0])
    C -->|No| D{--target given and not empty?}
    D -->|No| Z1
    D -->|Yes| E{At least one source,<br/>and none empty?}
    E -->|No| Z1
    E -->|Yes| F{Any source that is not<br/>the target, case ignored?}
    F -->|No| R
    F -->|Yes| G[Read the enterprises<br/>the gh account can see]
    G --> I{List read whole?}
    I -->|No: gh failed, errors, unreadable row,<br/>too many pages or organizations| W[Reason on stderr]
    I -->|Yes| R
    W --> R
    R[Each source, in the order given] --> S{Same owner as the target?}
    S -->|Yes| S1[same-owner]
    S -->|No| T{List read whole?}
    T -->|No| T1[unknown]:::stop
    T -->|Yes| U{One enterprise lists<br/>both owners?}
    U -->|Yes| U1[same-enterprise, with its slug]
    U -->|No: user account, other enterprise,<br/>or no enterprise seen| U2[outside]:::stop
    S1 --> O
    T1 --> O
    U1 --> O
    U2 --> O
    O([Print the JSON document, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The command fails closed. A wrong `same-enterprise` puts private details in the edit history of
another owner's issue. A wrong `outside` only removes detail from the issue text. So the skill
reads `unknown` as `outside`. A source with the same owner as the target never needs `gh`.
