---
type: Reference
description: What the /workstreams:review skill does in one step, and every way it declines to act.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-10-13
---

# /workstreams:review skill flow

What `/workstreams:review` does in one call on one pull request, and every way it declines to
act. Each call takes one step and returns. The caller waits between calls.

```mermaid
flowchart TD
    R0{called with a round agent's JSON return?}
    R0 -->|Yes| RS[Check substantial against the round's own diff,<br/>in the pull request's worktree: only changed logic<br/>under src, lib, scripts or hooks counts; the diff decides]
    RS --> R2{record the round's status on the round's head<br/>with mark: written?}
    R2 -->|Yes| CM[Post the round comment for people:<br/>summary, then findings in a collapsed block;<br/>a failed post is reported, not a stop]
    CM --> BT{reply on each bot thread the round settled,<br/>then resolve it: each call worked?}
    R2 -->|No| R3([Stop: say so]):::stop
    BT -->|Yes| R1([Return])
    BT -->|No| BT1([Stop: name the thread]):::stop
    R0 -->|No| W{exactly one worktree matches the head branch?}
    W -->|No| W1([Stop: say which is absent; never guess]):::stop
    W -->|Yes| C[Read the pull request's state once;<br/>pr-state reads the review statuses,<br/>and a flag from the caller wins]

    C --> D{could every fact be read?}
    D -->|No, no state at all| D1([Return: say which fact nobody could see]):::stop
    D -->|Yes| E{which state?}

    E -->|awaiting-pr| E1([Return: GitHub said this number does not exist]):::stop
    E -->|merged or closed| E1b([Return: the pull request already finished]):::stop
    E -->|no-run| F([Close and reopen the pull request, then return])
    E -->|fixing| G2([Return: name the contexts that failed; settle each<br/>mermaid preview thread no round settled; name each other<br/>bot thread for the person, and stop])

    E -->|review-1, and layerReturned false| EL([Return: the layer agent has not returned;<br/>dispatch no round]):::stop
    E -->|review-1 with the layer returned,<br/>any CI verdict, or review-2| M{the plan or the caller names a review model?}
    M -->|Yes| I
    M -->|No, never a question| M1[Choose one: opus for round 2, logic,<br/>or new behaviour at the top of a stream;<br/>sonnet for any other round 1] --> I
    I[Brief from the round template;<br/>round 2 adds its own rules and round 1's findings,<br/>from the return the caller passes]
    I --> J[Reviewers from what the diff changes]
    J --> K([Dispatch one round agent, then return with the model and the reason;<br/>its return goes to the caller])

    E -->|rot-check| Q([Title and body against the final diff;<br/>record the rot-check status, post the rot check comment,<br/>then return])
    E -->|done| S([Report: state, applied, rejected,<br/>corrections, lower_layer, bot threads settled])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The round brief holds the rules inside the round agent. Reviewers are read-only, and finish
before any edit. The findings list comes before any edit, and goes in the return. Each
finding and each rejection is cited. A claim that something is tested is mutated first.
Round 2 checks round 1's commits before anything else. The round agent does not end its
turn, or return, while a reviewer it dispatched still runs. Then it reads CI and the unresolved
threads once, and fixes them with the findings in one pass. Each bot thread is a finding too. A
mermaid preview thread is rejected as informational. The return lists each bot thread in
`bot_threads`. It returns after the push and the run
check, and does not watch CI.
