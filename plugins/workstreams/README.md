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
4. Review every draft in the main session: run `/pr-review-toolkit:review-pr`, read the PR's own
   bot and human review comments, and verify every finding against the code before acting on it.
   The ones that hold go to a `workstreams:applier` subagent as a list, which commits them, runs
   the tests, pushes, and refreshes the PR title and body if they went stale. A substantial round
   of changes earns one more review; then the checks decide: pass is done, pending waits, fail
   pauses the stream with a question.

   The review runs in the main session because `/pr-review-toolkit:review-pr` dispatches analyzer
   agents that wake whoever invoked it, and a subagent gets no such wake.
5. Report every PR (stacks in order), every deferred issue with its reason, every paused stream
   with its question, and every failure.

The PRs stay drafts. Marking ready and merging is the user's decision.

## State and resuming

One state file per repository at `${CLAUDE_PLUGIN_DATA}/<owner>__<repo>.json`, written by
`scripts/ws-state.py`. `/workstreams:run` reads stream statuses from it, so a session that stops
mid-run can re-run the skill and continue. `ws-state.py show` prints it.

Stream statuses: `planned`, `running`, `draft`, `reviewing`, `paused`, `done`, `failed`. A stack
is several stream records sharing a `stack` name, ordered from the bottom; the run skill treats
it as one unit of work. `review_rounds` counts the review passes a stream's PR has had, so a
resumed session knows whether the round it is starting is the repeat.

## Scripts

All deterministic, all Python (stdlib only, 3.9 floor), tested under `tests/workstreams/`.
`scripts/lib/` holds what they share: `cli.py` for output encoding, exit statuses and the
broken-pipe case, and one module each for the scripts whose decisions are worth naming (`state.py`,
`issues.py`, `pr_status.py`, `pr_comments.py`). `ws-preflight.py` keeps its checks inline.

| Script | Purpose |
| --- | --- |
| `ws-preflight.py` | Dependency check; JSON `{ok, missing[]}` with install hints |
| `ws-issues.py` | Selectors to a JSON array of issues, with `#N` references extracted |
| `ws-state.py` | Atomic read/write of the state file; validates fields, statuses, efforts, models, and the `loop_delay` range |
| `ws-pr-status.py` | One PR reduced to draft state, base, head, mergeability, folded checks, review decision. Exits 1 when the PR does not exist and 4 when gh itself failed, so the run loop can fail a stream permanently on the first and pause it on the second |
| `ws-pr-comments.py` | One PR's reviews, issue comments, and review threads as one flat list, each entry saying whether its author is a bot and whether its thread is resolved |

## Out of scope for now

A failure policy (what happens when a stream's PR fails CI repeatedly) and sub-streams. The state
file carries `attempts` and `failed` so a later change can add them.
