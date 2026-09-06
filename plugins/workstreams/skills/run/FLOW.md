# /workstreams:run flow

```mermaid
flowchart TD
    P{gh-stack, pr-review-toolkit,<br>gh login all present?}
    C{re-read the PR checks}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| S{a plan exists for this repo?}
    S -->|no| S1([stop: run /workstreams:plan first])
    S -->|yes, every stream already done, paused, or failed| Z
    S -->|yes| L[start one worker per independent stream<br>and one per stack, each in its own worktree]
    L --> T[schedule a wake 60s to 3600s out, matched to the work]
    T --> W{on wake: what did each worker return?}
    W -->|draft PR opened| Q{can the PR's status be read?}
    W -->|needs a user decision| Pz[paused: record the question, tell the user, keep going]
    W -->|failed, or returned no JSON block| F[failed: record the last output, keep going]
    W -->|still working| A
    Q -->|no such pull request| F2[failed: the worker reported a PR nobody can resolve]
    Q -->|gh itself failed| Pz0[paused: nothing reviewed; a later run picks it up]
    Q -->|yes| R[review in this session: run pr-review-toolkit,<br>and read the PR's bot and human review comments]
    R --> V[verify every finding against the code;<br>drop the ones that do not hold, keep each reason]
    V -->|nothing held| C
    V -->|findings held| AP[hand the verified list to an applier subagent]
    AP --> VQ{applier returned}
    VQ -->|error| Pz2[paused: say which findings it had already applied]
    VQ -->|applied a substantial change, first round| R
    VQ -->|applied a substantial change, second round| Pz4[paused: the PR keeps growing under review]
    VQ -->|applied only cosmetic changes, or nothing| C
    C -->|pass| D[done]
    C -->|pending, or none on the first look| C1[wait for the next wake]
    C -->|none twice in a row| D
    C -->|fail| Pz3[paused: CI failing after review]
    C -->|status unreadable| Pz0
    D & Pz & Pz0 & Pz2 & Pz3 & Pz4 & F & F2 & C1 --> A{any stream still running,<br>draft, or reviewing?}
    A -->|yes| T
    A -->|no| Z([stop the loop; report every PR in stack order, deferred issues with reasons,<br>paused streams with questions, rejected findings with reasons, failures])
```

Layers of a stack are reviewed bottom-up: a layer's review does not start until the layer below
it is `done`, because a change applied below changes what the layer above rebases onto.

The review runs in the main session rather than inside a subagent because
`/pr-review-toolkit:review-pr` dispatches analyzer agents whose completion wakes the session that
invoked it. A subagent has no such wake to receive, so it would fall back to a timed wait and
hang for the rest of the interval after the analyzers had already finished (issue #62). The
applier subagent takes a finished list and returns once, which is a bounded job.
