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
    D --> E[Poll: the repository, the open heads,<br/>and each base's required contexts,<br/>read on its own]
    E --> F{gh on PATH?}
    F -->|No| Z3([One line: nothing to watch, exit 0]):::stop
    F -->|Yes| G{Anything at all read?}
    G -->|No| G1[poll failed, once for each new reason]
    G -->|Yes| G2[poll read again, after a failure]
    G2 --> G3{A base's required contexts<br/>could not be read this poll?}
    G3 -->|Yes| G4[Say so once per reason;<br/>its pull requests go unread]
    G3 -->|No, or read again| G5
    G4 --> G5[For each pull request that left the list:<br/>merged or closed, from its own state]
    G5 --> I{This head's base read<br/>this poll?}
    I -->|No| L
    I -->|Yes| J{Head already seen,<br/>and not the current one?}
    J -->|Yes, API flipped back| L
    J -->|No| K[open, or new head,<br/>then each required context as it reports]
    K --> K2{Every required context reported?<br/>An empty list never is}
    K2 -->|Yes, once per head| K1[CONCLUDED, with each failure]
    K2 -->|No| L
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
they come from the rules of the default branch. Each stack layer above the first is such a case.

Each base reads its required contexts on its own. A base whose read fails leaves unread only the
pull requests that need its list. The other pull requests still read, and can still conclude. A
failed default branch leaves unread every pull request that falls back to it.

A short list still gives the rows that arrived, and `poll incomplete` names the reason once. A
pull request absent from a short list is not reported as closed. A seeded head is not reported as
open, and a head seeded as concluded does not conclude again. A head this watch has already seen
is not a new head, even after a later one: the API can answer an old head for a short time after a
push. The watch keeps all of this in memory, and writes no file. One known limit: a force push
back to an earlier head, between two polls, is not reported.
