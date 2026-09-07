# /workstreams:review flow

```mermaid
flowchart TD
    S{can the PR's status be read?}
    S -->|no| S1([return: error and the script's exit code,<br>nothing applied, nothing pushed])
    S -->|yes| H[note the sha the branch is on]
    H --> R[pr-review-toolkit:review-pr on the PR,<br>in its worktree, over base...HEAD]
    R --> G[ws-pr-comments.py: every review, comment,<br>and thread already on the PR]
    G --> V[verify every finding against the code in the worktree;<br>drop the ones that do not hold, keep each reason]
    V -->|nothing held| Y
    V -->|the diff already satisfies it| Y
    V -->|findings held| AP[hand the numbered list to one applier subagent]
    AP --> AQ{applier returned}
    AQ -->|error| Y
    AQ -->|done| P[note the sha again: pushed is before..after,<br>then git diff --stat over it]
    P --> Y[reply on every bot or human thread a finding came from:<br>applied, already addressed at a path, or rejected and why]
    Y --> Z([return: applied numbers, rejected with reasons,<br>already addressed, pushed range and its diffstat,<br>title_or_body_updated, error and its exit code])
```

The round runs in the session that invoked it, never in a subagent, because
`/pr-review-toolkit:review-pr` dispatches analyzer agents whose completion wakes whoever
dispatched them. A subagent has no such wake to receive and would fall back to a timed wait,
idling for the rest of the interval after the analyzers had already finished (issue #62). The
applier is a subagent because it takes a finished list and returns once, which is a bounded job.

A thread is never resolved here, on any path, including the one where the finding was applied.
Resolving is the reviewer's judgement that the matter is closed; the round says what it did and
leaves the decision with them.

Substantial or cosmetic is defined in this skill's Return section, next to the `diffstat` the
definition is read off; both callers cite it from there rather than restating it.

Nothing on any path writes a state file, counts a round, or schedules a wake. What is due after
this round is the caller's decision, and the caller is the only thing that survives between ticks:
`/workstreams:run` Step 4 and `/field-test:harden`'s review phase.
