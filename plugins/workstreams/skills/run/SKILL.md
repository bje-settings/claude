---
name: run
description: >
  Execute the workstreams plan written by /workstreams:plan: one subagent per stream working
  in its own worktree to a draft PR, stacked streams via gh-stack, a review pass on every draft
  that verifies and applies findings, all driven as a self-timed loop that checks progress on a
  cadence matched to the work. A paused stream never blocks the others. Ends with a report of
  every PR, deferred issue, and open question. Resumable: re-running picks up where the state
  file says the streams are.
allowed-tools: Bash, Read, Agent, ScheduleWakeup
disable-model-invocation: true
---

Run the workstreams recorded for this repository. The state file is the source of truth; every
transition below is written to it before the next action, so a stopped session can re-run this
skill and continue. If any `ws-state.sh` write fails, stop the loop and report the error: the
state is what the next tick reads, so continuing past a failed write would start work twice.

This skill runs in the main session. Only the main session schedules wakes; the workers and
the reviewer are subagents that return once and never schedule anything.

## Step 1: Preflight and load

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-preflight.sh
S="bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.sh"
$S show
```

Stop with the install hints if preflight exits 1, or with its stderr line if it exits 4. Stop
and say to run `/workstreams:plan` if there is no state file. If no stream is `planned`,
`running`, `draft`, or `reviewing`, skip to Step 5.

Read `meta.plan_path` for the plan document, and the target repository's `CLAUDE.md` and
`.claude/rules/` once now; the briefs below quote its conventions rather than inventing any.

## Step 2: Start the streams

A unit of work is one independent stream, or one whole stack: every layer record that shares
a `stack` name. For each unit whose streams are all `planned`, fill in `stream-prompt.md` from
this directory and start one worker with the `Agent` tool:

- `subagent_type`: `workstreams:stream-<effort>` where effort is the stream's recorded effort
  (a stack's layers all carry the same value).
- `model`: the stream's recorded model.
- The prompt is the filled brief. Independent units start together in one message. A stack's
  brief lists every layer in `order`, bottom-up, and the worker uses `gh stack` for the branches
  and PRs.

Then record it, for every stream in the unit:

```bash
$S set <id> status running
$S set <id> agent "<agent name or id>"
```

Do not create worktrees or branches yourself. The worker does that, following the target repo's
conventions, and reports the branch and worktree back.

## Step 3: Wait, then check

Call `ScheduleWakeup` with a delay in seconds between 60 and 3600, taken from
`meta.loop_delay`; if that is missing, use the plan's estimate of the longest stream. The wake
resumes this conversation, so its prompt is a plain instruction, not a skill invocation:
`Continue the workstreams run loop for <owner/repo> from Step 3 of the run skill.` Pass
`noop: true` when a tick changes no stream's state.

On each wake:

1. **Workers that returned.** Parse the fenced JSON block at the end of each result. For a stack
   the worker reports `stream` as the bottom layer's id and `prs` bottom-up; write `prs[i]` to
   the `pr` of the layer with `order` i+1, and apply the status to every layer.
   - `status: draft`: record `branch`, `worktree`, `pr` (`$S set <id> pr <n>`), set status `draft`,
     and go to Step 4.
   - `status: paused`: record `question`, set status `paused`. Tell the user the question in the
     tick's message. Never block on it; the other streams continue.
   - `status: failed`: record the error in `question`, set `attempts` to its current value plus
     one, set status `failed`. No automatic retry: the failure policy is out of scope for now.
   - No JSON block (the worker crashed, hit a limit, or returned prose): treat as `failed`, with
     the last lines of its output as the error.
2. **Streams still `running`** stay running. Do not message the worker to ask for progress.
3. If every stream is `done`, `paused`, or `failed`, go to Step 5. Otherwise schedule the next
   wake and end the turn.

## Step 4: Review pass

For a stream that just reached `draft`, or whose last review applied changes:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.sh <pr>
$S set <id> status reviewing
```

If `ws-pr-status.sh` fails, the worker reported a PR that does not exist: set the stream
`failed` with that message. Otherwise fill in `review-prompt.md` from this directory and start
`workstreams:reviewer` with `model` set to the stream's model. When it returns:

- `error` is set: set status `paused` with the error as the question. The review did not run.
- `applied > 0`: the diff changed, so the PR needs one more pass. Set status `draft`; it is
  reviewed again on the next tick.
- `applied == 0`: run `ws-pr-status.sh` again, since the checks may have moved, and decide on
  that output:
  - `checks: pass`: set status `done`.
  - `checks: pending`: leave status `reviewing` and check again next tick without a new review.
  - `checks: none`: the same as pending the first time, since workflows may not have queued yet;
    `done` if it is still `none` on the following tick.
  - `checks: fail`: set status `paused` with the question
    `CI is failing on PR #N after review; decide whether to fix, retry, or drop the stream`.

For a stack, review the layers bottom-up and do not start the review of a layer until the layer
below it is `done`; a change applied below changes what the layer above rebases onto.

## Step 5: Report

Print one report and stop the loop (`ScheduleWakeup` with `stop: true`):

- **Pull requests**, one line per stream, stacks grouped and listed bottom-up: PR number, title,
  checks, review decision.
- **Deferred issues** with their reasons, from `.deferred`.
- **Paused streams** with the exact question each is waiting on.
- **Failed streams** with the last error.

The PRs are drafts. Marking them ready and merging is the user's decision.
