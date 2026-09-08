# Spike: running `plan` and `run` without the per-repo state file

Issue [#65](https://github.com/bje-settings/claude/issues/65). Five options, one recommendation,
and the follow-up it leaves open.

## Context

`ws-state.py` writes one file per repository at
`${WS_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/<owner>__<name>.json`. It holds the streams (issues, stack
name and order, model, effort, status, PR numbers, branch, worktree, agent, question, attempts,
`review_rounds`), the deferred issues with their reasons, and `meta` (`loop_delay`, `plan_path`).
`/workstreams:run` reads it at the top of every tick and writes each transition before taking the
next action; `/workstreams:plan` refuses to overwrite it without `--force`.

Three things went wrong while dogfooding the plugin on issues #25 and #32 (PRs #44 and #45):

1. A finished run outlived itself. The next `/workstreams:plan` found a file where every stream
   was `done` and asked whether to replace it, as if a run were in progress.
2. `/workstreams:run` on a finished file did nothing but print the previous report.
3. PRs merged outside the loop (in a browser, in another session, by `/field-test:harden`) never
   came back through the loop, so the plan said `reviewing` for work that had landed.

None of the three is a bug in what the file holds. All three are the file having no lifecycle: it
is created, and after that it is only ever updated.

Beside them sits the deeper question the issue asks. The file is not the source of truth for
anything in it: the issues, pull requests, branches, worktrees, and check results all live on
GitHub or in git. So could the loop derive its state instead, keeping at most a pointer to the
plan?

Each option below answers the same five questions:

- **Resume**: what a session that stopped mid-run has to read to continue.
- **Crash gap**: what happens when a worker dies between creating a branch and opening a PR.
- **Stack order**: how a stack's bottom-up ordering is recovered.
- **`harden`**: whether `/field-test:harden`, which mirrors this pattern in `ft-harden-state.py`,
  follows the same answer.
- **Python port**: how it interacts with the port of the plugin scripts to Python.

The port is not a future consideration any more: `ws-state.py` and the rest landed in #79 and #83,
so whatever this spike recommends is written in Python, against a suite that measures it by branch.
That is a point in favour of any option that keeps decisions in a script rather than in a skill's
prose.

## Option 1: derive everything

The plan document is the only input. Stream status comes from GitHub: no branch means `planned`, a
branch with no PR means `running`, a draft PR means `draft` or `reviewing`, an open PR with some
review-pass marker means `reviewing`, and the checks decide `done`.

- **Resume**: the plan document, then one branch listing and one PR query per stream, plus
  whatever protocol carries the rest.
- **Crash gap**: this is where it fails today. A worker that has created a branch and not pushed
  is indistinguishable from one that was never started, so a resumed session dispatches a second
  worker onto the same issue. Two workers, two worktrees, two PRs, one issue.
- **Stack order**: parsed back out of the plan document's markdown table, or re-derived from each
  PR's base branch. Both work only while nothing has been rebased.
- **`harden`**: it has the same gap in a sharper form, since its phases (`verify`, `fix`,
  `review`, `merge`) are not visible on GitHub at all.
- **Python port**: a rewrite of both skills and new scripts, on top of the port already done.

Three things have no derivation at all. `review_rounds` and the one-repeat rule are a count of what
this loop did, which GitHub does not record. `paused` and its question are a decision waiting for a
person. `agent` is a session-local id. Carrying them would mean a label or comment protocol on
GitHub, which is state on a shared surface under another name (see option 3).

The stateless `/workstreams:review` skill is the evidence for both halves of this. It derives
everything it needs about a PR each time it runs -- the diff, the threads, the checks -- and holds
nothing, and it is the better skill for it. It also shows the boundary: it cannot tell you which
round it is, whether anyone is paused, or whether a worker is already running, so the caller passes
those in.

**Not viable today.** Worth revisiting if a worker ever announces itself on GitHub before it
starts (a draft PR opened empty at the top of the run would close the crash gap).

## Option 2: state in the target repository

The same file, moved under the repository being worked on (`.claude/workstreams/`, or the
worktree).

- **Resume**: identical to today; only the path changes.
- **Crash gap**: identical to today.
- **Stack order**: identical to today.
- **`harden`**: it has no single target repository -- a hardening run spans several -- so it could
  not follow.
- **Python port**: no interaction.

It solves none of the three symptoms, and it adds a problem per target repository: an ignore rule
in each, or a dirty working tree, plus a question about where the file lives when the work happens
in a worktree.

**Rejected.**

## Option 3: state on GitHub

A tracking issue with a checklist, a milestone, or a GitHub Project as the run record, with each
stream a sub-issue or a task line.

- **Resume**: read the tracking issue.
- **Crash gap**: closable, since the tracking issue can record "worker dispatched" before the
  worker starts, which is the fact GitHub does not otherwise hold.
- **Stack order**: the order of the checklist, or the sub-issue order.
- **`harden`**: could follow, and would gain the most, since its state is the least derivable.
- **Python port**: additive, not a rewrite.

This is the right long-term answer for the thing none of the others give: visibility. A second
machine, or a teammate, can see that a run exists and where it got to. Two things stop it being
the answer now. It needs the GitHub Projects and sub-issues skill from #1, which does not exist
yet. And it writes a private experiment onto a shared surface: a plan that classified someone's
issue as "defer, needs a decision the user has not made" is a note to self, not a comment to
publish on their repository.

**Recorded as the follow-up.**

## Option 4: keep the file, fix its lifecycle

Give the file the lifecycle it never had, and reconcile it against GitHub at the top of each tick.

- `finished`: every stream `done` or `failed`. A `paused` stream is not finished -- the user owes
  an answer.
- `plan` treats a finished file as absent: it archives it and carries on, without asking. Only an
  unfinished plan is a question for the user.
- `run` archives the file after its final report, and stops rather than reprinting an old one.
- `reconcile` asks GitHub about every pull request of a stream that is not finished: merged marks
  the stream `done`, closed marks it `failed` with the reason.

- **Resume**: the state file, as today, now reconciled against GitHub before it is read.
- **Crash gap**: unchanged and closed the way it already is -- the file records `running` and the
  agent before the worker is dispatched, so a resumed session knows a worker was started.
- **Stack order**: unchanged; `stack` and `order` are on each stream record.
- **`harden`**: yes, and lifecycle only. Its merge phase already records `merge_sha`, so it has
  the equivalent of `reconcile` built into the phase that would need it; what it lacks is
  `finished` and `archive`.
- **Python port**: lands as three pure functions in `lib/state.py` and three commands on
  `ws-state.py`, each with a test per arm. No skill rewrite, no change to what a worker reports.

It fixes all three symptoms directly, it is small, and it is consistent with the standing rule in
this repository's `CLAUDE.md` that plugin state lives under `${CLAUDE_PLUGIN_DATA}`. Its cost is
the one the issue names: the file is still invisible from the repository, and it can still drift
from GitHub between reconciles.

**Recommended.**

## Option 5: `plan_path` as the whole file

Keep only a pointer to the plan document, and read the streams table out of the markdown.

- **Resume**: parse the plan document.
- **Crash gap**: as option 1, unresolved.
- **Stack order**: parsed out of the table.
- **`harden`**: no plan document to point at.
- **Python port**: a markdown table parser, which is new surface with no source of truth behind
  it.

The plan lives under `~/.claude/plans/`, so it is exactly as invisible from the repository as the
state file is: the visibility argument for moving does not apply. Parsing a table a skill wrote in
prose is fragile in a way JSON written by a script is not, and per-stream status has nowhere to go
in it anyway.

**Rejected.** No gain over option 4.

## Recommendation

Take option 4 now, and record option 3 as the follow-up.

Option 4 is accepted as the minimal correct lifecycle for a file that already exists, not as an
endorsement of on-disk state. The standing preference is to derive what a plugin needs each time it
runs; state on disk is a last resort, and a plugin that writes any owns its whole lifecycle --
creation, resume, reconcile against the source of truth, and archive or removal when it is
finished. That is what this change gives the workstreams file, and the direction of the follow-up
(option 3) is toward deriving more of it, not toward storing more. Whatever replaces it must also
work on any machine and any repository layout: the state directory resolves from `WS_STATE_DIR` or
`CLAUDE_PLUGIN_DATA` and the archive sits inside it, so nothing here depends on how one machine
happens to be arranged.

## Follow-up

Option 3, once the GitHub Projects and sub-issues skill from #1 exists, and once there is an answer
to publishing a private plan on a shared repository (an opt-in, or a tracking issue on the
plugin's own repository rather than the target's).
