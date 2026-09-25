---
type: Reference
description: What `workstreams.ts preflight` checks, which finding each gap gives, and how the findings set the exit status.
stale_after: 2027-03-25
generated:
  by: claude-opus
  at: 2026-09-25
---

# preflight flow

`node scripts/workstreams.ts preflight` checks what the workstreams skills depend on. The
`/workstreams:sweep`, `/workstreams:question`, `/workstreams:review` and `/workstreams:stream`
skills run it first.

```mermaid
flowchart TD
    A[preflight run] --> B{Arguments valid?<br/>only --json and --help}
    B -->|No| Z1([Refused: the parse error, exit 2]):::stop
    B -->|--help| H([Print usage, exit 0])
    B -->|Yes| C{gh runs?}

    subgraph ghchecks [gh: stops at the first gap]
        direction TB
        C -->|No| F1[Finding: gh]
        C -->|Yes| D{gh logged in?}
        D -->|No| F2[Finding: gh-auth]
        D -->|Yes| E{Extension list readable?}
        E -->|No| F3[Finding: gh-extension-list]
        E -->|Yes| G{gh stack extension there?}
        G -->|No| F4[Finding: gh-stack]
    end

    G -->|Yes| R
    F1 --> R
    F2 --> R
    F3 --> R
    F4 --> R

    subgraph plugins [installed plugins file]
        direction TB
        R{File readable? WORKSTREAMS_INSTALLED_PLUGINS,<br/>or the file under HOME}
        R -->|No HOME, unreadable, bad JSON,<br/>or no plugins object| F5[Finding: registry-unreadable]
        R -->|File absent: no plugins| P
        R -->|Yes| P{pr-review-toolkit installed?}
        P -->|No| F6[Finding: pr-review-toolkit]
        P -->|Yes| Q{Any recorded install path there?}
        Q -->|No| F7[Finding: reviewers-unlocatable]
        Q -->|Yes| S{Each of five reviewer agents<br/>in a copy that is there?}
        S -->|No| F8[Finding per reviewer absent]
    end

    F5 --> T
    F6 --> T
    F7 --> T
    F8 --> T
    S -->|Yes| T[Optional gh plugin: present or not,<br/>never a finding]
    T --> U{Any finding?}
    U -->|No| OK([ok: all present, or JSON with ok true, exit 0])
    U -->|Yes| FAIL([Each finding and its hint on stdout,<br/>or JSON with ok false, exit 1]):::stop

    classDef stop fill:#fff3e0,stroke:#e65100,color:#000
```

The gh checks stop at the first gap, so a run reports at most one gh finding. The plugin checks
always run, and their findings add to it. An absent plugin file reads as no plugins, not as an
unreadable file. The optional array never changes the exit status.
