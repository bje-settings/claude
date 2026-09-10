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

    G --> P
    G --> H[Copy and overwrite first]
    H --> I[Delete what upstream no longer has]
    I --> J[Write UPSTREAM.json last, atomically]
    J --> K[Branch, commit and push<br/>in the destination]
    K --> L([Open a PR there; do not merge]):::done

    H -.->|Write fails partway| G1([Exit 3, not 2: the copy is half made.<br/>Recovery commands print on stderr]):::stop
    I -.-> G1

    subgraph refusals [what the script refuses, exit 2]
        direction TB
        P --> P1{Source}
        P1 -->|Unknown plugin, or no manifest| PX([Refuse]):::stop
        P1 -->|Uncommitted or staged changes| PX
        P1 -->|Nothing committed under the plugin| PX
        P1 -->|A symlink or submodule in the plugin| PX
        P1 -->|Manifest unreadable, or declaring no version| PX
        P1 -->|No origin, or an origin URL<br/>that is not exactly owner/repo| PX
        P --> P2{Destination}
        P2 -->|Missing, a file, or not a git repo| PX
        P2 -->|git refuses to read it at all| PX
        P2 -->|A symlink, or the plugin path is one| PX
        P2 -->|Shares a git object store with this repo| PX
        P2 -->|Resolves to the same directory as the source| PX
        P2 -->|A submodule in the destination| PX
        P2 -->|Copy has uncommitted tracked changes| PX
        P2 -->|Any path resolving outside the copy| PX
        P2 -->|A directory or symlink where<br/>the source has a regular file| PX
        P2 -->|A directory that cannot be listed| PX
        P --> P3{Only on a real run}
        P3 -->|Untracked files the publish would<br/>overwrite or delete, in a copy<br/>we have never stamped| PX
        P --> P4{Environment}
        P4 -->|git not on PATH| PX
    end

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
    classDef done fill:#e8f5e9,stroke:#1b5e20,color:#000
```

The two exit codes that are easy to conflate are `1` and `2`. `1` is "the copy is behind", which
is normal and is the reason to carry on. `2` is "a precondition does not hold **and nothing was
written**", which is a reason to stop and fix something. `3` covers both an unexpected exception
and a write that died partway: deliberately not `1`, so a crash can never be read as ordinary
drift, and deliberately not `2`, because by then the destination is no longer as you left it.

Most refusals happen under `--check` as well as under a real run, which is why the preflight box
hangs off both. The one exception is the untracked-file refusal: `--check` writes nothing, so
nothing is at risk, and a stray file is more useful reported as drift than turned into a refusal
to look.

The untracked-file refusal turns on whether the copy carries this tool's own `UPSTREAM.json`
naming this plugin and this source. With that stamp the directory is a mirror we manage, so an
untracked file in it is output from an earlier run and is swept; without it the directory belongs
to whoever made it, and the sweep would destroy work git cannot restore.
