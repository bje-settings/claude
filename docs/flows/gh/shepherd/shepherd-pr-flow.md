---
type: Reference
description: How `gh.ts shepherd-pr` checks its arguments, then runs one of five steps on one pull request. It reports every result.
stale_after: 2027-03-25
generated:
  by: claude-sonnet
  at: 2026-09-25
---

# shepherd-pr flow

`node scripts/gh.ts shepherd-pr` does one step on one pull request and prints one JSON object.
The `/gh:shepherd` skill and the `shepherd-prs` agent run it and decide the next step.

```mermaid
flowchart TD
    A[shepherd-pr run] --> B{-h or --help,<br/>in any position?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{Three arguments or more, path a directory<br/>you can enter, a positive number, a checkout?}
    C -->|No| Z1([Refused, exit 2]):::stop
    C -->|Yes| I{Action known?}
    I -->|No| Z1
    I -->|Yes| G{gh names the repository?}
    G -->|gh not on PATH| Z2([gh is required, exit 1]):::stop
    G -->|No| Z3([could not resolve the repository, exit 1]):::stop
    G -->|Yes| R{Pull request read,<br/>with every field?}
    R -->|No| RU([ok false: could not read, exit 0]):::stop
    R -->|state| S([ok true: the pull request, exit 0])
    R -->|merged| M([ok true: merged with its commit,<br/>or not merged with its state, exit 0])

    subgraph writes [rebase: the only write]
        R -->|rebase| RB{Open?}
        RB -->|No| RF([ok false: refused, exit 0]):::stop
        RB -->|Yes| RB2{gh accepted the update?}
        RB2 -->|Yes| RB3([ok true: rebased, head unmoved,<br/>or re-read failed, exit 0])
    end
    RB2 -->|No| OF([ok false: gh failed, or the<br/>step did not land, exit 0]):::stop

    subgraph reads [wait and settle: read only]
        R -->|wait| W{Merged, or no checks?}
        W -->|Merged| MG([ok true: result merged, exit 0])
        W -->|No checks| WP([ok true: result passed, exit 0])
        W -->|Checks pending| W2{Bounded watch: gh<br/>answered with a status it uses?}
        W -->|Checks passed or failed| W3
        W2 -->|Yes| W3{Re-read: merged,<br/>and the checks now?}
        W3 -->|Merged| MG
        W3 -->|Passed or none| WP
        W3 -->|Pending| WPE([ok true: result pending,<br/>call wait again, exit 0])
        W3 -->|Failed| WF([ok true: result failed, with<br/>the failed checks and a log tail, exit 0])
        R -->|settle| ST{Merged? Or open, auto-merge on,<br/>and checks passed or none?}
        ST -->|Merged| MG
        ST -->|Yes| ST3{Evaluate the last successful<br/>read: what does it say?}
        ST3 -->|Merged| MG
        ST3 -->|Closed| ST4([ok true: result closed, exit 0])
        ST3 -->|A review decision blocks, or BLOCKED<br/>and the read before it was ALSO BLOCKED| ST5([ok true: result blocked,<br/>reason names the fields, exit 0])
        ST3 -->|BEHIND or DIRTY| ST6([ok true: result changed,<br/>decide again, exit 0])
        ST3 -->|No verdict yet| ST9{Bound reached?}
        ST9 -->|Yes| ST7{Last read attempt succeeded?}
        ST7 -->|Yes| ST8([ok true: result open, exit 0])
        ST9 -->|No| ST10[Sleep, then read again]
        ST10 --> ST11{That read succeeded?}
        ST11 -->|Yes: becomes the new<br/>last successful read| ST3
        ST11 -->|No: the last successful read<br/>stands, unevaluated again| ST9
    end
    ST -->|No| RF
    W2 -->|No: gh failed on its own| OF
    W3 -->|Re-read failed| OF
    ST7 -->|No| OF

    X[Any error it did not expect] --> Z6([internal error on stderr, exit 3]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The action name is checked before any gh call, so an unknown action exits 2 with no gh call.
Once the arguments and the action pass, and gh names the repository, every step exits 0. Its
JSON `ok` field carries the result, and a refusal of a step is `ok: false`, not a status.
