# review, flow

What `/workstreams:review` does to one pull request, and every way it declines to act.

```mermaid
flowchart TD
    A[preflight] --> B{anything missing?}
    B -->|Yes| B1([Stop: print each hint verbatim]):::stop
    B -->|No| C[read the pull request's state]

    C --> D{could every fact be read?}
    D -->|No, no state at all| D1([Stop: say which fact nobody could see]):::stop
    D -->|Yes| E{which state?}

    E -->|awaiting-pr| E1([Stop: nothing answered for this number]):::stop
    E -->|no-run| F{already reopened once?}
    F -->|No| F1[Close and reopen the pull request] --> C
    F -->|Yes| F2([Stop: a head with no run twice is not a wait]):::stop
    E -->|red, before any round| G([Stop: red CI belongs to whoever opened it]):::stop
    E -->|ci-pending or fixing| H[Wait: the hint, or 60s, capped at 30 min] --> C

    E -->|review-1 or review-2| I[One round agent in the worktree]
    I --> J[Reviewers, read-only, no suites, all finish first]
    J --> K[Findings file written before any edit]
    K --> L{finding AND rejection each cited to a line?}
    L -->|No| L1[Reject it, or cite it] --> K
    L -->|Yes| M{claims something is tested?}
    M -->|Yes| M1[Mutate first: watch it go red] --> N
    M -->|No| N[Commit, apply, re-read own hunks, push]
    N --> O{a run for the new head?}
    O -->|No| O1[Close and reopen] --> O
    O -->|Yes| P[Watch CI in the foreground] --> C

    E -->|rot-check| Q[Title and body against the final diff]
    Q --> R{round 1 substantial and round 2 not run?}
    R -->|Yes| I
    R -->|No| S([Report: state, applied, rejected,<br/>corrections, lower_layer])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The stops are different facts and are reported as different facts. A preflight failure
is a machine that cannot run the round. No state at all is a fact nobody could read, and
acting on it would send a round to review checks it has not seen. Red CI before any
round has run is someone else's problem, because nothing this skill did caused it.

Every loop back goes through the state read, never through a memory of it: there is no
state file, and the only things carried between ticks are how many rounds have completed,
whether round 1 was substantial, and whether the rot check is done.
