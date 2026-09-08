---
name: plan
description: >
  Turn a set of GitHub issues into a plan of parallel workstreams: evaluate each issue,
  decide which to work now and which to defer, group colliding changes into stacked PRs,
  size a subagent per stream, and propose it all in plan mode. Takes issue numbers, ranges,
  label:<name>, milestone:<title>, or search words. Writes the state that /workstreams:run
  executes.
argument-hint: <issues | label:x | milestone:x | search words>
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, EnterPlanMode, ExitPlanMode
disable-model-invocation: true
---

Plan workstreams for the issues in `$ARGUMENTS`. Everything below is procedure; the only
judgment calls are the classification, the collision map, and the sizing, and those are
recorded so `/workstreams:run` never has to re-derive them.

## Step 1: Preflight

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-preflight.py"
```

Exit 0 means proceed. Exit 1 prints JSON: print each `hint` verbatim as a command the user
can run, then stop. Do not work around a missing dependency.

## Step 2: Resolve the issues

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-issues.py" <selectors>
```

Pass each selector from `$ARGUMENTS` as its own quoted argument, so a milestone title with a
space stays one selector and nothing in it reaches the shell. Exit 3 means nothing matched:
say so and stop. Exit 1 names the failure (a pull request number, a gh error): stop and show
it. The output is a JSON array; `refs` on each issue lists the other issues its body mentions,
which seeds the blocked-on analysis but does not decide it.

## Step 3: Evaluate

For each issue, read the body, every file or symbol it names, any linked logs or ADRs, and the
target repository's `CLAUDE.md` and `.claude/rules/`. Classify it as one of:

- **work now**: the change is specified well enough to implement without a decision from the user.
- **defer**: needs hardware, needs data that does not exist yet, or needs a decision the user has
  not made. Record the one-line reason.
- **blocked on #N**: cannot start until another issue in the set lands. It joins that issue's
  stack, above it, and is sized like any other layer.

A closed issue in the set is deferred with the reason `already closed`.

## Step 4: Collision map

For every work-now issue, list the files and, where a file is large, the functions or regions
the change will touch. Then:

- Issues whose regions overlap, or where one is blocked on the other, form one **stack**. Order
  it bottom-up: the more foundational or higher-value change goes at the bottom, closest to the
  default branch. Each layer is its own draft PR based on the layer below.
- Issues whose regions are disjoint become **independent streams**.
- A dependency on another repository (a rename here that a hook there relies on) is written into
  the plan explicitly, with the other repo named. It is never silently absorbed into a stream.

## Step 5: Size each stream

Use `sizing.md` in this directory. Record model, effort, and a one-line reason per stream. A
stack is sized once, for its hardest layer, and every layer records the same values.

## Step 6: Ask, then propose

Before entering plan mode, ask the user every question the plan depends on with
`AskUserQuestion`: an ambiguous classification, a stack order that could go either way, a
cross-repo dependency they may want handled elsewhere. Ask them together, once.

Then check for an existing plan:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" show
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" finished
```

`show` exiting 1 with `no state file at ...` means there is no plan: carry on. Read the other two
exit-1 messages apart, because they end differently:

- **`state file is not valid workstreams JSON: ...`**: the file is corrupt. Say so, and ask the
  user whether to replace it; if they decline, stop. If they agree, carry on to Step 7 and use
  `--force`, which archives the corrupt file intact rather than destroying it. `finished` cannot
  answer for such a file, so do not run it.
- **`cannot read ...`**: the file is there and cannot be opened at all. Stop and show the message;
  it needs a person, and `--force` would archive a file nothing has read.

Exit 2 means neither `CLAUDE_PLUGIN_DATA` nor `WS_STATE_DIR` is set: stop and show the message.
If `show` exits 0 a plan exists, and `finished` says what kind:

- **`finished` exits 0**: every stream of the last run reached `done` or `failed`. Say that the
  previous run is finished and will be archived, and carry on without asking. There is nothing
  in it for the user to decide.
- **`finished` exits 3**: the run is still live, or a stream is `paused` waiting on an answer.
  Ask the user whether to replace it before going further; if they decline, stop.
- **`finished` exits anything else** (1: the file is missing, corrupt, or unreadable): that is a
  failure, not an answer about the plan. Stop and show its message. `show` has already separated
  those cases, so reaching this means the file changed under you.

Then `EnterPlanMode`, write the plan using `plan-template.md` in this directory, and
`ExitPlanMode`. The loop cadence in the plan is a number of seconds between 60 and 3600.

## Step 7: Record

Only after the plan is approved, since plan mode blocks writes, persist it:

`init` exits 3 for any plan it may not replace on its own, which includes a file at that path it
cannot parse: there is no plan in it to call finished, so it is treated as unfinished. `show` is
what says which of the two it is. Either way `--force` is the way forward, and it archives the
file intact rather than destroying it.

```bash
# --force only for an unfinished plan the user chose to replace: init archives a
# finished one itself and says on stderr where it went
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" init
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" \
  add-stream <id> --issues <n,n> --kind independent \
  --model <alias> --effort <level> --reason "<why this size>"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" \
  add-stream <id> --issues <n> --kind stack --stack <name> --order <n> [--base <branch>] \
  --model <alias> --effort <level> --reason "<why this size>"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" defer <issue> "<reason>"
# loop_delay is an integer from 60 to 3600; the script rejects anything else
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" meta loop_delay <seconds>
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" meta plan_path <path to the plan file>
```

Stream ids are short and stable: `s1`, `s2`, and so on, with stacked layers sharing a prefix
such as `s1a`, `s1b`. Every layer of a stack carries the same `--stack` name; `--order` is its
position from the bottom starting at 1; `--base` is the branch of the layer below, omitted for
the bottom layer. Effort is `low`, `medium`, or `high` (the agents that exist); the script
rejects anything else. If any command exits non-zero, stop and show its message rather than
continuing with a half-written plan.

Do not start any stream: that is `/workstreams:run`.
