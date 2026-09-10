# publish — flow

What `/publish` does, and every way it or the script it runs can decline to act.

```mermaid
flowchart TD
    A{Plugin name and<br/>destination path given?}
    A -->|No| A1([Ask; publish nothing]):::stop
    A -->|Yes| B{This repo clean, on the<br/>default branch, up to date?}
    B -->|No| B1([Stop: a publish ships what is committed]):::stop
    B -->|Yes| C{Suite, coverage gate and<br/>plugin validate all pass?}
    C -->|No| C1([Stop: the tests do not travel with the copy]):::stop
    C -->|Yes| D[Run the script with --check]

    D --> E{Exit code}
    E -->|2, refused| P[Preflight refusal]
    E -->|0, in sync| E1([Nothing to publish; stop]):::stop
    E -->|1, drift| F{Content changed but<br/>version did not?}

    F -->|Yes| F1([Raise it: bump the version first,<br/>as a commit here]):::stop
    F -->|No| G[Run the script for real]

    G --> H[Copy and overwrite first]
    H --> I[Delete what upstream no longer has]
    I --> J[Write UPSTREAM.json last, atomically]
    J --> K[Branch, commit and push<br/>in the destination]
    K --> L([Open a PR there; do not merge]):::done

    G -.->|Write fails partway| G1([Report the recovery command:<br/>git checkout + git clean]):::stop

    subgraph refusals [what the script refuses, exit 2]
        direction TB
        P --> P1{Source}
        P1 -->|Unknown plugin, or no manifest| PX([Refuse]):::stop
        P1 -->|Uncommitted or staged changes| PX
        P1 -->|A symlink or submodule in the plugin| PX
        P1 -->|No origin, or an unparseable origin URL| PX
        P --> P2{Destination}
        P2 -->|Missing, a file, or not a git repo| PX
        P2 -->|A symlink, or the plugin path is one| PX
        P2 -->|Shares a git object store with this repo| PX
        P2 -->|Copy has uncommitted tracked changes| PX
        P2 -->|Untracked files the sweep would delete,<br/>in a copy we have never stamped| PX
        P --> P3{Environment}
        P3 -->|git not on PATH| PX
    end

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef done fill:#e8f5e9,stroke:#1b5e20,color:#000
```

The two exit codes that are easy to conflate are `1` and `2`. `1` is "the copy is behind", which
is normal and is the reason to carry on. `2` is "a precondition does not hold", which is a reason
to stop and fix something. An unexpected exception is `3`, deliberately not `1`, so a crash can
never be read as ordinary drift.

The untracked-file refusal turns on whether the copy carries this tool's own `UPSTREAM.json`
naming this plugin and this source. With that stamp the directory is a mirror we manage, so an
untracked file in it is output from an earlier run and is swept; without it the directory belongs
to whoever made it, and the sweep would destroy work git cannot restore.
