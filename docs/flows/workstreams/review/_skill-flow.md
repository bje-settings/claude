---
type: Reference
description: What the /workstreams:review skill does in one step, and every way it declines to act.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-09-27
---

# /workstreams:review skill flow

What `/workstreams:review` does in one call on one pull request, and every way it declines to
act. Each call takes one step and returns. The caller waits between calls.

```mermaid
flowchart TD
    W{exactly one worktree matches the head<br/>branch, and a model is named?}
    W -->|No| W1([Stop: say which is absent; never guess]):::stop
    W -->|Yes| C[Read the pull request's state once]

    C --> D{could every fact be read?}
    D -->|No, no state at all| D1([Return: say which fact nobody could see]):::stop
    D -->|Yes| E{which state?}

    E -->|awaiting-pr| E1([Return: GitHub said this number does not exist]):::stop
    E -->|no-run| F([Close and reopen the pull request, then return])
    E -->|ci-pending| G([Return the state])
    E -->|red| G1([Return: name the contexts that failed]):::stop
    E -->|fixing| G2([Return: name each open bot thread apart])

    E -->|review-1 or review-2| I[Brief from the round template;<br/>round 2 adds its own rules]
    I --> J[Reviewers from what the diff changes]
    J --> K([Dispatch one round agent, then return;<br/>its return goes to the caller])

    E -->|rot-check| Q([Title and body against the final diff,<br/>then return])
    E -->|done| S([Report: state, applied, rejected,<br/>corrections, lower_layer, open bot threads])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

Inside the round agent, the rules of the round brief hold: reviewers are read-only and finish
first, the findings file comes before any edit, each finding and each rejection is cited, and a
claim that something is tested is mutated first. Round 2 checks round 1's commits before
anything else.
