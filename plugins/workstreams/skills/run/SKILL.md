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

This skill runs in the main session, and so does every review round it starts:
`/workstreams:review` invokes `/pr-review-toolkit:review-pr`, which dispatches analyzer agents
that wake the session that invoked it, and a subagent that invoked it would have no wake to
receive and nothing bounded to block on. Only the main session schedules wakes; the workers and
the appliers are subagents that return once and never schedule anything.

## Step 1: Preflight and load

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-preflight.py"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" reconcile
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" show
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" finished
```

Stop with the install hints if preflight exits 1.

`reconcile` runs before `show`, so what `show` prints is the plan as it now stands rather than one
already out of date. It asks GitHub about every pull request of a stream that is not finished: one
whose PR was merged becomes `done`, one whose PR was closed becomes `failed` with the reason. It is
what notices a PR merged outside this loop, in a browser or by another session, which nothing else
here would ever look at again. It prints the transitions it applied as a JSON array; report them
in this tick. Then, on its exit status:

- **4**: gh could not answer (a rate limit, an expired token, a number nothing resolves). Say so
  in this tick and carry on with what is on disk; nothing was written. Do not stop the loop over
  it.
- **1 saying `no state file at ...`**: there is no plan for this repository. Say to run
  `/workstreams:plan` and stop.
- **1 for any other reason** (a state file it cannot read or parse, a plan recording no usable
  repository, a write that failed): stop this tick and report the message. Unlike an exit 4, this
  is not a tick worth repeating: the file needs a person.
- **2**: neither `CLAUDE_PLUGIN_DATA` nor `WS_STATE_DIR` is set, so nothing here can find a state
  file at all. Report the message and stop the loop. `reconcile` runs first, so this is the
  command that reports it, but every command below fails the same way.

`show` reads the same file, so it fails the same way: exit 1 saying `no state file at ...` is the
only "there is no plan" answer. Any other exit 1, and exit 2, is a failure to report and stop on,
never a missing plan.

If the plan `show` prints has no streams, `init` wrote it and the first `add-stream` never landed:
`finished` calls that plan finished, so say to run `/workstreams:plan` and stop rather than
reporting and archiving an empty run.

Then `finished`: exit 0 means every stream is `done` or `failed`. Say the run is finished and go
straight to Step 5, which reports and archives it; schedule no wake. Exit 3 means there is work
left; if no stream is `planned`, `running`, `draft`, or `reviewing`, go to Step 5 as well. Any
other exit is a failure, not an answer about the plan (1 is a state file that is missing, corrupt,
or unreadable): report its message and stop the loop.

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

On each wake, starting with the same reconcile the tick above began with:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" reconcile
```

Its exit status is read exactly as in Step 1: 4 is reported in this tick and stepped over, an exit
1 saying `no state file at ...` means the plan is gone and the loop stops, any other exit 1 stops
this tick with its message, and exit 2 stops the loop. A pull request merged between two wakes is
only ever noticed here, so a tick that skipped it would keep reviewing work that had already
landed.

Report the transitions it printed in this tick, as Step 1 does, then re-read the plan before
working the numbered list below:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" show
```

A stream `reconcile` has just moved to `done` or `failed` is finished, whatever this session last
remembered about it. Work the list against what `show` prints, not against the statuses carried
over from the previous tick: dispatching a review for a stream whose PR merged between the wakes
is the mistake this prevents. Then:

1. **Workers that returned.** Parse the fenced JSON block at the end of each result. For a stack
   the worker reports `stream` as the bottom layer's id and `prs` bottom-up; write `prs[i]` to
   the `pr` of the layer with `order` i+1, and apply the status to every layer.
   - `status: draft`: record `branch`, `worktree`, and `pr` (`ws-state.py set <id> pr <n>`),
     set status `draft`, and go to Step 4.
   - `status: paused`: record `question`, set status `paused`. Tell the user the question in the
     tick's message. Never block on it; the other streams continue.
   - `status: failed`: record the error in `question`, count the attempt with
     `ws-state.py bump <id> attempts`, set status `failed`. No automatic retry: the failure
     policy is out of scope for now.
   - No JSON block (the worker crashed, hit a limit, or returned prose): treat as `failed`, with
     the last lines of its output as the error.
2. **Streams left `draft` or `reviewing` by an earlier session.** A session that stopped
   between two ticks leaves them there, and no worker returns to announce them again. Take each
   to Step 4, which reads on the status whether a round is due or only the checks are.
3. **Streams still `running`** stay running. Do not message the worker to ask for progress.
4. If every stream is `done`, `paused`, or `failed`, go to Step 5. Otherwise schedule the next
   wake and end the turn.

## Step 4: Review round

Entered for a stream whose status is `draft` (a round is due) or `reviewing` (its round is done
and the checks are what is left). A stack's layers are reviewed bottom-up, and a layer's round
does not start until the layer below it is `done`: a change applied below changes what the layer
above rebases onto.

Start with the PR's current state:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.py" <pr>
```

