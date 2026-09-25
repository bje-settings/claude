---
type: Reference
description: What the gh:issues skill does for each operation, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# gh:issues skill flow

What `gh:issues` does for each operation, and every way it can decline to act. Claude starts
the skill. It has no slash command.

```mermaid
flowchart TD
    A{Which operation?}
    A -->|Create one or a batch| B{Similar issue found?}
    B -->|Yes, and the user agrees| B1([Propose a comment on it, create nothing]):::stop
    B -->|No, or the user says it is different| C[Propose title, body, type,<br/>relationships, milestone, priority]
    A -->|Link| L[Propose the relationship change]
    A -->|Triage| T{Any field with no value?}
    T -->|No| T1([Report that nothing is missing]):::stop
    T -->|Yes| T2[Propose a value for each gap,<br/>or leave it open and say why]

    C --> D{Batch with one shared done condition?}
    D -->|Yes| D1[Propose a new milestone]
    D -->|No| G
    D1 --> G
    L --> G
    T2 --> G

    G{Each value the caller gave exists?}
    G -->|No| G1([Say so and ask, write nothing]):::stop
    G -->|Yes| E

    E{Request already set every field?}
    E -->|No| F{User confirms?}
    F -->|No| F1([Stop, write nothing]):::stop
    F -->|Yes| H
    E -->|Yes| H

    H[Write: milestone first,<br/>then issues in dependency order]

    H --> I{Repository has issue types?}
    I -->|Yes| I1[Set the type, add no label<br/>that says the same thing]
    I -->|No| I2[Use a type label that exists, or none]
    I1 --> J
    I2 --> J

    J{Owner has a Priority field?}
    J -->|Yes| J1[Set it, read it back]
    J -->|No| J2[Level in the report only]
    J1 --> K
    J2 --> K
    K([Report number, milestone, type,<br/>priority, relationships from read-back])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The skill never creates a label, and prefers an issue type to a label with the same meaning. A repository with no issue types, or an owner with no
Priority field, is a fact to report. The skill does not work around it.
