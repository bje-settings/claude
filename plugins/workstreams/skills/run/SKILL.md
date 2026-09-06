---
name: run
description: >
  Execute the workstreams plan written by /workstreams:plan: one subagent per stream working
  in its own worktree to a draft PR, stacked streams via gh-stack, a review pass on every draft
  that verifies and applies findings, all driven as a self-timed loop that checks progress on a
  cadence matched to the work. A paused stream never blocks the others. Ends with a report of
  every PR, deferred issue, and open question. Resumable: re-running picks up where the state
  file says the streams are.
allowed-tools: Bash, Read, Skill, Agent, ScheduleWakeup
disable-model-invocation: true
---

Run the workstreams recorded for this repository. The state file is the source of truth; every
transition below is written to it before the next action, so a stopped session can re-run this
skill and continue. If any `ws-state.py` write fails, stop the loop and report the error: the
state is what the next tick reads, so continuing past a failed write would start work twice.

This skill runs in the main session, and the review of every draft runs here too:
`/pr-review-toolkit:review-pr` dispatches analyzer agents that wake the session that invoked it,
and a subagent that invoked it would have no wake to receive and nothing bounded to block on.
Only the main session schedules wakes; the workers and the appliers are subagents that return
once and never schedule anything.

## Step 1: Preflight and load

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-preflight.py"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" show
```

Stop with the install hints if preflight exits 1. Stop and say to run `/workstreams:plan` if
there is no state file. If no stream is `planned`, `running`, `draft`, or `reviewing`, skip to
Step 5.

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
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" set <id> status running
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" set <id> agent "<agent name or id>"
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
   - `status: draft`: record `branch`, `worktree`, and `pr` (`ws-state.py set <id> pr <n>`),
     set status `draft`, and go to Step 4.
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

Run for a stream that just reached `draft`, and once more for one whose last apply pass changed
the diff substantially. Start with the PR's current state:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.py" <pr>
```

Its exit status decides whether there is anything to review at all:

- **0**: carry on below.
- **1**: the pull request does not exist. Set the stream `failed` with the message. The worker
  reported a PR nobody can resolve, and no later tick changes that.
- **anything else** (4: gh itself failed, or answered with something the script could not read):
  set the stream `paused` with the message and leave the PR alone. A rate limit, an expired
  token, or a network blip reads exactly like this, and re-running the skill picks it up.

Then record the pass and review the PR yourself. `review_rounds` is the count of passes this
PR has had, kept on disk so a resumed session knows whether the round it is starting is the
repeat:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" set <id> status reviewing
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" set <id> review_rounds <its current value plus one>
```

1. **Review.** Invoke `/pr-review-toolkit:review-pr` on the PR. It runs in this session on
   purpose (see the note at the top).
2. **Read what is already on the PR.** A bot review or a human comment is a finding the toolkit
   will not produce, and one nobody else is going to act on:

   ```bash
   gh pr view <pr> --repo <owner/repo> --json reviews,comments
   gh api "repos/<owner>/<repo>/pulls/<pr>/comments"
   ```

   The first two give review bodies and issue comments, the third the inline review comments.
   Fold what they raise into the same list as the toolkit's findings.
3. **Verify every finding against the code.** A finding is a claim, not a fact, whoever made it.
   Open the file it names in the stream's worktree and confirm it before it goes any further.
   Drop a finding that is wrong, that is already handled elsewhere in the diff, that is out of
   scope for the issue the PR closes, or that contradicts the target repository's `CLAUDE.md` or
   rules. Keep the reason for each one dropped: it goes in the report.
4. **Apply.** If nothing survived verification, skip to the checks decision below with
   `applied` of 0. Otherwise fill in `apply-prompt.md` from this directory with the surviving
   findings, one numbered entry each, and start `workstreams:applier` with `model` set to the
   stream's model. The applier does not review; it applies the list and returns once.

When it returns:

- **`error` is set**: set status `paused` with the error as the question, and say in the tick's
  message which findings it had already applied. Some of the list may be committed.
- **`applied > 0`**: decide whether the change earns another round. Substantial means new or
  moved logic, a changed contract, a new file, or a fix large enough that a reviewer reading the
  PR fresh would reach different conclusions. Wording, a comment, a renamed test, or a one-line
  guard is not.
  - Substantial, and `review_rounds` is 1: set status `draft`, and the next tick reviews it
    again from the top of this step. A review that changed the diff that much reviewed a
    different PR than the one that now exists.
  - Substantial, and `review_rounds` is already 2: set the stream `paused` with the question
    `PR #<n> has applied substantial review changes twice; decide whether it needs a rethink or another pass`.
    One repeat is the limit: a PR that keeps growing under review is a sign the work was
    mis-scoped, not that a third pass will settle it.
  - Not substantial: fall through to the checks decision now, without another review.
- **`applied == 0`**: fall through to the checks decision.

The checks decision. Read the PR again, since the checks may have moved while the review ran,
and treat a non-zero exit exactly as above:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.py" <pr>
```

Then, on its output:

- `checks: pass`: set status `done`.
- `checks: pending`: leave status `reviewing` and look again next tick without a new review.
- `checks: none`: the same as pending the first time, since workflows may not have queued yet;
  `done` if it is still `none` on the following tick.
- `checks: fail`: set status `paused` with the question
  `CI is failing on PR #N after review (<failing>); decide whether to fix, retry, or drop the stream`,
  where `<failing>` is the `failing` list from the status output.

For a stack, review the layers bottom-up and do not start the review of a layer until the layer
below it is `done`; a change applied below changes what the layer above rebases onto.

## Step 5: Report

Print one report and stop the loop (`ScheduleWakeup` with `stop: true`):

- **Pull requests**, one line per stream, stacks grouped and listed bottom-up: PR number, title,
  checks, review decision.
- **Deferred issues** with their reasons, from `.deferred`.
- **Paused streams** with the exact question each is waiting on.
- **Findings rejected during review**, per PR, with the one-line reason each was dropped.
- **Failed streams** with the last error.

The PRs are drafts. Marking them ready and merging is the user's decision.
