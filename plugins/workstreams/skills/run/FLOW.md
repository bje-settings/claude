# /workstreams:run flow

```mermaid
flowchart TD
    P{gh-stack, pr-review-toolkit,<br>gh login all present?}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| RE[reconcile the plan against GitHub:<br>a merged PR is done, a closed one failed]
    RE -->|no state file| S1([stop: run /workstreams:plan first])
    RE -->|the file cannot be read| S2([stop this tick: report the message;<br>the file needs a person])
    RE -->|gh could not answer| RE1[report it in this tick;<br>carry on with what is on disk]
    RE -->|reconciled| S{the plan has any streams?}
    RE1 --> S
    S -->|no: add-stream never landed| S1
    S -->|yes| FIN{every stream done or failed?}
    FIN -->|yes| Z
    FIN -->|no, but none left to work| Z
    FIN -->|no| L[start one worker per independent stream<br>and one per stack, each in its own worktree]
    L --> T[schedule a wake 60s to 3600s out, matched to the work]
    T --> WR[on wake: reconcile against GitHub again]
    WR -->|the file cannot be read| S2
    WR -->|gh could not answer| W
    WR -->|reconciled| W
    W{what does each stream say?}
    W -->|a worker returned a draft PR| Q
    W -->|left draft or reviewing by a session that stopped| Q
    W -->|worker needs a user decision| Pz[paused: record the question, tell the user, keep going]
    W -->|worker failed, or returned no JSON block| F[failed: record the last output, keep going]
    W -->|still working| A
    Q{can the PR's status be read?}
    Q -->|no such pull request| F2[failed: the worker reported a PR nobody can resolve]
    Q -->|gh itself failed| Q1[report it in this tick, leave the status alone,<br>look again next tick]
    Q -->|yes, and the round is already done| C
    Q -->|yes| RC{review_rounds is 0?}
    RC -->|yes| RB[count this round]
    RC -->|no: it was counted before the session stopped,<br>or by the substantial branch below| R
    RB --> R[/workstreams:review:<br>one round in this session]
    R --> VQ{what did the round return?}
    VQ -->|error, and gh itself was what failed| Q1
    VQ -->|error| Pz2[paused: say which findings it had already applied]
    VQ -->|nothing pushed, or a cosmetic diffstat| C
    VQ -->|a substantial diffstat, first round| T2[count the second round;<br>the stream is already draft and stays draft]
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
    A -->|no| Z[stop the loop; report every PR in stack order, deferred issues with reasons,<br>paused streams with questions, rejected findings with reasons, failures]
    Z --> ZF{every stream done or failed?}
    ZF -->|yes| ZA([archive the plan and print where it went])
    ZF -->|no: a stream is paused| ZK([leave the plan in place so the user can answer and re-run])
```

Every tick starts by reconciling the plan against GitHub, the first one and each wake alike,
because a pull request merged outside this loop -- in a browser, by another session, by
`/field-test:harden` -- never comes back through the review step that would otherwise notice, and
a wake that skipped it would go on reviewing work that had already landed. gh failing to answer is
reported and stepped over rather than stopped on, for the same reason an exit 4 anywhere else in
the tick is: a rate limit is not a verdict on the work. A state file that cannot be read is not
that case: nothing was written, nothing can be, and the tick stops with the message.

The file is archived only once the run is over, and a `paused` stream means it is not. The question
is what the user still owes an answer to, and archiving the plan would file it away unanswered.

Layers of a stack are reviewed bottom-up: a layer's round does not start until the layer below it
is `done`, because a change applied below changes what the layer above rebases onto.

The round is counted only when `review_rounds` is 0. At any other value the round about to run was
already counted, so counting it again would spend the one repeat on the first round.

An `error` the round returns is a pause only when it is a decision for a person. When it carries
exit 4, gh is what failed, and that goes down the same path as a status read that could not be
made: reported in the tick, status untouched, looked at again next tick.

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
