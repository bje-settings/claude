# /workstreams:run flow

```mermaid
flowchart TD
    P{gh-stack, pr-review-toolkit,<br>gh login all present?}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| S{a plan exists for this repo?}
    S -->|no| S1([stop: run /workstreams:plan first])
    S -->|yes, every stream already done, paused, or failed| Z
    S -->|yes| L[start one worker per independent stream<br>and one per stack, each in its own worktree]
    L --> T[schedule a wake 60s to 3600s out, matched to the work]
    T --> W{on wake: what does each stream say?}
    W -->|a worker returned a draft PR| Q
    W -->|left draft or reviewing by a session that stopped| Q
    W -->|worker needs a user decision| Pz[paused: record the question, tell the user, keep going]
    W -->|worker failed, or returned no JSON block| F[failed: record the last output, keep going]
    W -->|still working| A
    Q{can the PR's status be read?}
    Q -->|no such pull request| F2[failed: the worker reported a PR nobody can resolve]
    Q -->|gh itself failed| Q1[report it in this tick, leave the status alone,<br>look again next tick]
    Q -->|yes, and the round is already done| C
    Q -->|yes| R[count the round, then /workstreams:review:<br>one round in this session]
    R --> VQ{what did the round return?}
    VQ -->|error| Pz2[paused: say which findings it had already applied]
    VQ -->|nothing pushed, or a cosmetic diffstat| C
    VQ -->|a substantial diffstat, first round| T2[count the second round<br>and leave the stream draft]
    VQ -->|a substantial diffstat, second round or later| Pz4[paused: the PR keeps growing under review]
    T2 --> A
    C{re-read the PR checks}
    C -->|pass| D[done]
    C -->|pending, or none on the first look| C1[wait for the next wake]
    C -->|none twice in a row| D
    C -->|fail| Pz3[paused: CI failing after review]
    C -->|no such pull request| F2
    C -->|gh itself failed| C2[report it in this tick, leave the stream reviewing]
    D & Pz & Pz2 & Pz3 & Pz4 & F & F2 & C1 & C2 & Q1 --> A{any stream still running,<br>draft, or reviewing?}
    A -->|yes| T
    A -->|no| Z([stop the loop; report every PR in stack order, deferred issues with reasons,<br>paused streams with questions, rejected findings with reasons, failures])
```

Layers of a stack are reviewed bottom-up: a layer's round does not start until the layer below it
is `done`, because a change applied below changes what the layer above rebases onto.

The substantial-first-round edge goes back through the tick boundary rather than straight into
another round. The stream is left `draft` with its second round already counted, so the next wake
brings it round to the same status check, and a session that stops in between picks it up from
disk instead of from a decision only the running loop remembered.

Neither way of failing to read the PR's status pauses a stream any more. `paused` is a question
for a person, and Step 1 does not resume a paused stream, so pausing over a rate limit or a
network blip would strand work the next tick could have finished. The message goes in the tick's
report and the status is left where it was.

The review runs in the main session rather than inside a subagent because
`/pr-review-toolkit:review-pr` dispatches analyzer agents whose completion wakes the session that
invoked it. A subagent has no such wake to receive, so it would fall back to a timed wait and
hang for the rest of the interval after the analyzers had already finished (issue #62). The
applier subagent takes a finished list and returns once, which is a bounded job.
