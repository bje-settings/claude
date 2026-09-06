# workstreams

Turn a set of GitHub issues into parallel workstreams run by subagents, each ending in a
reviewed draft PR. Two skills: `/workstreams:plan` proposes the streams; `/workstreams:run`
executes them. Each skill directory has a `FLOW.md` with the decision diagram.

## Requirements

Checked by a preflight script before either skill does anything; each missing piece is reported
with its install command.

| Requirement | Install |
| --- | --- |
| `gh`, logged in | `brew install gh && gh auth login` |
| `jq` | `brew install jq` |
| `gh-stack` extension | `gh extension install github/gh-stack` |
| `gh-stack` skill | `gh skill install github/gh-stack --agent claude-code` |
| `pr-review-toolkit` plugin | `/plugin install pr-review-toolkit@claude-plugins-official` |

The target repository's own `CLAUDE.md` and `.claude/rules/` decide branch names, worktree
locations, dependency install, and commit conventions. The skills read and obey those rather
than carrying their own.

## `/workstreams:plan <selectors>`

Selectors, in any mix: issue numbers (`12`, `#12`, `10-14`), `label:<name>`,
`milestone:<title>`, or free words joined into one search.

1. Preflight.
2. Resolve the selectors to issues.
3. Evaluate each issue against its code, logs, and the repo's conventions. Classify it as
   *work now*, *defer* (with a reason), or *blocked on another issue*.
4. Map the files each work-now issue touches. Overlaps become a stack, foundational change at the
   bottom; disjoint changes become independent streams. Cross-repo dependencies are named.
5. Size each stream: model and effort, with a reason (see `skills/plan/sizing.md`).
6. Ask the user every question the plan depends on, propose the plan in plan mode, and once it
   is approved record it in the state file.

Nothing is started. An existing plan is only replaced when the user says so.

## `/workstreams:run`

1. Preflight, load the state.
2. Start one subagent per planned stream (`workstreams:stream-<effort>`, model per stream). Each
   works in its own worktree and opens a draft PR. A stack is one subagent working its layers
   bottom-up with `gh stack`.
3. Check progress on a cadence matched to the work (`ScheduleWakeup`), not a fixed short
   interval. A stream that needs a decision pauses with its question; the others continue.
4. Review every draft with `workstreams:reviewer`, which runs `/pr-review-toolkit:review-pr`,
   verifies each finding against the code, applies the ones that hold, and refreshes the PR title
   and body if they went stale. A PR is re-reviewed until a pass applies nothing, then its checks
   decide: pass is done, pending waits, fail pauses the stream with a question.
5. Report every PR (stacks in order), every deferred issue with its reason, every paused stream
   with its question, and every failure.

The PRs stay drafts. Marking ready and merging is the user's decision.

## State and resuming

One state file per repository at `${CLAUDE_PLUGIN_DATA}/<owner>__<repo>.json`, written by
`scripts/ws-state.py`. `/workstreams:run` reads stream statuses from it, so a session that stops
mid-run can re-run the skill and continue. `ws-state.py show` prints it.

Stream statuses: `planned`, `running`, `draft`, `reviewing`, `paused`, `done`, `failed`. A stack
is several stream records sharing a `stack` name, ordered from the bottom; the run skill treats
it as one unit of work.

## Scripts

All deterministic. `ws-state.py` is Python (stdlib only, 3.9 floor), tested under
`tests/workstreams/`; the rest are bash 3.2, spec'd under `spec/workstreams/`.

| Script | Purpose |
| --- | --- |
| `ws-preflight.sh` | Dependency check; JSON `{ok, missing[]}` with install hints |
| `ws-issues.sh` | Selectors to a JSON array of issues, with `#N` references extracted |
| `ws-state.py` | Atomic read/write of the state file; validates fields, statuses, efforts, models, and the `loop_delay` range |
| `ws-pr-status.sh` | One PR reduced to draft state, base, head, mergeability, folded checks, review decision |

## Out of scope for now

A failure policy (what happens when a stream's PR fails CI repeatedly) and sub-streams. The state
file carries `attempts` and `failed` so a later change can add them.
