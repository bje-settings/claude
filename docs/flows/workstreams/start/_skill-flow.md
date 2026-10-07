---
type: Reference
description: What the /workstreams:start skill does on each call and each wake, and every way it stops.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-10-04
---

# /workstreams:start skill flow

What `/workstreams:start` does to a round or to one pull request, and every way it stops.

```mermaid
flowchart TD
    A0[Read the argument: milestone, issues, pr, or none;<br/>judge other words, and ask if two readings stay] --> A
    A{argument?} -->|pr n| P1[That pull request is the whole round]
    P1 --> P0{its state: merged or closed?}
    P0 -->|Yes| P0a([Stop: report the state]):::stop
    P0 -->|No| W
    A -->|milestone, issue numbers, or none| B[rounds: the rounds in flight<br/>that hold the scope]
    B --> B0{a fact unread?}
    B0 -->|Yes| B0a([Stop: name it]):::stop
    B0 -->|No| B1{how many rounds?}
    B1 -->|None| C[Invoke /workstreams:sweep with the scope;<br/>with no scope, leave out each round's issues]
    B1 -->|Two or more, with a scope| B1a([Stop: name each round and its issues]):::stop
    B1 -->|One, and an issue in scope in no round| B1b([Stop: name both parts]):::stop
    B1 -->|None, and a closed issue whose round did not end| B1c([Read that round's plan;<br/>do the round end for it, then stop]):::stop
    B1 -->|One or more, with no scope| B3([Ask one question: which round,<br/>or a new round]):::pause
    B3 -->|a new round| C
    B3 -->|a round| E0
    C --> C1{sweep stopped?}
    C1 -->|Yes| C2([Stop: report what sweep returned]):::stop
    C1 -->|No| D[Invoke /workstreams:question;<br/>it checks the issues once more before it posts]
    D --> D1{plan approved in plan mode?}
    D1 -->|No| D2([Stop: no approved plan]):::stop
    D1 -->|Yes| E
    B1 -->|One, with a scope: the round is in flight| E0{the plan read?}
    E0 -->|No| E0a([Stop: name the issue]):::stop
    E0 -->|Yes| E[Derive the round: plan, pull requests,<br/>stack order, review markers and the round 1 head;<br/>a merged pull request is final, with no markers]
    E --> E1{markers a set pr-state takes?}
    E1 -->|No| E2([Stop: name the markers]):::stop
    E1 -->|Yes| R
    F{a layer to write, and no layer below,<br/>or pr-state gives done or merged for it?}
    F -->|Yes| G[Invoke /workstreams:stream for the next layer]
    F -->|No, the layer below closed with no merge| NC
    F -->|No, another state: its tick row acts| W
    G --> W{a wake can come?<br/>an agent at work, or the watch can run}
    W -->|No| W1([Stop: report where the round stands]):::stop
    W -->|Yes, no watch armed yet| W2[Arm the watch with the Monitor tool,<br/>with --heads for each branch the plan names<br/>and each head found; for pr n, its own head,<br/>none from a fork]
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
    T4 -->|The head is not in the watch's --heads| T6[Stop the watch; arm it again<br/>with the head added] --> K
    T4 -->|An undeclared file| T5[Send it back to the layer] --> K
    T4 -->|Yes, or no run: its state acts| K
    T3 -->|No| K{a conflict between two streams?}
    K -->|Yes| K1([Hold that stream; ask one question<br/>with a recommended redirect]):::pause
    K1 --> K2[Record the ruling on this round's issues;<br/>name another round's pull request] --> N
    K -->|No| Q{a decision the plan does not answer?}
    Q -->|No| N{state of each pull request}
    Q -->|a recommended option, cheap to reverse,<br/>no issue, layer or acceptance line added or dropped,<br/>behaviour changed only where a round issue names it| Q1[Ruling: apply it; record it on each issue;<br/>name it in this tick's report] --> N
    Q -->|any other| Q2([Ask one question]):::pause
    Q2 --> Q3[Record the answer on each issue] --> N

    N -->|no-run| N1{second no-run on this head?}
    N1 -->|No| N2[review: close and reopen] --> X
    N1 -->|Yes| S2([Stop]):::stop
    N -->|fixing| NF{a round agent at work on it?}
    NF -->|Yes| X
    NF -->|No, CI pending or a thread open| N3{ten wakes on this state?}
    N3 -->|No| X
    N3 -->|Yes| S3([Stop: name the contexts not reported]):::stop
    NF -->|No, CI red| N4{an agent pushed the head?}
    N4 -->|Yes| NR{red on a file the agent did not touch,<br/>and no re-run yet?}
    NR -->|Yes| NR1[Re-run the failed jobs once] --> X
    NR -->|No| N5[Resume it with SendMessage] --> X
    N4 -->|No agent: a person's pull request| S4([Stop: report red CI]):::stop
    N -->|review-1, review-2, rot-check,<br/>review-1 whatever CI says| N7{an agent at work on it,<br/>the layer agent or a round agent?}
    N7 -->|Yes| X
    N7 -->|No| N6[Switch the clean worktree to the layer's branch;<br/>invoke /workstreams:review] --> X
    N -->|merged| NM[Report it; never a review] --> R
    N -->|closed| NC{a Mid-round ruling on the layer's issues<br/>that answers for it?}
    NC -->|No| NC1([Report it; ask once: drop the layer and those above,<br/>reopen it, or replan]):::pause
    NC1 --> NC2[Record the answer on each issue] --> NC
    NC -->|drop| R
    NC -->|reopen: the person reopens it| X
    NC -->|replan| S5([Stop: the plan changes first]):::stop
    N -->|done| R{every layer done, merged or dropped,<br/>and no layer left?}
    R -->|No| F
    R -->|Yes: report before any question| Z[Round end: stop the watch if one runs; report state and merge sequence,<br/>decisions, old defects, scope changes, other items, cost]
    Z --> Z1{items with an action?}
    Z1 -->|No| Z3
    Z1 -->|Yes| Z2([Ask one question: which parts' actions to accept]):::pause
    Z2 --> Z4[Do each accepted action Claude owns;<br/>give the steps for each the person owns]
    Z4 --> Z3([Post the round-end record on each issue,<br/>with what was done; nothing merges])

    X -->|a return that says it still waits| SS[Stopped short: SendMessage it back] --> X
    X -->|the person explicitly asks to skip<br/>the review of a layer in review-1| SK[Ruling comment on the pull request that quotes it;<br/>round 1 and rot check markers that cite it] --> X
    X -->|any other message from the person in chat| X

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

A layer's return goes to `/workstreams:stream` to read. A round agent's return goes to
`/workstreams:review`, which posts the round's marker. A `lower_layer` finding goes into its layer only in a gap. In a gap, no agent writes to that
layer or above it. Otherwise the finding waits for the round-end report.

A layer agent returns after its push and the run check, with CI still able to run. `pr-state`
gives `review-1` while CI runs, so the tick waits only for that agent's return.

Only `pr-state` marks a layer done. A message from the person in chat changes no state. An
explicit request to skip the review of a layer in `review-1` becomes a ruling comment and
two markers on GitHub. In another state, a request to skip is a question.

A layer that closed with no merge is one question, asked once and recorded on its issues.
A dropped layer lets the round end, as an open item. The round end reports first, then
asks one question, one option for each part of the report that has an action. Its record
on each issue the plan names starts with `<round> end,`. `rounds` leaves out a round with
that record after its plan, and a round with no open issue.

A round is its issue set. Each issue is in the round of its newest plan comment. So two
rounds in one repository, on two issue sets, never act or comment on each other's issues
and pull requests.
