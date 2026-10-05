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
open issues. The `/workstreams:start` skill runs it to find the round it continues, and
`/workstreams:question` runs it once more before it posts a plan.

```mermaid
flowchart TD
    A[rounds run] --> B{Flags known, and no positional?<br/>only --issues, --milestone, --json, --help and -h}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{A flag given twice, a number not a<br/>positive whole number, or both scopes?}
    C -->|Yes| Z1
    C -->|No| D[Search the open issues with a<br/>plan, approved comment, newest update first]
    D --> D1{--issues given?}
    D1 -->|Yes| D2[Read those issues directly;<br/>that read wins over the search]
    D1 -->|No| E
    D2 --> E{Nothing read, and a read fell short?}
    E -->|Yes| Z2([failed: the rounds read nothing, exit 1]):::stop
    E -->|No| U[In the scope: name each issue with a plan line that<br/>does not parse, or with no plan in its 100 newest comments]
    U --> F[Each open issue: the round of its newest plan line]
    F --> I[Group the issues by the whole plan line]
    I --> G{An end record for the round after its plan,<br/>on any open issue of it?}
    G -->|Yes| G1[Leave the round out: it ended] --> J
    G -->|No| J{--issues or --milestone given?}
    J -->|Yes| K[Keep the rounds with an issue in the scope;<br/>with --issues, name each open issue in no round]
    J -->|No| L[Keep every round in flight]
    K --> M{A reason the answer is short?}
    L --> M
    M -->|Yes| N([Report with the reasons in unavailable, exit 0]):::stop
    M -->|No| O([Report: each round in flight, newest plan first, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

An issue is in one round only: the round of its newest plan comment. So a lookup by the issues of
one round never reaches another round. A round with no open issue is not in flight, so the rounds
that ended before #368 added the end record do not come back. The search can take a minute to see
a new comment. A direct read by issue number sees it at once.
