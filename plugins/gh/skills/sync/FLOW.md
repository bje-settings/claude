# sync — flow

What `/gh:sync` does, and every way it can decline to act.

```mermaid
flowchart TD
    subgraph discover [scope from the working directory]
        direction TB
        A{Inside a git repo?}
        A -->|Yes| A1[That checkout only]
        A -->|No| A2[Each immediate subdir that is a checkout root]
        A2 -.->|Not a repo, or inside one but not its root| A3([Skipped silently]):::stop
        A2 --> A4{Any found?}
        A4 -->|No| A5([Stop: no git repositories directly inside cwd]):::stop
    end

    A1 --> C[Sync each repo found]
    A4 -->|Yes| C

    C --> E{Tree clean, origin present,<br/>no operation in progress?}
    E -->|No| F([Skip the repo, say why]):::stop
    E -->|Yes| G[Fetch, then move to the default branch]

    G --> H{Can it fast-forward?}
    H -->|No| I([Report diverged, leave it alone]):::stop
    H -->|Yes| J[Fast-forward]
    J --> K{Did a lock file change?}
    K -->|Yes| L[Install dependencies]
    K -->|No| M[For each local branch]
    L --> M

    M --> N{Merge proof?}
    N -->|Merged PR at this commit| O[Delete branch]
    N -->|Ancestor of default branch| O
    N -->|Name matched, other commit| P([Keep: not this commit]):::stop
    N -->|Lookup failed| Q([Keep: never checked]):::stop
    N -->|Nothing found| R([Keep: no proof]):::stop

    O --> S{Branch has a worktree?}
    S -->|Clean| T[Remove worktree, then delete]
    S -->|Dirty or unreadable| U([Keep both, say why]):::stop
    S -->|None| V[Delete, report its SHA]

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

Every path that keeps a branch says which of the four reasons applied. The distinction matters:
"never checked" is not "no proof", and reporting one as the other asserts something the command
did not establish.

The `discover` subgraph is shared with `/gh:shepherd`, byte for byte: both skills resolve their
scope by the same rule, `scripts/lib/discover.py`, so the two diagrams must describe it
identically.
