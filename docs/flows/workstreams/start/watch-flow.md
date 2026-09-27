---
type: Reference
description: How `workstreams.ts watch` polls each open pull request and writes one line for each event, and each way it stops or goes quiet.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-09-27
---

# watch flow

`node scripts/workstreams.ts watch` polls each open pull request, and writes one line for each
event. The plugin monitor runs it when `/workstreams:start` first runs in a session. The skill
runs it under the Monitor tool when the plugin monitor does not run.

```mermaid
flowchart TD
    A[watch run] --> B{Flags known, each value a whole number,<br/>each seed a number and a full sha,<br/>no seed flag given twice?}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{Inside a git checkout?}
    C -->|No| Z2([One line: nothing to watch, exit 0]):::stop
    C -->|Yes| D[Remember the seeded heads:<br/>known, and concluded]
    D --> E[Poll: the repository, the open heads,<br/>and the required contexts of each base]
    E --> F{gh on PATH?}
    F -->|No| Z3([One line: nothing to watch, exit 0]):::stop
    F -->|Yes| G{Poll read?}
    G -->|No| G1[poll failed, once for each new reason]
    G -->|Yes| G2[poll read again, after a failure]
    G2 --> I[For each pull request that left the list:<br/>merged or closed, from its own state]
    I --> J[For each open head: open, or new head,<br/>then each required context as it reports]
    J --> K{Every required context reported?<br/>An empty list never is}
    K -->|Yes, once per head| K1[CONCLUDED, with each failure]
    K -->|No| L
    K1 --> L
    G1 --> L{Any line this poll?}
    L -->|Yes| M[Write each line]
    L -->|No, ten quiet minutes| N[heartbeat: the failure, or no change]
    L -->|No| O
    M --> O
    N --> O{Stopped, reader closed,<br/>or --ticks polls done?}
    O -->|No| P[Sleep --interval seconds] --> E
    O -->|Yes| Z4([Exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The required contexts come from the rules of the base branch. When no ruleset covers the base,
as for each stack layer above the first, they come from the rules of the default branch. A
short list still gives the rows that arrived: `poll incomplete` names the reason once, and a pull
request absent from a short list is not reported as closed. A seeded head is not reported as
open, and a head seeded as concluded does not conclude again. The watch keeps all of this in
memory, and writes no file.
