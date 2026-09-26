---
type: Reference
description: What the gh:issues skill does for each operation, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-26
---

# gh:issues skill flow

What `gh:issues` does for each operation, and every way it can decline to act. Claude starts
the skill. It has no slash command.

```mermaid
flowchart TD
    A{Which operation?}
    A -->|Create one| B{Similar issue found?}
    B -->|Yes, and the user agrees| B1([Propose a comment on it under the<br/>owner rule below, create nothing]):::stop
    B -->|No, or the user says it is different| C[Propose title, body, type, labels,<br/>relationships, milestone, priority]
    A -->|Create a batch| BB[Take each duplicate out of the batch,<br/>propose a comment on it under the owner rule]
    BB --> BM[Propose a milestone for<br/>a shared done condition]
    BM --> C
    A -->|Link| L[Propose the relationship change]
    A -->|Triage| T{Any gap: empty field, type label,<br/>dependency in text?}
    T -->|No| T1([Report that every field has a value]):::stop
    T -->|Yes| T2[Propose a value for each gap,<br/>or leave it open and say why]

    C --> O
    T2 --> O
    O{Target owner differs from<br/>an owner of the context?}
    O -->|No| G
    O -->|Yes| OX[Remove the details of each source<br/>with a different owner, add an Omitted line]
    OX --> G
    L --> G
    G{Each value the caller gave exists?}
    G -->|No| G1([Say so and ask, write nothing]):::stop
    G -->|Yes| E{Request already sets every value?}
    E -->|Yes| W
    E -->|No| S{In a subagent?}
    S -->|Yes| S1([Return the proposal to the caller, write nothing]):::stop
    S -->|No| F{User confirms?}
    F -->|No| F1([Stop, write nothing]):::stop
    F -->|Yes| W

    W{Which write?}
    W -->|Create| H[New milestone first, then issues:<br/>parents and blockers first]
    W -->|Link| LW[Edit the relationship fields]
    W -->|Triage| TW[Edit type, labels, milestone,<br/>move text dependencies to fields]

    H --> I{Repository has issue types?}
    I -->|Yes| I1[Set the type, add no label<br/>that says the same thing]
    I -->|No| I2[Use a type label that exists, or none]
    I1 --> J
    I2 --> J
    TW --> J

    J{Owner has a Priority field?}
    J -->|Yes| J1[Set it, read it back]
    J -->|No| J2[Level in the report only]
    J1 --> K
    J2 --> K
    LW --> K
    K([Report from the read-back])

    X[gh refuses a flag] -.-> X1([Stop: gh 2.94 or later needed]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The owner rule applies to each issue and each comment on a duplicate that the skill proposes.
The skill compares the owner of each source with the target owner, by name only. Text for a
different owner names none of the details of that source. The proposal gives the kinds of
detail that it removed.

The skill never creates a label. It prefers an issue type to a label with the same meaning.
An owner with no Priority field is a fact to report, and the skill does not work around it.
