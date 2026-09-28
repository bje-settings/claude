---
type: Reference
description: How `workstreams.ts pr-state` reads one pull request and its checks into a verdict and a review-loop state, and each way it stops.
stale_after: 2027-03-25
generated:
  by: claude-sonnet
  at: 2026-09-27
---

# pr-state flow

`node scripts/workstreams.ts pr-state` reports where the review loop is on one pull request. The
`/workstreams:review` and `/workstreams:start` skills run it.

```mermaid
flowchart TD
    A[pr-state run] --> B{Flags known, --round 0, 1 or 2?}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{Exactly one positive<br/>pull request number?}
    C -->|No| Z1
    C -->|Yes| D{--substantial or --rot-checked<br/>with round 0?}
    D -->|Yes| Z1
    D -->|No| E[Read the pull request; if read, the base branch's<br/>required contexts and the head branch's runs]
    E --> F[Read recent runs for a wait hint]
    F --> G{Pull request unread, not<br/>NOT_FOUND, and recent runs<br/>also unread?}
    G -->|Yes| Z2([failed: read nothing, exit 1]):::stop
    G -->|No| I{Pull request read?}
    I -->|No| N{GitHub named this<br/>number NOT_FOUND?}
    N -->|Yes| S0([state awaiting-pr,<br/>verdict unavailable, exit 0])
    N -->|No| S0b([no state,<br/>verdict unavailable, exit 0]):::stop
    I -->|Yes| P{Pull request's own state?}
    P -->|MERGED| Sm([state merged, exit 0])
    P -->|CLOSED| Sc([state closed, exit 0])
    P -->|OPEN| J{Every pull request field, rule<br/>and head run read?}
    J -->|No| S1([verdict unavailable, no state,<br/>reasons listed, exit 0]):::stop
    J -->|Yes| K{A pull_request run<br/>for the head commit?}
    K -->|No| S2([state no-run, exit 0])
    K -->|Yes| L[Contexts: the ruleset's list, or the<br/>checks on the head when no ruleset names any]
    L --> V[Verdict: red if one failed; pending if one has not<br/>concluded, or the list is empty or not settled; else green]
    V --> Q{Review rounds completed?}
    Q -->|0| Q0{Verdict?}
    Q0 -->|red| T1([state red, exit 0])
    Q0 -->|pending| T2([state ci-pending, exit 0])
    Q0 -->|green| T3([state review-1, exit 0])
    Q -->|1 or 2| Q1{Green, and no unresolved<br/>thread from a person?}
    Q1 -->|No| T4([state fixing, exit 0])
    Q1 -->|Yes, a bot's own thread<br/>may still be unresolved| Q2{Round 1, and --substantial?}
    Q2 -->|Yes| T5([state review-2, exit 0])
    Q2 -->|No| Q3{--rot-checked?}
    Q3 -->|No| T6([state rot-check, exit 0])
    Q3 -->|Yes| T7([state done, exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

SUCCESS, SKIPPED and NEUTRAL each satisfy a context, and any other conclusion fails it. A
contexts list from the head is settled only when every run for the head has completed. A failed
wait-hint read adds a reason to the list but does not change the verdict. An unresolved thread
from a person blocks `done`.

A bot's own thread, a review bot such as Copilot included, is named apart. It does not block
`done`, and neither does a plain comment (#219). A review bot's own finding is named, but the
loop does not wait on it.

State `awaiting-pr` means GitHub itself named the number NOT_FOUND. Every other reason leaves no
state at all. A malformed reply is one such reason. A repository gh could not resolve is
another. A read gh refused outright is a third. A NOT_FOUND for a field nested under the pull
request, rather than the pull request itself, is a fourth: that field is gone, not the number.

A merged or closed pull request gives state `merged` or `closed`. This check runs right after
`awaiting-pr`, before every other rule. CI, threads and markers do not change it.
