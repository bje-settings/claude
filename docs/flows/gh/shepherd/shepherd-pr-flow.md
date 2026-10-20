---
type: Reference
description: How `gh.ts shepherd-pr` checks its arguments, then runs one of five steps on one pull request. It reports every result.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-19
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
    R -->|state| SR{Review rules of the base read?}
    SR -->|No: stderr says why| SN[approval from reviewDecision alone;<br/>threads null]
    SR -->|Yes| ST{Rules ask for resolved threads?}
    ST -->|Yes| STR[Read the unresolved threads;<br/>a failed read is null, stderr says why]
    ST -->|No| SV
    STR --> SV[approval: met, missing or not_required;<br/>threads: resolved, unresolved or not_required]
    SN --> SY
    SV --> SY{From this repository,<br/>with headRefName?}
    SY -->|From a fork: no ref read| S
    SY -->|gh answered without either field:<br/>stderr says why| S
    SY -->|Yes| SY2{Ref of the branch read?}
    SY2 -->|No: stderr says why| S
    SY2 -->|Yes| SY3{Ref is headRefOid?}
    SY3 -->|Yes: inSync true| S
    SY3 -->|No| SO([ok true: inSync false, the detail names<br/>headRefOid and the ref, exit 0])
    S([ok true: the pull request, whether its head<br/>is behind its base, approval and threads,<br/>branchRefOid and inSync, exit 0])
    R -->|merged| M([ok true: merged with its commit,<br/>or not merged with its state, exit 0])

    subgraph writes [rebase: the only write]
        R -->|rebase| RB{Open?}
        RB -->|No| RF([ok false: refused, exit 0]):::stop
        RB -->|Yes| RB2{gh accepted the update?}
        RB2 -->|Yes| RB4{gh said the branch<br/>is already up to date?}
        RB4 -->|Yes: read once, no poll| RB5([ok true: result up_to_date, exit 0])
        RB4 -->|Yes, and that read failed| RB3
        RB4 -->|No| RB6{Head moved on the<br/>last successful read?}
        RB6 -->|Yes| RB7([ok true: result moved, exit 0])
        RB6 -->|No, bound not reached| RB8[Sleep one poll, never past the bound,<br/>then read again] --> RB6
        RB6 -->|No, at the bound| RB9([ok true: result unmoved,<br/>the update is still queued, exit 0])
        RB6 -->|Last read failed, at the bound| RB3([ok true: re-read failed,<br/>after empty, exit 0])
    end
    RB2 -->|No| OF([ok false: gh failed, or the<br/>step did not land, exit 0]):::stop

    subgraph reads [wait and settle: read only]
        R -->|wait| W{Merged?}
        W -->|Yes| MG([ok true: result merged, exit 0])
        W -->|No| WB{Head behind its base?}
        WB -->|Yes| WBH([ok true: result behind,<br/>rebase before CI, exit 0])
        WB -->|No, or the compare<br/>could not be read| WN{Any checks reported?}
        WN -->|No| WP([ok true: result passed, exit 0])
        WN -->|Yes| W3{Evaluate the last<br/>successful read}
        W3 -->|Merged| MG
        W3 -->|Head behind its base| WBH
        W3 -->|Passed| WP
        W3 -->|A check failed| WF([ok true: result failed, with<br/>the failed checks and a log tail, exit 0])
        W3 -->|Pending| W9{Bound reached?}
        W9 -->|Yes| W7{Last read attempt succeeded?}
        W7 -->|Yes| WPE([ok true: result pending,<br/>call wait again, exit 0])
        W9 -->|No| W10[Sleep one poll, never past the bound,<br/>then read the pull request and the compare]
        W10 --> W11{That read succeeded?}
        W11 -->|Yes| W3
        W11 -->|No: counted, the last<br/>successful read stands| W9
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
    W7 -->|No| OF
    ST7 -->|No| OF

    X[Any error it did not expect] --> Z6([internal error on stderr, exit 3]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The action name is checked before any gh call, so an unknown action exits 2 with no gh call.
Once the arguments and the action pass, and gh names the repository, every step exits 0. Its
JSON `ok` field carries the result, and a refusal of a step is `ok: false`, not a status.
