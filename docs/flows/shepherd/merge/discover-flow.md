---
type: Reference
description: How `shepherd.ts discover` finds the checkout roots in scope for a directory, and each way it stops.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-10-21
---

# discover flow

`node scripts/shepherd.ts discover` prints the checkout roots in scope for a directory, one per
line. The `/shepherd:merge` skill runs it to find its scope. The gh plugin's `sync` uses the same
rule in process.

```mermaid
flowchart TD
    A[discover run] --> B{-h or --help,<br/>in any position?}
    B -->|Yes| H([Print usage, exit 0])
    B -->|No| C{More than one argument?}
    C -->|Yes| Z1([Refused: usage line, exit 2]):::stop
    C -->|No| D[Target: the argument, or the<br/>working directory when it is absent or empty]
    D --> E{Target is a directory?}
    E -->|No| Z2([not a directory, exit 1]):::stop
    E -->|Yes| F{Target inside a git checkout?}
    F -->|Yes| G[Discovery finished]
    F -->|No| I{Target can be listed?}
    I -->|No| Z3([could not read the target, exit 1]):::stop
    I -->|Yes| J[Each entry, in name order]
    J --> K{Name starts with a dot,<br/>or not a directory?}
    K -.->|Yes: skip it silently| J
    K -->|No| L{Entry is the root of a checkout?}
    L -.->|No: not a repo, or inside one<br/>but not its root; skip it silently| J
    L -->|Yes| M[Keep its resolved path]
    M --> J
    J -->|All entries read| G
    G --> O{git itself can run?}
    O -->|No| Z5([missing git: reason, exit 1]):::stop
    O -->|Yes| N([Print each root kept, one per line;<br/>none kept prints nothing; exit 0])
    X[Any error it did not expect] --> Z4([scripts/shepherd.ts's own catch:<br/>shepherd: message, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

A directory with no checkouts in it is an answer: empty stdout and exit 0. The two exit 1
outcomes at `not a directory` and `could not read the target` are different facts. Both mean the
target itself could not be read.

This command asks git whether it can run at all after discovery finishes and before it prints a
line. On a missing git, it says so and exits 1. It never treats "no checkouts found" as the
answer to a question discovery never asked. `scripts/shepherd.ts` catches an error this command did not
expect. It reports that error as one stderr line, rather than node's own stack trace.
