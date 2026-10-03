---
type: Reference
description: What the /workstreams:start skill does on each call and each wake, and every way it stops.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-10-02
---

# /workstreams:start skill flow

What `/workstreams:start` does to a round or to one pull request, and every way it stops.

```mermaid
flowchart TD
    A{argument?} -->|a pull request number| P1[That pull request is the whole round]
    P1 --> P0{its state: merged or closed?}
    P0 -->|Yes| P0a([Stop: report the state]):::stop
    P0 -->|No| W
    A -->|milestone, or none| B{plan comment on an open issue?}
    B -->|No| B1{newest plan on a closed issue,<br/>and no round-end record after it?}
    B1 -->|Yes: its issues closed before the round end| Z
    B1 -->|No plan, or the round already ended| C[Invoke /workstreams:sweep]
    C --> C1{sweep stopped?}
    C1 -->|Yes| C2([Stop: report what sweep returned]):::stop
    C1 -->|No| D[Invoke /workstreams:question]
    D --> D1{plan approved in plan mode?}
    D1 -->|No| D2([Stop: no approved plan]):::stop
    D1 -->|Yes| E
    B -->|Yes| E[Derive the round: plan, pull requests,<br/>stack order, review markers;<br/>a merged pull request is final, with no markers]
    E --> E1{markers a set pr-state takes?}
    E1 -->|No| E2([Stop: name the markers]):::stop
    E1 -->|Yes| R
    F{a layer to write, and no layer below,<br/>or pr-state gives done or merged for it?}
    F -->|Yes| G[Invoke /workstreams:stream for the next layer]
    F -->|No, the layer below closed with no merge| NC
    F -->|No: the tick row for its state acts| W
    G --> W{a wake can come?<br/>an agent at work, or the watch can run}
    W -->|No| W1([Stop: report where the round stands]):::stop
    W -->|Yes, no watch armed yet| W2[Arm the watch with the Monitor tool]
    W2 --> X[End the turn and wait for a wake:<br/>a watch line, an agent's return, or expiry]
    W -->|Yes, a watch already runs,<br/>or it cannot run and an agent works| X

    X -->|expiry| X1[Arm the watch again, with --since-head<br/>and --concluded for every known head] --> X
    X -->|the watch exits| XE{its last line names a cause that can clear,<br/>and no re-arm yet for it?}
    XE -->|Yes: correct the cause| X1
    XE -->|No: the watch cannot run| W
    X -->|a watch line or an agent's return| T[Tick: read each pull request's state, and intersect]
    T --> T1{a fact unread?}
    T1 -->|Yes| T2[Name it; act on nothing that needs it]
    T1 -->|No| T3{new head?}
    T2 --> T3
    T3 -->|Yes| T4{files in the allowed set, lower heads unchanged,<br/>a run for the head, checkouts clean?}
    T4 -->|A lower head moved, or a checkout is dirty| S1([Stop: name it]):::stop
    T4 -->|An undeclared file| T5[Send it back to the layer] --> K
    T4 -->|Yes, or no run: its state acts| K
    T3 -->|No| K{a conflict between two streams?}
    K -->|Yes| K1([Hold that stream; ask one question<br/>with a recommended redirect]):::pause
    K1 --> K2[Record the ruling on both issues] --> N
    K -->|No| Q{a decision the plan does not answer?}
    Q -->|No| N{state of each pull request}
    Q -->|a recommended option, cheap to reverse,<br/>no issue, layer or acceptance line added or dropped,<br/>behaviour changed only where a round issue names it| Q1[Ruling: apply it; record it on each issue;<br/>name it in this tick's report] --> N
    Q -->|any other| Q2([Ask one question]):::pause
    Q2 --> Q3[Record the answer on each issue] --> N

    N -->|no-run| N1{second no-run on this head?}
    N1 -->|No| N2[review: close and reopen] --> X
    N1 -->|Yes| S2([Stop]):::stop
    N -->|ci-pending or fixing| N3{ten wakes on this state,<br/>no agent at work?}
    N3 -->|No| X
    N3 -->|Yes| S3([Stop: name the contexts not reported]):::stop
    N -->|red, or fixing after a round agent<br/>returned red| N4{its agent returned?}
    N4 -->|Yes| NR{red on a file the agent did not touch,<br/>and no re-run yet?}
    NR -->|Yes| NR1[Re-run the failed jobs once] --> X
    NR -->|No| N5[Send it back with SendMessage] --> X
    N4 -->|No agent: a person's pull request| S4([Stop: report red CI]):::stop
    N -->|review-1, review-2, rot-check| N7{a round agent at work on it?}
    N7 -->|Yes| X
    N7 -->|No| N6[Switch the clean worktree to the layer's branch;<br/>invoke /workstreams:review] --> X
    N -->|merged| NM[Report it; never a review] --> R
    N -->|closed| NC{an answer recorded on the layer's issues?}
    NC -->|No| NC1([Report it; ask once: drop the layer and those above,<br/>reopen it, or replan]):::pause
    NC1 --> NC2[Record the answer on each issue] --> NC
    NC -->|drop| R
    NC -->|reopen: the person reopens it| X
    NC -->|replan| S5([Stop: the plan changes first]):::stop
    N -->|done| R{every layer done, merged or dropped,<br/>and no layer left?}
    R -->|No| F
    R -->|Yes, with no question first| Z[Round end: stop the watch; report state and merge sequence,<br/>decisions, old defects, scope changes, other items, cost]
    Z --> Z1{items with an action?}
    Z1 -->|No| Z3
    Z1 -->|Yes| Z2([Ask one question: which parts' actions to accept]):::pause
    Z2 --> Z4[Do each accepted action Claude owns;<br/>give the steps for each the person owns]
    Z4 --> Z3([Post the Round n end record on each issue,<br/>with what was done; nothing merges])

    X -->|a return that says it still waits| SS[Stopped short: SendMessage it back] --> X
    X -->|the person explicitly asks to skip<br/>the review of a layer in review-1| SK[Ruling comment on the pull request that quotes it;<br/>round 1 and rot check markers that cite it] --> X
    X -->|any other message from the person in chat| X

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

A layer's return goes to `/workstreams:stream` to read. A round agent's return goes to
`/workstreams:review`, which posts the round's marker. A `lower_layer` finding goes into its layer only in a gap. In a gap, no agent writes to that
layer or above it. Otherwise the finding waits for the round-end report.

Only `pr-state` marks a layer done. A message from the person in chat changes no state. An
explicit request to skip the review of a layer in `review-1` becomes a ruling comment and
two markers on GitHub. In another state, a request to skip is a question.

A layer that closed with no merge is one question, asked once and recorded on its issues.
A dropped layer lets the round end, as an open item. The round end reports first, then
asks one multi-select question, one option for each part of the report that has an action.
Its record on each issue starts with `<round> end`. A later call that finds that record
starts a new sweep.
