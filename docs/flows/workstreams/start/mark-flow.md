---
type: Reference
description: How `workstreams.ts mark` checks its arguments, finds the head, and writes one `workstreams/<name>` commit status, and each way it stops.
stale_after: 2027-04-13
generated:
  by: claude-opus
  at: 2026-10-13
---

# mark flow

`node scripts/workstreams.ts mark` records one finished step of the review loop as a commit
status. `/workstreams:review` runs it after each round and after the rot check.
`/workstreams:start` runs it when the person asks to skip the review of a layer.

```mermaid
flowchart TD
    A[mark run] --> B{Flags known?}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{A pull request number and one name:<br/>review-1, review-2, rot-check or layer?}
    C -->|No| Z1
    C -->|Yes| D{Description of 140 characters<br/>or fewer?}
    D -->|No| Z1
    D -->|Yes| E{--head given?}
    E -->|Yes| E1{A full 40-character sha?}
    E1 -->|No| Z1
    E1 -->|Yes| W
    E -->|No| F[Read the pull request]
    F --> G{GitHub says the number<br/>does not exist?}
    G -->|Yes| Z1
    G -->|No| G1{Pull request read?}
    G1 -->|No| Z2([failed: could not read it, exit 1]):::stop
    G1 -->|Yes, its head| W[Write workstreams/name, state success,<br/>with the description, on that commit]
    W --> X{Write succeeded?}
    X -->|No| Z3([failed: gh's own words, exit 1]):::stop
    X -->|Yes| OK([Name the status and its commit, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

Every refusal comes before any read, except the pull request that does not exist. A list on the
pull request that ran past one page does not stop the write, because the head is still read.

A status cannot be deleted. A later push leaves it on an older commit of the pull request, where
`pr-state` still reads it. `pr-state` reads `review-1`, `review-2` and `rot-check`. Nothing
reads `layer` yet (#396).
