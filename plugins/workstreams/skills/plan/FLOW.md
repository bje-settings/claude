# /workstreams:plan flow

```mermaid
flowchart TD
    P{gh-stack, pr-review-toolkit,<br>gh login all present?}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| R{selectors match any issue?}
    R -->|no| R1([stop: nothing matched])
    R -->|a number is a pull request| R2([stop: not an issue])
    R -->|yes| E[read each issue, the code it names,<br>linked logs and ADRs, the repo's own conventions]
    E --> C{can it be implemented<br>without a user decision?}
    C -->|already closed, needs hardware,<br>data, or a decision| C1[defer with a reason]
    C -->|only after another issue lands| M1
    C -->|yes| M{touches the same files or regions<br>as another work-now issue?}
    M -->|yes| M1[one stack, foundational change at the bottom]
    M -->|no| M2[independent stream]
    M1 & M2 --> X{depends on a change in another repo?}
    X -->|yes| X1[name the repo in the plan; never absorbed silently]
    X -->|no| S
    X1 --> S[size each stream: model and effort with a reason]
    S --> Q[ask the user every open question, once]
    Q --> T[propose in plan mode]
    C1 --> T
    T -->|user rejects| T1([stop: nothing recorded])
    T -->|user approves| W{a plan already exists for this repo?}
    W -->|no| Z
    W -->|a file is there that cannot be opened at all| W4([stop: show the message; the file needs a person])
    W -->|a file is there that is not valid workstreams JSON| W3
    W -->|yes, and every stream of it is done or failed| W2[say the finished run will be archived;<br>do not ask]
    W -->|yes, and it is still live or paused| W3{user says replace it?<br>corrupt: init --force archives it intact}
    W3 -->|no| W1([stop: existing plan kept])
    W3 -->|yes| Z
    W2 --> Z[record streams, deferrals, and cadence in the state file<br>init archives whatever plan was there]
    Z --> Z1([done: nothing started; /workstreams:run executes])
```

A finished plan is not a question. Every stream of it reached `done` or `failed`, so there is
nothing for the user to decide about replacing it; `init` moves it to the state dir's `archive/`
and the new plan takes its place. Only a run still live, or one holding a `paused` stream whose
question nobody answered, is worth stopping to ask about.
