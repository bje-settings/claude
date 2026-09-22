---
name: question
description: >
  Turn a sweep report into an approved plan, one question at a time. Explores every open
  item before asking, asks only what genuinely needs a human, with the recommended option
  first and the argument against it, records the rulings that are cheap to reverse instead
  of asking, hands back for plan mode, then posts the plan comment on every issue in the
  round once it is approved. Use it after /workstreams:sweep and before /workstreams:stream.
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion
disable-model-invocation: true
---

The sweep answered which issues are unblocked. This is the judgement over what to do about
it: reading, asking, and recording, never guessing at what only the human can decide.

Ask the caller for anything you were not given: the effort name and tag line that close the
rulings and plan comments, the milestone or issue set the round covers, and where the plan
file goes once the human writes one. Nothing here assumes this machine or this repository;
every repository-specific value is the caller's input.

## Step 1: preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight
```

Exit 1 means something is missing. Print each hint verbatim and stop.

## Step 2: read the sweep report

Read the sequencing comment the sweep posted. It is the input: the unblocked set, the next
tier, the file map, the collisions, the recommended shape with its argument, the sizing, and
the hidden dependencies, each already cited.

If there is none yet, run the command instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" sweep --json
```

Its JSON carries only the unblocked, next and blocked sets, the milestones, and the open pull
requests, none of the judgement steps 3 to 6 of `/workstreams:sweep` add. Run that skill first
if the file map, the collisions, the recommended shape, the sizing, or the hidden dependencies
are needed and no comment has been posted.

## Step 3: explore before asking

For every open item the sweep names: open the file, the record (`docs/rfc`, `docs/adr`, the
repository's own rules), or the docs it turns on, and say what they say. Grep for the claim;
do not recall it. A question whose answer is already in the tree is not a question, it is a
ruling with a citation, and it goes in step 5.

## Step 4: one question at a time

Only what is genuinely the human's to decide: scope, shape (layer count, one pull request or
a stack), names that ship, what proves an acceptance line true, order against other efforts.
Never ask "is this okay"; that is a request for permission over something already decided,
not a question.

`AskUserQuestion`, one question, two to four options, the recommended option first and
labelled, with the argument against it in its own description. Wait for the answer before
asking the next one.

## Step 5: rulings that are cheap to reverse

Take these rather than ask: anything the human could reverse in one word if they disagreed.
Record each with what was chosen and the argument for and against it, so the reversal costs
nothing. A ruling recorded without the argument against it is a decision hidden as a fact.

## Step 6: the rulings comment

One comment, posted on every issue in the round and on any issue a ruling touches. Number
each ruling. End it:

```
_Recorded by <effort name>, <date>._
```

Show the comment before posting it.

## Step 7: hand back for plan mode

Stop here and say so: the human enters plan mode next. The plan is one section per
primitive (what is left of the question phase, the stream with its layers, file sets and
sizing, the review loop per layer, the orchestrator's duties, an estimate, verification),
and `skills/stream/brief.md` is the template the plan feeds; name it so the human's plan
answers what that template needs.

## Step 8: after approval, the plan comment

Trim the approved plan to layers, file sets, sizing, the done condition, the review shape,
and an estimate. Post it as a comment on every issue in the round, ending with the same
`_Recorded by <effort name>, <date>._` line. Show it before posting.

## Step 9: housekeeping, before the first worktree

Ask the person to run `/gh:sync` (the `gh` plugin is a declared dependency; `preflight`
checks it) and to remove any ignored leftover under `plugins/` that a deletion left behind.

Then the hook preflight: detect a local hook that would run on every push, from
`core.hooksPath`, `.githooks/`, `.husky/`, `lefthook.yml`, or `.pre-commit-config.yaml`. If
one runs a full test suite:

- The repository's own records (its ADRs, its CI comments) say CI is the enforcement
  boundary: propose pointing `core.hooksPath` at an empty directory for the life of the
  round, with the human present to approve it, and restore it at close. This is a config
  change, never `--no-verify`.
- The records do not say so: ask this one question, with disabling it as the recommendation
  and the per-push cost stated.

Note any open pull request of another effort that shares files with the round; the sweep
already lists every open pull request.

## Step 10: report

What was asked and answered, what was ruled instead and why, the rulings comment, the plan
comment once approved, and what housekeeping found.