Its exit status decides whether there is anything to review at all:

- **0**: carry on below.
- **1**: the pull request does not exist. Set the stream `failed` with the message. The worker
  reported a PR nobody can resolve, and no later tick changes that.
- **anything else** (4: gh itself failed, answered with something the script could not read, or
  failed in a way nobody anticipated): leave the stream's status exactly as it is, put the
  message in this tick's report, and look again next tick. Do not pause it: Step 1 does not
  resume a paused stream, so pausing a stream over a rate limit, an expired token, or a network
  blip would strand it until somebody noticed by hand.

If the status is already `reviewing`, the round is done; skip to the checks decision.

**Record the round before running it.** `review_rounds` counts rounds *scheduled*, not rounds
finished, and it is on disk because the loop is resumable: a session that stops mid-round must
know that the round it is picking up was already counted.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" bump <id> review_rounds
```

Bump it only when it is `0`. At any other value the round about to run was already scheduled,
either by the substantial branch below or by the session that stopped, and counting it twice
would spend the one repeat on the first round.

**Run the round.** Invoke it with the `Skill` tool:

`/workstreams:review <pr> --worktree <the stream's worktree> --base <the stream's base branch> --model <the stream's model>`

`--base` is `main` for an independent stream and the branch of the layer below for a stack layer;
`--model` is the model this stream ran on, so the applier matches the worker.
The round runs in this session on purpose (see the note at the top). It reviews, verifies every
finding against the code, applies the ones that hold through a `workstreams:applier`, replies on
the threads, and returns one JSON block.

**Decide on what it returned.**

- **`error` is set, and `error_status` is 4**: gh itself failed inside the round. Leave the
  stream's status alone, report it in this tick, and look again next tick, the same as an exit 4
  from the status script above. Pausing here would strand the stream over a rate limit, which is
  the hazard the pre-check below exists to avoid.
- **`error` is set for any other reason**: set status `paused` with the error as the question, and
  say in the tick's message which findings it had already applied. Some of the list may be
  committed.
- **`pushed` is null**: nothing landed. Set status `reviewing` and fall through to the checks
  decision.
- **`pushed` is a range**: read `diffstat` from the round's block and let the size decide.

**The round rule.** Substantial or cosmetic is defined in `/workstreams:review`'s Return section,
next to the `diffstat` it is read off. It is not restated here: two copies of a judgement call
drift, and the round is the thing that produces the evidence.

- **Substantial, and `review_rounds` is 1**: schedule the repeat and stop here.

  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" bump <id> review_rounds
  ```

  The stream is already `draft` and stays `draft`, now with `review_rounds` 2, so the next tick
  brings it back to the top of this step and runs the second round without counting it again. A
  round that changed the diff that much reviewed a different PR than the one that now exists.
- **Substantial, and `review_rounds` is 2 or more**: set the stream `paused` with the question
  `PR #<n> has applied substantial review changes twice; decide whether it needs a rethink or another pass`.
  One repeat is the limit: a PR that keeps growing under review is a sign the work was mis-scoped,
  not that a third pass will settle it.
- **Cosmetic**: set status `reviewing` and fall through to the checks decision now, without
  another round.

**The checks decision.** Read the PR again, since the checks may have moved while the round ran:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-pr-status.py" <pr>
```

Its exit status is read exactly as above: 1 fails the stream, anything else non-zero is reported
in this tick and looked at again on the next one, with the stream left `reviewing`. Then, on its
output:

- `checks: pass`: set status `done`.
- `checks: pending`: leave status `reviewing` and look again next tick without a new round.
- `checks: none`: the same as pending the first time, since workflows may not have queued yet;
  `done` if it is still `none` on the following tick.
- `checks: fail`: set status `paused` with the question
  `CI is failing on PR #N after review (<failing>); decide whether to fix, retry, or drop the stream`,
  where `<failing>` is the `failing` list from the status output.

## Step 5: Report and archive

Print one report and stop the loop (`ScheduleWakeup` with `stop: true`):

- **Pull requests**, one line per stream, stacks grouped and listed bottom-up: PR number, title,
  checks, review decision.
- **Deferred issues** with their reasons, from `.deferred`.
- **Paused streams** with the exact question each is waiting on.
- **Findings rejected during review**, per PR, with the one-line reason each was dropped.
- **Failed streams** with the last error.

Then archive the run, but only if it is over:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" finished
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ws-state.py" archive
```

Run `archive` only when `finished` exits 0, and print the path it prints so the user knows where
the record went. Exit 3 means the run is not over: leave the file where it is. Any other exit is a
failure to report and stop on. A run holding a `paused` stream is not finished: its file stays
where it is, so the user can answer the question and re-run this skill. Never pass `--force` here;
a plan that is not finished is one the next run still needs.

The PRs are drafts. Marking them ready and merging is the user's decision.
