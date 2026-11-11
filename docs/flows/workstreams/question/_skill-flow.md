---
type: Reference
description: What the /workstreams:question skill does, and every way it declines to act.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-11-11
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
    H -->|No| FR[Compute the frontier: each decision<br/>whose prerequisites are settled]
    FR --> FE{frontier empty, and no lookup still runs?}
    FE -->|No| F{cheap to reverse?}
    F -->|Yes| F1[Record a ruling; it leaves the frontier] --> FR
    F -->|No| XF{a fact would fill the context?}
    XF -->|Yes| X[Explore subagent finds it;<br/>only the questions that wait on it wait] --> D1
    XF -->|No, or the rest of the frontier| G[AskUserQuestion: at most 4 questions for each call,<br/>more calls in the same round; recommendation first,<br/>argument against, 2-4 options]
    G -->|answers in| FR
    FE -->|Yes| I[Rulings comment on every issue in the round<br/>and any issue a ruling touches]

    I --> J[EnterPlanMode: write the plan;<br/>each layer fits one agent's budget, else split into more layers;<br/>one worktree for the stream]
    J --> K{ExitPlanMode: approved?}
    K -->|No| J
    K -->|Yes| KR{rounds --all --issues: a round in flight now holds one of the issues,<br/>unavailable is not empty, or the command fails?}
    KR -->|Yes| KR1([Stop: name the cause; another session can have planned them]):::stop
    KR -->|No| L[Plan comment on every issue in the round;<br/>its first line names it the plan,<br/>with the approval time to the minute in UTC]

    L --> M{/gh:sync in own skill listing?}
    M -->|Yes| M1[Ask the person to run /gh:sync] --> M2
    M -->|No| M3[Fast-forward the default branch itself] --> M2
    M2[Remove ignored leftovers under plugins/] --> N
    N{a local hook runs a full suite?}
    N -->|No| W
    N -->|Yes, records say CI is the boundary| O1[Propose core.hooksPath at empty,<br/>human present, restore at close] --> W
    N -->|Yes, records silent| O2([Ask: disable it, per-push cost stated]):::pause --> W
    W{an upper layer's base that no<br/>pull_request CI filter matches?}
    W -->|No, or a GitHub stack runs it| P
    W -->|Yes| W1[Comment on each issue: name the layer;<br/>merge the layer below, retarget, then CI runs] --> P
    P[Note any open pull request that shares files]

    P --> Q([Report: what each frontier round asked and answered,<br/>what was ruled, the two comments, housekeeping])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef pause fill:#e3f2fd,stroke:#0d47a1,color:#000
```

The hook question is the one case in the whole skill where a cheap ruling is not taken,
when the records are silent. If you disable a push-time suite, you change what protects
the round. So this question is asked, not ruled, even though it is, in every other
sense, reversible.
