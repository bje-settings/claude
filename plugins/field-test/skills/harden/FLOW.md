# /field-test:harden flow

```mermaid
flowchart TD
    P{gh, gh login, workstreams,<br>pr-review-toolkit all present?}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| E{a hardening run already<br>exists for this skill?}
    E -->|a file is there that cannot be read| E3([stop: show the message; the file needs a person])
    E -->|yes, and every target is done or failed| E2[archive it and start a new one;<br>nothing to ask]
    E -->|yes, still in progress| E1[ask: resume it, or start over? never force on your own]
    E -->|no| I[record the run and its targets, in the order given]
    E1 -->|resume| N
    E1 -->|start over| I
    E2 --> I
    I --> N{next target still to do?}
    N -->|none| NE{the run has any targets at all?}
    NE -->|no: add-target never landed| NE1([stop: say so; nothing to report or archive])
    NE -->|yes| Z
    N -->|the state file describes<br>a target no command could act on| Z2([stop: report what next said;<br>the file needs a person])
    N -->|one, already paused| Z1([stop: report the question it is waiting on])
    N -->|one, still running from a session that stopped| RS{which phase did it reach?}
    N -->|one, pending| F[field test it with /field-test:run and record the issues filed]
    RS -->|field-test| F
    RS -->|verify| V
    RS -->|fix| W
    RS -->|review| R
    RS -->|merge| M0
    RS -->|summary| S
    F --> V{does the target's own report<br>match what GitHub says?}
    V -->|no| V1[file the mismatch as a finding of its own]
    V -->|yes| C
    V -->|a claim gh could not read,<br>or gh failing the same way twice| V2[verify once more]
    V2 --> V3{same answer again?}
    V3 -->|no| V
    V3 -->|yes| Z1
    V1 --> C{any findings this round?}
    C -->|none| S[summarise the target as clean]
    C -->|some| W[one workstreams worker: one worktree,<br>one draft PR closing every issue of the round]
    W --> WQ{worker returned}
    WQ -->|paused, or the work needs more than one PR| Z1
    WQ -->|failed, or no report| X[mark the target failed; its issues stay open]
    X --> S
    WQ -->|draft PR| RC{review_rounds is 0?}
    RC -->|yes| RB[count this round]
    RC -->|no: already counted| R
    RB --> R[/workstreams:review:<br>one round here, in this session]
    R --> RQ{what did the round return?}
    RQ -->|error, and gh itself was what failed| RC
    RQ -->|error| Z1
    RQ -->|a substantial diffstat, first round| RC
    RQ -->|a substantial diffstat, second round| Z1
    RQ -->|nothing pushed, or a cosmetic diffstat| M0[mark ready and enable auto-merge]
    M0 -->|either command failed| Z1
    M0 -->|both accepted| M[block in the foreground on the checks]
    M --> MQ{what did the wait say?}
    MQ -->|merged| S
    MQ -->|pending, or passed up to three times| M2[wake later and look again]
    M2 --> M
    MQ -->|passed a fourth time: green but not merging| Z1
    MQ -->|gh could not answer, twice| Z1
    MQ -->|there is no such pull request<br>(at once, no second look)| Z1
    MQ -->|failed, mechanically, first time| W
    MQ -->|failed, mechanically, again| Z1
    MQ -->|failed, behaviourally| Z1
    S --> N
    Z[stop the loop; print every target's summary,<br>then every question still open]
    Z --> ZF{every target done or failed?}
    ZF -->|yes| ZA([archive the run and print where it went])
    ZF -->|no: a target is paused| ZK([leave the run in place so the user can answer and re-run])
```

The run file is archived only once the run is over, and a `paused` target means it is not: the
question is what somebody still owes an answer to. A finished run is not a question either way,
which is why `init` archives one itself rather than asking.

The review round is `/workstreams:review`, invoked here rather than restated: it reviews, reads
the PR's own bot and human threads, verifies every finding against the code, applies what holds
through `workstreams:applier`, and replies on the threads. Substantial or cosmetic is defined in
`/workstreams:review`'s Return section, read off the `diffstat` the round prints there.

A target left `running` resumes at the phase recorded on it rather than at the top: its issues are
already filed and its pull request already open, and starting over would file and open them twice.

The round is counted only when `review_rounds` is 0. At any other value the round about to run was
counted already, by the repeat branch or by the session that stopped mid-round.

The round runs in the main session because `/pr-review-toolkit:review-pr` dispatches analyzer
agents that wake whoever invoked them, and a subagent gets no such wake (issue #62).
