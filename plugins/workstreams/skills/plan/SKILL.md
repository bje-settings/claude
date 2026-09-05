---
name: plan
description: >
  Turn a set of GitHub issues into a plan of parallel workstreams: evaluate each issue,
  decide which to work now and which to defer, group colliding changes into stacked PRs,
  size a subagent per stream, and propose it all in plan mode. Takes issue numbers, ranges,
  label:<name>, milestone:<title>, or search words. Writes the state that /workstreams:run
  executes. Requires gh-stack and pr-review-toolkit.
argument-hint: <issues | label:x | milestone:x | search words>
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, EnterPlanMode, ExitPlanMode
disable-model-invocation: true
---

Plan workstreams for the issues in `$ARGUMENTS`. Everything below is procedure; the only
judgment calls are the classification, the collision map, and the sizing, and those are
recorded so `/workstreams:run` never has to re-derive them.

## Flow

```mermaid
flowchart TD
    P{gh-stack, pr-review-toolkit,<br>gh login all present?}
    P -->|no| P1([stop: print the install command for each missing piece])
    P -->|yes| R{selectors match any issue?}
    R -->|no| R1([stop: nothing matched])
    R -->|yes| E[read each issue, the code it names,<br>linked logs and ADRs, the repo's own conventions]
    E --> C{can it be implemented<br>without a user decision?}
    C -->|already closed, needs hardware,<br>data, or a decision| C1[defer with a reason]
    C -->|only after another issue lands| C2[blocked: joins that issue's stack, above it]
    C -->|yes| M{touches the same files or regions<br>as another work-now issue?}
    M -->|yes| M1[one stack, foundational change at the bottom]
    M -->|no| M2[independent stream]
    M1 & M2 --> X{depends on a change in another repo?}
    X -->|yes| X1[name the repo in the plan; never absorbed silently]
    X -->|no| S
    X1 --> S[size each stream: model and effort with a reason]
    S --> Q[ask the user every open question, once]
    Q --> W{a plan already exists for this repo?}
    W -->|yes, user declines to replace| W1([stop: existing plan kept])
    W -->|no, or user says replace| T[propose in plan mode and record the state]
    C1 & C2 --> T
    T --> Z([done: nothing started; /workstreams:run executes])
```

## Step 1 — Preflight

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-preflight.sh
```

If it exits non-zero, print each `hint` from the JSON verbatim as a command the user can run,
then stop. Do not work around a missing dependency.

## Step 2 — Resolve the issues

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-issues.sh $ARGUMENTS
```

Pass the arguments straight through. Exit 3 means nothing matched: say so and stop. The output
is a JSON array; `refs` on each issue lists the other issues its body mentions, which seeds the
blocked-on analysis but does not decide it.

## Step 3 — Evaluate

For each issue, read the body, every file or symbol it names, any linked logs or ADRs, and the
target repository's `CLAUDE.md` and `.claude/rules/`. Classify it as one of:

- **work now**: the change is specified well enough to implement without a decision from the user.
- **defer**: needs hardware, needs data that does not exist yet, or needs a decision the user has
  not made. Record the one-line reason.
- **blocked on #N**: cannot start until another issue in the set lands. It joins that issue's
  stream, above it.

A closed issue in the set is deferred with the reason `already closed`.

## Step 4 — Collision map

For every work-now issue, list the files and, where a file is large, the functions or regions
the change will touch. Then:

- Issues whose regions overlap, or where one is blocked on the other, form one **stack**. Order
  it bottom-up: the more foundational or higher-value change goes at the bottom, closest to the
  default branch. Each layer is its own draft PR based on the layer below.
- Issues whose regions are disjoint become **independent streams**.
- A dependency on another repository (a rename here that a hook there relies on) is written into
  the plan explicitly, with the other repo named. It is never silently absorbed into a stream.

## Step 5 — Size each stream

Use `sizing.md` in this directory. Record model, effort, and a one-line reason per stream. The
model is passed per call; the effort selects which `stream-<effort>` agent runs the stream.

## Step 6 — Ask, then propose

Before entering plan mode, ask the user every question the plan depends on with
`AskUserQuestion`: an ambiguous classification, a stack order that could go either way, a
cross-repo dependency they may want handled elsewhere. Ask them together, once.

Then `EnterPlanMode`, write the plan using `plan-template.md` in this directory, and persist the
same content to the state file:

```bash
S="bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.sh"
$S init                      # add --force only if the user said to replace an existing plan
$S add-stream <id> --issues <n,n> --kind independent|stack --model <alias> --effort <level> \
   --reason "<why this size>" [--order <n>] [--base <branch-of-layer-below>]
$S defer <issue> "<reason>"
$S meta loop_delay <seconds>   # the cadence from the plan's Loop section
$S meta plan_path <path to the plan file>
```

Stream ids are short and stable, `s1`, `s2`, and so on; stacked layers share a prefix such as
`s1a`, `s1b`, with `--order` giving the position from the bottom starting at 1 and `--base` naming
the branch of the layer below (the default branch for the bottom layer, which may be omitted).

If `init` exits 3 a plan already exists for this repo. Show the user `ws-state.sh show` and ask
whether to replace it before proceeding with `--force`.

Finish with `ExitPlanMode`. Do not start any stream: that is `/workstreams:run`.
