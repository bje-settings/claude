---
type: Reference
description: What the /workstreams:question skill does, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-11-12
---

# /workstreams:question skill flow

What `/workstreams:question` does to one sweep report, and every way it declines to act.

```mermaid
flowchart TD
    C{sequencing comment posted?}
    C -->|Yes| C1[Read it: unblocked set, what it unlocks,<br/>file map, collisions, shape, size,<br/>hidden dependencies]
    C -->|No| C2([Stop: say there is no sequencing comment]):::stop
    C1 --> D

    D[For each open item: open the file and the record;<br/>look up the guidance: installed package docs,<br/>then official docs, then community patterns]
    D --> D1[Search for a recorded deviation:<br/>a code comment, a context file, an ADR or an RFC]
    D1 --> E{which case?}
    E -->|answer already in the tree, follows the guidance,<br/>or deviates with a recorded reason| E1[Record it as a ruling, with a citation] --> H
    E -->|deviates with no record,<br/>or the sources disagree| T[Put the question in the design tree]
    E -->|genuinely the person's call| T
    T --> H{another open item?}
    H -->|Yes| D
    H -->|No| HK{a local hook runs a full suite on every push?}
    HK -->|No| FR
    HK -->|Yes, records say CI is the boundary| HK1[Record a ruling: core.hooksPath at /dev/null,<br/>applied in housekeeping] --> FR
    HK -->|Yes, records silent| HK2[Put the question in the design tree;<br/>never ruled] --> FR
    FR[Compute the frontier: each open decision<br/>whose prerequisites are settled]
    FR --> FE{frontier empty?}
    FE -->|No| F{cheap to reverse?}
    F -->|Yes| F1[Record a ruling; it leaves the frontier] --> FR
    F -->|No| XF{a fact would fill the context?}
    XF -->|Yes| X[Explore subagent finds it;<br/>only the questions that wait on it wait] --> D
    XF -->|No: read a short fact yourself;<br/>or the rest of the frontier| G[AskUserQuestion: at most 4 questions for each call,<br/>more calls in the same round; recommendation first,<br/>argument against, 2-4 options]
    G -->|an answer opens a new decision| D
    G -->|answers in| FR
    FE -->|Yes| FL{a lookup still runs?}
    FL -->|Yes| FW[Wait for the Explore result] --> D
    FL -->|No| I[Rulings comment on every issue in the round<br/>and any issue a ruling touches]

    I --> J[EnterPlanMode: write the plan;<br/>each layer fits one agent's budget, else split into more layers;<br/>one worktree for the stream]
    J --> K{ExitPlanMode: approved?}
    K -->|No| J
    K -->|Yes| KR{rounds --all --issues: a round in flight now holds one of the issues,<br/>unavailable is not empty, or the command fails?}
    KR -->|Yes| KR1([Stop: name the cause; another session can have planned them]):::stop
    KR -->|No| L[Plan comment on every issue in the round;<br/>its first line names it the plan,<br/>with the approval time to the minute in UTC]

    L --> M{default branch checked out in the root?}
    M -->|No| M1[git fetch origin default:default] --> M6
    M -->|Yes| M3{uncommitted tracked changes?}
    M3 -->|Yes| M4([Stop: name the dirty default branch]):::stop
    M3 -->|No| M5[git fetch origin, then merge --ff-only] --> M6
    M6{fast-forward refused?}
    M6 -->|Yes| M7([Stop: name the cause, quote git's message]):::stop
    M6 -->|No| M2
    M2[Remove ignored leftovers under plugins/] --> N
    N{a ruling or an answer disables the hook?}
    N -->|No| W
    N -->|Yes| O1[Apply it: core.hooksPath at /dev/null,<br/>no ask, restore at close] --> W
    W{an upper layer's base that no<br/>pull_request CI filter matches?}
    W -->|No, or a GitHub stack runs it| P
    W -->|Yes| W1[Comment on each issue: name the layer;<br/>merge the layer below, retarget, then CI runs] --> P
    P[Note any open pull request that shares files]

    P --> Q([Report: what each frontier round asked and answered,<br/>the rulings, the two comments, housekeeping])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The hook question is the one case in the whole skill where a cheap ruling is not taken,
when the records are silent. It is asked in the frontier, before plan mode.
So `ExitPlanMode` is the last step that asks the person.
If you disable a push-time suite, you change what protects the round.
So this question is asked, not ruled, even though it is, in every other sense, reversible.
