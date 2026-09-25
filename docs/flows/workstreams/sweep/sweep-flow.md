---
type: Reference
description: How `workstreams.ts sweep` reads the tracker, puts each open issue in a tier, and when its report is short or empty.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# sweep flow

`node scripts/workstreams.ts sweep` reports what a round could start on, read from the issue
tracker. The `/workstreams:sweep` skill runs it.

```mermaid
flowchart TD
    A[sweep run] --> B{Flags known, and no positional?<br/>only --milestone, --json, --help}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help| H([Print usage, exit 0])
    B -->|Yes| C{--milestone given twice?}
    C -->|Yes| Z1
    C -->|No| D{Each milestone a<br/>positive whole number?}
    D -->|No| Z1
    D -->|Yes| E[Read open milestones, open pull requests,<br/>and every open issue]
    E --> F{--milestone given?}
    F -->|Yes| G[Sweep those milestones]
    F -->|No| I[Sweep every open milestone, and<br/>each milestone an issue names]
    G --> J[Read the issues of each milestone swept]
    I --> J
    J --> K{Nothing read at all,<br/>and a read fell short?}
    K -->|Yes| Z2([failed: the sweep read nothing, exit 1]):::stop
    K -->|No| L{Open blockers of the issue?}
    L -->|None| T1[unblocked]
    L -->|One, and that blocker is unblocked| T2[next tier]
    L -->|Any other case| T3[blocked, open blockers named]
    T1 --> N[Group by milestone swept,<br/>plus the issues on no milestone]
    T2 --> N
    T3 --> N
    N --> O{Did any read fall short?}
    O -->|Yes| P([Report marked INCOMPLETE, or JSON with<br/>the reasons in unavailable, exit 0]):::stop
    O -->|No| Q([Report: milestones, pull requests,<br/>groups and combined sets, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A read that partly failed is still an answer, with exit 0. The caller reads the reasons first. An
issue on a milestone outside the sweep gets a tier but appears in no group. An open blocker that
the sweep did not read cannot make an issue `next tier`. `--json` prints the same report as one
JSON object.
