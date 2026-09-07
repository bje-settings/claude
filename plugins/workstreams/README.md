# workstreams

Turn a set of GitHub issues into parallel workstreams run by subagents, each ending in a
reviewed draft PR. Three skills: `/workstreams:plan` proposes the streams, `/workstreams:run`
executes them, and `/workstreams:review` runs one review round over a draft PR. Each skill
directory has a `FLOW.md` with the decision diagram.

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
4. Review every draft with `/workstreams:review`, in this session. It reviews, verifies, applies
   and replies; the run loop counts the round in `review_rounds`, reads the diffstat of what the
   round pushed, and decides what is next. A substantial delta earns exactly one repeat; a second
   substantial round pauses the stream; a cosmetic one falls through to the checks, where pass is
   done, pending waits, and fail pauses the stream with a question.
5. Report every PR (stacks in order), every deferred issue with its reason, every paused stream
   with its question, and every failure.

## `/workstreams:review <pr> --worktree <path> --base <branch> [--model <alias>]`

One review round over one draft PR, and nothing else: no loop, no state file, no wake.

1. Read the PR with `ws-pr-status.py`.
2. Run `/pr-review-toolkit:review-pr` on the PR, in its worktree, over `<base>...HEAD`. Naming the
   range matters: left to itself the toolkit reviews the working tree's `git diff`, which in the
   calling session is very likely another repository's, or nothing at all.
3. Read the reviews, comments, and review threads already on the PR with `ws-pr-comments.py`. A
   bot review or a human comment is a finding the toolkit will not produce and nobody else will
   act on.
4. Verify every finding against the code. A finding is a claim, not a fact, whoever made it.
5. Hand what holds to a `workstreams:applier` subagent, which commits, runs the tests, pushes, and
   refreshes a stale title or body.
6. Reply on every bot or human thread a finding came from, saying applied, already addressed at
   the path where the diff satisfies it, or rejected and why. Threads are never resolved: that
   judgement is the reviewer's.

It returns which findings it applied, which the diff already satisfied, which it rejected and why,
the range it pushed and the `git diff --stat` of it, and the exit code behind any error it hit.
What counts as a substantial round rather than a cosmetic one is defined here, next to that
diffstat, and both callers cite it rather than restating it. It runs
in the session that invoked it, never in a subagent, because `/pr-review-toolkit:review-pr`
dispatches analyzer agents that wake whoever invoked them, and a subagent gets no such wake
(issue #62).

The PRs stay drafts. Marking ready and merging is the user's decision.

## State and resuming

One state file per repository at `${CLAUDE_PLUGIN_DATA}/<owner>__<repo>.json`, written by
`scripts/ws-state.py`. `/workstreams:run` reads stream statuses from it, so a session that stops
mid-run can re-run the skill and continue. `ws-state.py show` prints it.

Stream statuses: `planned`, `running`, `draft`, `reviewing`, `paused`, `done`, `failed`. A stack
is several stream records sharing a `stack` name, ordered from the bottom; the run skill treats
it as one unit of work. `review_rounds` counts the review rounds *scheduled* on a stream's PR, so
a session that stops mid-round knows the round it is picking up was already counted; `draft` means
a round is due and `reviewing` means the round is done and only the checks are left.

## Scripts

All deterministic, all Python (stdlib only, 3.9 floor), tested under `tests/workstreams/`.
`scripts/lib/` holds what they share: `cli.py` for output encoding, exit statuses and the
broken-pipe case, and one module each for the scripts whose decisions are worth naming (`state.py`,
`issues.py`, `pr_status.py`, `pr_comments.py`). `ws-preflight.py` keeps its checks inline.

| Script | Purpose |
| --- | --- |
| `ws-preflight.py` | Dependency check; JSON `{ok, missing[]}` with install hints |
| `ws-issues.py` | Selectors to a JSON array of issues, with `#N` references extracted |
| `ws-state.py` | Atomic read/write of the state file; validates fields, statuses, efforts, models, and the `loop_delay` range. `bump` adds one to a numeric field, so no caller counts by hand |
| `ws-pr-status.py` | One PR reduced to draft state, base, head, mergeability, folded checks, review decision. Exits 1 when the PR does not exist and 4 when gh itself failed, so the run loop can fail a stream permanently on the first and, on the second, leave its status alone and look again next tick rather than strand it over a rate limit |
| `ws-pr-comments.py` | One PR's reviews, issue comments, and review threads as one flat list, each entry saying whether its author is a bot and whether its thread is resolved |

## Out of scope for now

A failure policy (what happens when a stream's PR fails CI repeatedly) and sub-streams. The state
file carries `attempts` and `failed` so a later change can add them.
