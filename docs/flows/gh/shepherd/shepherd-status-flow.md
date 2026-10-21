---
type: Reference
description: How `gh.ts shepherd-status` reads one repository's open, auto-merge pull requests and its stacks into targets and a not-ready list, one label at most. It also shows each way it stops.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-20
---

# shepherd-status flow

`node scripts/gh.ts shepherd-status` prints one JSON document about what `/gh:shepherd` would
work on in one repository, and changes nothing. The `/gh:shepherd` skill runs it, then dispatches
the `shepherd-prs` agent with the targets it names.

```mermaid
flowchart TD
    A[shepherd-status run] --> B{Help in any position?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| B1{A flag other than --all?}
    B1 -->|Yes| Z8([Refused: unknown flag, exit 2]):::stop
    B1 -->|No| B2{More than two arguments,<br/>besides --all?}
    B2 -->|Yes| Z0([Refused: one label per run, exit 2]):::stop
    B2 -->|No| C[Target: the first argument, or the working<br/>directory when there is none; label: the<br/>second argument, if any]
    C --> D{Target is a directory<br/>you can enter?}
    D -->|No| Z1([Refused: not a directory,<br/>or cannot enter, exit 2]):::stop
    D -->|Yes| E{Inside a git checkout?}
    E -->|No| Z2([Refused: not a git repository, exit 2]):::stop
    E -->|Yes| F{gh names the repository<br/>and its default branch?}
    F -->|gh not on PATH| Z3([gh is required, exit 1]):::stop
    F -->|No answer, or a name absent| Z4([could not resolve the repository, exit 1]):::stop
    F -->|Yes| G{Open pull requests listed,<br/>narrowed to the label when one is given?}
    G -->|No| Z5([could not list pull requests, exit 1]):::stop
    G -->|Yes| G2{Window of 500 full?}
    G2 -->|Yes| Z7([more than 500 open pull requests;<br/>use a label, exit 1]):::stop
    G2 -->|No| I{Recent completed runs on<br/>the default branch readable?}
    I -->|No| J[CI time: 300 s]
    I -->|Yes| K[CI time: median run duration;<br/>300 s when no run is usable]
    J --> L[Drop draft pull requests]
    K --> L
    L --> LS{A layer of an open stack?}
    LS -->|Yes| LO([Left out of the pull requests;<br/>its stack decides])
    LS -->|No| M{Auto-merge enabled?}
    M -->|Yes| Q[Read the review rules of each base once;<br/>the threads of each PR whose base asks]
    M -->|No| O([Left out; never enabled])
    Q -->|A read fails| QF[stderr names the branch or the PR;<br/>the verdict rests on reviewDecision]
    QF --> R
    Q -->|Read| R{Without --all: needs an approval,<br/>or has unresolved review threads?}
    R -->|Yes| NR[not_ready, with its reasons]
    R -->|No, or --all| N[targets: merge-risk low, then no label,<br/>then medium, then high, then a band<br/>it does not know; oldest first in a band]
    N --> S1[Read the open stacks; with a label, only a stack<br/>with an open layer that carries it]
    NR --> S1
    S1 -->|A stack or a layer cannot be read| S2[stderr names it; that stack is left out,<br/>never not ready]
    S1 -->|Read| S3{An open layer is a draft, or a closed entry,<br/>or a required check of the stack base failed,<br/>or without --all a layer needs an approval<br/>or has unresolved threads by the rules of the stack base?}
    S3 -->|Yes| S4[not_ready: the stack, each layer, each reason]
    S3 -->|No| S5[targets: the stack, after the pull requests]
    S2 --> P([Print one JSON document, exit 0])
    S4 --> P
    S5 --> P
    X[Any error it did not expect] --> Z6([internal error on stderr, exit 3]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A run list that gh cannot read is not a failure: the wait bound falls back to 300 seconds. A
pull request list that gh cannot read is exit 1, because it says nothing about how many there
are. A window that fills the limit is a window, not an answer. This command refuses instead; it
does not report a truncated list. Exit 3 is outside the documented set, so a caller cannot read a
crash as an answer.

A stack is judged by the rules of its base, for every layer, as GitHub merges it (ruling 4 on
#469). A required check that is still pending, or has not reported, is no reason: the stack goes
to the loop, and `shepherd-stack wait` waits for it.
