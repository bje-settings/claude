---
type: Reference
description: How `gh.ts discover` finds the checkout roots in scope for a directory, and each way it stops.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# discover flow

`node scripts/gh.ts discover` prints the checkout roots in scope for a directory, one per line.
The `/gh:shepherd` skill runs it to find its scope. `sync` uses the same rule in process.

```mermaid
flowchart TD
    A[discover run] --> B{First argument<br/>asks for help?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{More than one argument?}
    C -->|Yes| Z1([Refused: usage line, exit 2]):::stop
    C -->|No| D[Target: the argument, or the<br/>working directory when it is absent or empty]
    D --> E{Target is a directory?}
    E -->|No| Z2([not a directory, exit 1]):::stop
    E -->|Yes| F{Target inside a git checkout?}
    F -->|Yes| G([Print that checkout root, exit 0])
    F -->|No| I{Target can be listed?}
    I -->|No| Z3([could not read the target, exit 1]):::stop
    I -->|Yes| J[Each entry, in name order]
    J --> K{Name starts with a dot,<br/>or not a directory?}
    K -.->|Yes: skip it silently| J
    K -->|No| L{Entry is the root of a checkout?}
    L -.->|No: not a repo, or inside one<br/>but not its root; skip it silently| J
    L -->|Yes| M[Keep its resolved path]
    M --> J
    J -->|All entries read| N([Print each root kept, one per line;<br/>none kept prints nothing; exit 0])
    X[Any error it did not expect] --> Z4([node's own stack trace, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A directory with no checkouts in it is an answer: empty stdout and exit 0. The two exit 1
outcomes are different facts, because the target itself could not be read. When git cannot run,
each checkout question answers no, so this command also prints nothing and exits 0. `gh.ts` has
no catch-all for this command, so an error it did not expect ends in node's own stack trace.
