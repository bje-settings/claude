---
type: Reference
description: How `workstreams.ts rounds` finds the rounds in flight from their plan comments, scopes them, and when its answer is short.
stale_after: 2027-04-04
generated:
  by: claude-opus
  at: 2026-10-04
---

# rounds flow

`node scripts/workstreams.ts rounds` names the rounds in flight, each with its plan line and its
issues. The `/workstreams:start` skill runs it to find the round it continues.

```mermaid
flowchart TD
    A[rounds run] --> B{Flags known, and no positional?<br/>only --issues, --milestone, --json, --help and -h}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{A flag given twice, a number not a<br/>positive whole number, or both scopes?}
    C -->|Yes| Z1
    C -->|No| D[Search the issues, open and closed,<br/>with a plan, approved comment]
    D --> E{Nothing read, and the read fell short?}
    E -->|Yes| Z2([failed: the rounds read nothing, exit 1]):::stop
    E -->|No| F[Each issue: the round of its newest plan line]
    F --> G{An end record for that round<br/>after the plan, on any issue of it?}
    G -->|Yes| G1[Leave the round out: it ended]
    G -->|No| I[Group the issues by the whole plan line]
    I --> J{--issues or --milestone given?}
    J -->|Yes| K[Keep the rounds that hold one of the issues,<br/>or an issue on the milestone]
    J -->|No| L[Keep every round in flight]
    K --> M{An issue with more comments than were read,<br/>or a read that fell short?}
    L --> M
    M -->|Yes| N([Report with the reasons in unavailable, exit 0]):::stop
    M -->|No| O([Report: each round in flight, newest plan first, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

An issue is in one round only: the round of its newest plan comment. So a lookup by the issues of
one round never reaches another round. The search can take a minute to see a new comment.
