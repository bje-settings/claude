---
type: Reference
description: How `gh.ts shepherd-pr` checks its arguments, then runs one of seven steps on one pull request, with every result it can report.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# shepherd-pr flow

`node scripts/gh.ts shepherd-pr` does one step on one pull request and prints one JSON object.
The `/gh:shepherd` skill and the `shepherd-repo` agent run it and decide the next step.

```mermaid
flowchart TD
    A[shepherd-pr run] --> B{First argument asks for help?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{Three arguments or more, path a directory<br/>you can enter, a positive number, a checkout?}
    C -->|No| Z1([Refused, exit 2]):::stop
    C -->|Yes| G{gh names the repository?}
    G -->|gh not on PATH| Z2([gh is required, exit 1]):::stop
    G -->|No| Z3([could not resolve the repository, exit 1]):::stop
    G -->|Yes| I{Action known, and skip<br/>has a reason file argument?}
    I -->|No| Z1
    I -->|skip| K{Reason file there and not empty?}
    K -->|No| RF([ok false: refused, exit 0]):::stop
    K -->|Yes| R
    I -->|Any other action| R{Pull request read,<br/>with every field?}
    R -->|No| RU([ok false: could not read, exit 0]):::stop
    R -->|state| S([ok true: the pull request, exit 0])
    R -->|merged| M([ok true: merged with its commit,<br/>or not merged with its state, exit 0])

    subgraph writes [rebase, recreate, skip: the only writes]
        R -->|rebase or skip| RB{Open?}
        RB -->|No| RF
        RB -->|Yes| RB2{gh accepted the update<br/>or the comment?}
        RB2 -->|Yes, rebase| RB3([ok true: rebased, head unmoved,<br/>or re-read failed, exit 0])
        RB2 -->|Yes, skip| SK3([ok true: comment URL, exit 0])
        R -->|recreate| RC{Authored by Dependabot, and open?}
        RC -->|No| RF
        RC -->|Yes| RC2{Recreate comment posted?}
        RC2 -->|Yes| RC3{Poll to the bound:<br/>what changed first?}
        RC3 -->|Head moved| RC4([ok true: recreated, exit 0])
        RC3 -->|Closed or merged, head unmoved| RC5([ok true: result closed<br/>or merged, exit 0])
    end
    RB2 -->|No| OF([ok false: gh failed, or the<br/>step did not land, exit 0]):::stop
    RC2 -->|No| OF
    RC3 -->|Other state, no read,<br/>or bound passed| OF

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
        ST -->|Yes| ST3{Read to the bound:<br/>what does GitHub report?}
        ST3 -->|Merged| MG
        ST3 -->|Closed| ST4([ok true: result closed, exit 0])
        ST3 -->|BLOCKED on two reads, or<br/>a review decision that blocks| ST5([ok true: result blocked,<br/>reason names the fields, exit 0])
        ST3 -->|BEHIND or DIRTY| ST6([ok true: result changed,<br/>decide again, exit 0])
        ST3 -->|Bound passed, nothing decisive| ST7{Last read succeeded?}
        ST7 -->|Yes| ST8([ok true: result open, exit 0])
    end
    ST -->|No| RF
    W2 -->|No: gh failed on its own| OF
    W3 -->|Re-read failed| OF
    ST7 -->|No| OF

    X[Any error it did not expect] --> Z6([internal error on stderr, exit 3]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

Once the arguments pass and gh names the repository, every step exits 0. Its JSON `ok` field
carries the result, and a refusal of a step is `ok: false`, not a status. `skip` checks its
reason file before it reads the pull request. The action name is checked only after gh answers,
so an unknown action with no gh is exit 1, not 2.
