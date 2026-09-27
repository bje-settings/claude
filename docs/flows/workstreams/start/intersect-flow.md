---
type: Reference
description: How `workstreams.ts intersect` reads each open pull request's head against the default branch and against the other heads, and each way it stops or reports a fact as unread.
stale_after: 2027-03-27
generated:
  by: claude-opus
  at: 2026-09-27
---

# intersect flow

`node scripts/workstreams.ts intersect` reports each open pull request's head against the
default branch and against each other head. The `/workstreams:start` skill runs it on each tick,
and at the round end.

```mermaid
flowchart TD
    A[intersect run] --> B{Flags known?<br/>only --json, --help and -h}
    B -->|No| Z1([Refused, exit 2]):::stop
    B -->|--help or -h| H([Print usage, exit 0])
    B -->|Yes| C{Inside a git checkout?}
    C -->|No| Z2([failed: not in a checkout, exit 1]):::stop
    C -->|Yes| D[Read the open pull requests' heads]
    D --> E{No pull request read,<br/>and the read fell short?}
    E -->|Yes| Z3([failed: read no pull requests, exit 1]):::stop
    E -->|No| F{Default branch known?}
    F -->|No| F1[Nothing compares against it:<br/>the reason goes in unavailable]
    F -->|Yes| F2[Fetch the default branch by name;<br/>a failed fetch uses the local copy]
    F1 --> G
    F2 --> G[Read the worktree list and<br/>whether the root checkout is clean]
    G --> I[For each head: fetch it by sha, and leave no named ref]
    I --> J{Head fetched, and a<br/>default branch to compare?}
    J -->|No| J1[Merge base, files and the merge<br/>against the default branch are unread]
    J -->|Yes| K[Merge base, commits behind, changed files,<br/>and the merge against the default branch]
    J1 --> L
    K --> L[A pull_request run for this exact head?<br/>The local worktree on its branch, and is it clean?]
    L --> M{Base is another open head of<br/>this repository, not the default branch?}
    M -->|Yes| M1[A stack layer: its own files<br/>are the diff from the layer below]
    M -->|No| M2[Not a layer: its own files are its changed files]
    M1 --> N
    M2 --> N[Each pair of heads with an own file in common:<br/>the merge of the two heads]
    N --> O{Merge wrote a tree?}
    O -->|Yes, no conflict| P1[clean]
    O -->|Yes, with conflicts| P2[conflict, with the paths]
    O -->|No| P3[unread, never clean]
    P1 --> Q
    P2 --> Q
    P3 --> Q([Report, JSON with --json;<br/>each fact not read is null, and its reason<br/>is in unavailable; exit 0])

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A pull request from a fork is never a stack layer, and never the layer below one. Its head gets
no worktree, because a local branch of the same name is another branch. A merge against the
default branch has the same three results as a pair: `clean`, `conflict`, or `unread`.
