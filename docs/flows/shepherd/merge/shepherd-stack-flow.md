---
type: Reference
description: How `shepherd.ts shepherd-stack` checks its arguments, then runs one of four steps on one GitHub stack, layer by layer, bottom first. It reports every result.
stale_after: 2027-04-20
generated:
  by: claude-opus
  at: 2026-10-21
---

# shepherd-stack flow

`node scripts/shepherd.ts shepherd-stack <path> <stack> <action>` runs one step on one GitHub
stack.
The `shepherd-prs` agent runs it for a stack target that `shepherd-status` gave. Each layer is a
`shepherd-pr` step, judged by the rules of the stack base (ruling 4 on #469).

```mermaid
flowchart TD
    A[shepherd-stack run] --> B{Help in any position?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{Three arguments, a directory, a stack number,<br/>a git checkout, a known action?}
    C -->|No| Z1([Refused: usage error, exit 2]):::stop
    C -->|Yes| D{gh names the repository?}
    D -->|No| Z2([gh is required, or could not resolve, exit 1]):::stop
    D -->|Yes| E{The stack holds an open pull request?}
    E -->|No, or the read came back short| Z3([ok:false: no open pull request in the stack,<br/>or could not read the stack]):::stop
    E -->|Yes: open layers, bottom first;<br/>a merged entry is no layer| F{Action}

    F -->|state| S1[shepherd-pr state on each layer,<br/>with the rules of the stack base]
    S1 -->|A layer cannot be read| SX([ok:false, with the layer]):::stop
    S1 --> S2([layers, failing with each reason, ready])

    F -->|update| U1{Next layer: does its head hold its base?}
    U1 -->|Yes| U1
    U1 -->|Compare or layer unread| UX([ok:false, nothing updated past it]):::stop
    U1 -->|No| U2[gh pr update-branch in MERGE mode,<br/>read until the head moves; never --rebase]
    U2 -->|gh refused: a conflict, often| UF([ok:false, gh's words, with the layer]):::stop
    U2 -->|Head did not move| US([stopped, with the layer report])
    U2 -->|Moved| U1
    U1 -->|No layer left| UD([updated, or current])

    F -->|wait| W1[shepherd-pr wait on the next layer,<br/>in what is left of one bound;<br/>a required check with no row is pending]
    W1 -->|Passed| W1
    W1 -->|Behind, failed, stalled, pending, merged| WR([That result, with the layer report])
    W1 -->|The wait did not complete| WX([ok:false, with the layer]):::stop
    W1 -->|Every layer passed| WP([passed])

    F -->|merge| M1[shepherd-pr state on each layer;<br/>the required checks of the stack base]
    M1 -->|A layer or its compare unread| MU([unread: nothing proven, nothing merged]):::stop
    M1 -->|A layer is not ready, behind, out of sync,<br/>not green, or a required check has not reported;<br/>or an entry is closed| MN([not_ready, each layer and reason]):::stop
    M1 -->|Every layer is ready, current and green| M2{A merge method that the repository<br/>and the rules of the base allow?}
    M2 -->|Unread| MU
    M2 -->|None| MD([not_ready, no layer, detail names the base]):::stop
    M2 -->|Squash, else merge, else rebase| M3[gh stack merge stack --yes, from the checkout]
    M3 -->|GitHub refused, or gh could not run or was killed| MR([refused, gh's own words,<br/>or why gh did not finish, as the reason])
    M3 -->|Accepted| M4{Each layer reads MERGED?}
    M4 -->|Yes| MM([merged, each merge commit])
    M4 -->|No, or a read failed| MA([accepted, each layer's state])

    X[Any error it did not expect] --> Z6([internal error on stderr, exit 3]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

No step force pushes. `update` asks GitHub to merge the base into a layer, and GitHub then merges
such a stack (the probe of ruling 3 on #469). `gh stack merge` is all or nothing, and GitHub
applies the rules of the base to it. A read that failed never decides a verdict: it gives
`ok:false` or `unread`, and the agent reads again. Required checks that could not be read are the
one exception: the rollup alone decides, and GitHub still applies the rules.
