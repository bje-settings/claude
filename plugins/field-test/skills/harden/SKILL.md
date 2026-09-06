---
name: harden
description: >
  Run the hardening loop for one skill against an ordered list of field-test targets: field-test
  it in each repository with /field-test:run, verify what it claimed against GitHub, fix the
  findings in one PR per round through a workstreams worker, review, merge, and move to the next
  target. Stops only when every target is clean or a finding needs a decision a person has to
  make. Resumable: the loop's state is on disk and re-running picks it up.
allowed-tools: Bash, Read, Skill, Agent, ScheduleWakeup, AskUserQuestion
disable-model-invocation: true
---

Invocation: `/field-test:harden <plugin:skill> --targets <repo-path>...`

Harden one skill against the repositories named in `--targets`, in the order given. Targets are
explicit: there is no discovery in this version, and a target list you did not write is a list
you cannot reason about.

This skill runs in the main session. Only the main session schedules wakes; the worker and the
reviewer are subagents that return once and schedule nothing. `S="bash ${CLAUDE_PLUGIN_ROOT}/scripts"`
below, and `H="$S/ft-harden-state.sh <plugin:skill>"`.

Write every transition to state **before** taking the next action. The state file is what a
resumed session reads; acting first and recording after is how the same fix gets made twice.

## Step 1: Preflight and set up

```bash
$S/ft-preflight.sh
$H init            # or read the existing run with: $H show
$H add-target <path> --repo <owner/name>    # once per target, in order
```

Stop with the install hints if preflight exits 1, or with its stderr line if it exits 4. If a run
already exists (`init` exits 3), show it and ask whether to resume it or start over with
`--force`; never `--force` on your own, since the targets already worked are what would be lost.

Read the repository conventions of each target once now: its `CLAUDE.md` and `.claude/rules/`
decide branch names, worktree locations, install commands, and commit style. The briefs below
quote them rather than inventing any.

## Step 2: Take the next target

```bash
TARGET="$($H next)"
```

Nothing printed means every target is finished: go to Step 7. A target whose status is already
`paused` comes back from `next` on purpose. Do not step over it: report its question and stop.

Otherwise `$H set "$TARGET" status running`, and work the phases below in order, writing
`$H set "$TARGET" phase <phase>` before each.

## Step 3: Field test (`phase field-test`)

Invoke `/field-test:run <plugin:skill>` with the `Skill` tool, running in the target directory.
That skill does the observing and the filing; this one records what came back:

```bash
$H set "$TARGET" issues '[<issue numbers it filed>]'
```

No findings and no issues: skip to Step 6 and summarise the target as clean.

## Step 4: Verify the report (`phase verify`)

The target skill's own final table is a claim. Write it to a report file
(`{"repo": "...", "prs": [{"number": N, "claimed": "merged|closed|open|skipped"}]}`;
`$S/ft-collect.sh <run-dir> --report` prints the table it ended with) and check it:

```bash
$S/ft-verify-report.sh <report.json>
```

Exit 1 means the report and GitHub disagree. Each mismatch is a finding like any other: render it
with `$S/ft-issue.sh render`, show it to the user, file it, and add it to `issues`. A report that
is wrong about what it merged is usually the most valuable finding of the round.

## Step 5: Fix, review, merge

**Fix** (`phase fix`). Fill in `fix-prompt.md` from this directory and start one worker with the
`Agent` tool: `subagent_type` `workstreams:stream-<effort>` and `model` from the run's state.
One worktree, one draft PR, closing every issue of the round. Record `$H set "$TARGET" pr <n>`.
If the worker returns `paused`, or the issues plainly do not fit one PR, set the target `paused`
with its question and stop the loop: that is a decision for a person.

**Review** (`phase review`). Fill in `review-prompt.md` and start `workstreams:reviewer` on the
PR. Repeat until a pass applies nothing. An `error` from the reviewer pauses the target with that
error; the review did not run, so nothing has been checked.

**Merge** (`phase merge`). Only once review applies nothing:

```bash
gh pr ready <n> --repo <repo>
gh pr merge <n> --repo <repo> --auto --<the repo's merge method from gh repo view>
$S/ft-wait-pr.sh <repo> <n> --timeout 540
```

Set the Bash tool's own `timeout` to `600000` for that wait: it blocks in the foreground on
purpose. Never arm a `Monitor` or a wake in place of it.

- `merged`: record `$H set "$TARGET" merge_sha <sha>` and go to Step 6.
- `passed`: auto-merge has not landed it yet. Wait again on the next tick.
- `pending`: schedule a wake at least 1200 seconds out and continue from here on return.
- `failed`: read the failure. A **mechanical** one (a lint rule, a spec the fix broke, a
  formatting check) goes back to the fix step **once**, with the failure quoted in the brief.
  Anything that would change behaviour pauses the target with the question. One retry, not a
  loop: a second mechanical failure on the same PR is a sign the fix is wrong, not unlucky.

## Step 6: Summarise the target (`phase summary`)

Fill in `summary-template.md`, store it with `$H set "$TARGET" summary "<text>"`, set the target
`done`, and go back to Step 2.

## Step 7: Report

Print every target's summary in one table, in order, then stop the loop with `ScheduleWakeup`
`stop: true`. Below the table: every paused target with the exact question it is waiting on, and
every issue filed that did not end up in a merged PR.

## Out of scope

Approving PRs; bypassing a check, a ruleset, or a required review; and deciding what counts as a
mechanical fix beyond the definitions `/gh:shepherd` already carries. This skill also does not
review PRs itself: `workstreams:reviewer` and `pr-review-toolkit` own that, and a second review
loop here would drift from theirs.
