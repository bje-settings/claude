---
type: Reference
description: What the /workstreams:stream skill does in one step, and every way it declines to act.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-10-07
---

# /workstreams:stream skill flow

What `/workstreams:stream` does in one call on one issue or one stack, and every way it declines
to act. Each call takes one step and returns. The caller waits between calls.

```mermaid
flowchart TD
    C{order and model in the plan<br/>comment for every issue in $ARGUMENTS?}
    C -->|No| C1([Stop: say which is missing; never guess a layer's size]):::stop
    C -->|Yes| R{a layer's return in view, not yet read?}

    R -->|Yes| S[Act on each of the five fields:<br/>constraints_checked, brief_vs_code,<br/>outside_set, lower_layer, injected_text_seen]
    S --> S0{a body edit claimed: read-back present<br/>and matching the body?}
    S0 -->|No| S2[Send it back to the layer with SendMessage;<br/>name the heading that differs] --> S3{second missing or mismatched<br/>read-back from this layer?}
    S3 -->|Yes| S4([Stop: name it for the caller]):::stop
    S3 -->|No| X1([End the step; the layer returns again])
    S0 -->|Yes, or no claim| S1([Report: pull request, head, its run, CI state at return,<br/>and the five fields; the review can start at once;<br/>the caller's tick step 2 is next])

    R -->|No| D{worktree for the stream exists?}
    D -->|No| D1[Create it once, from the planned tip;<br/>install from the lock file there] --> E
    D -->|Yes| E[Write this layer's brief from the template into a file,<br/>with the lessons of the review below]
    E --> F{does the repository contradict the brief?}
    F -->|Yes| F1[Correct the brief; the repository wins] --> E
    F -->|No| G{any placeholder left in it?}
    G -->|Yes| G1[Fill it; a placeholder is a layer that will guess] --> E
    G -->|No| H([Dispatch ONE sized agent for this layer, then return;<br/>its return goes to the caller])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```
