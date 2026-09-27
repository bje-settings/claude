---
type: Reference
description: What the /workstreams:start skill does on each call and each wake, and every way it stops.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-09-27
---

# /workstreams:start skill flow

What `/workstreams:start` does to a round or to one pull request, and every way it stops.

```mermaid
flowchart TD
    A{argument?} -->|a pull request number| P1[That pull request is the whole round]
    A -->|milestone, or none| B{plan comment on the round's issues?}
    B -->|No| C[Invoke /workstreams:sweep]
    C --> C1{sweep stopped?}
    C1 -->|Yes| C2([Stop: report what sweep returned]):::stop
    C1 -->|No| D[Invoke /workstreams:question]
    D --> D1{plan approved in plan mode?}
    D1 -->|No| D2([Stop: no approved plan]):::stop
    D1 -->|Yes| E
    B -->|Yes| E[Derive the round: plan, pull requests,<br/>stack order, review markers]
    E --> F{a layer to write, and the layer below done?}
    P1 --> W
    F -->|Yes| G[Invoke /workstreams:stream for the next layer]
    F -->|No| W
    G --> W{a wake can come?<br/>an agent at work, or a monitor}
    W -->|No| W1([Stop: report where the round stands]):::stop
    W -->|Yes| X[End the turn and wait for a wake:<br/>a watch line, or an agent's return]

    X --> T[Tick: read each pull request's state, and intersect]
    T --> T1{a fact unread?}
    T1 -->|Yes| T2[Name it; act on nothing that needs it]
    T1 -->|No| T3{new head?}
    T2 --> T3
    T3 -->|Yes| T4{files in the allowed set, lower heads unchanged,<br/>root checkout clean?}
    T4 -->|A lower head moved, or the root is dirty| S1([Stop: name it]):::stop
    T4 -->|An undeclared file| T5[Send it back to the layer] --> K
    T4 -->|Yes| K
    T3 -->|No| K{a conflict between two streams?}
    K -->|Yes| K1([Hold that stream; ask one question<br/>with a recommended redirect]):::pause
    K1 --> K2[Record the ruling on both issues] --> N
    K -->|No| N{state of each pull request}

    N -->|no-run| N1{second no-run on this head?}
    N1 -->|No| N2[review: close and reopen] --> X
    N1 -->|Yes| S2([Stop]):::stop
    N -->|ci-pending or fixing| N3{ten wakes on this state,<br/>no agent at work?}
    N3 -->|No| X
    N3 -->|Yes| S3([Stop: name the contexts not reported]):::stop
    N -->|red| N4{its agent returned?}
    N4 -->|Yes| N5[Send it back with SendMessage] --> X
    N4 -->|No agent: a person's pull request| S4([Stop: report red CI]):::stop
    N -->|review-1, review-2, rot-check| N6[Switch the worktree to the layer's branch;<br/>invoke /workstreams:review] --> X
    N -->|done| R{every pull request done,<br/>and no layer left?}
    R -->|No| F
    R -->|Yes| Z([Round end: merge sequence and cost<br/>on each issue; nothing merges])

    X -->|a return that says it still waits| SS[Stopped short: SendMessage it back] --> X

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

A layer's return goes to `/workstreams:stream` to read. A round agent's return goes to
`/workstreams:review`, which posts the round's marker. A `lower_layer` finding goes into its layer only in a gap. In a gap, no agent writes to that
layer or above it. Otherwise the finding waits for the round-end report.
