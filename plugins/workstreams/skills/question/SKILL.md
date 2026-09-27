---
name: question
description: Turn a sweep report into an approved plan, one question at a time.
argument-hint: [milestone]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob AskUserQuestion Skill EnterPlanMode ExitPlanMode
user-invocable: false
---

Round: $ARGUMENTS. The effort name and tag line come from the `_Recorded by <effort>,
<date>._` line already on the round's issues. The milestone or issue set comes from the
sweep report.

Run this in the main conversation. `AskUserQuestion` is removed from every subagent
([sub-agents](https://code.claude.com/docs/en/sub-agents#available-tools)), so a subagent
reaches step 3 and cannot ask.

## Process

1. Read the sequencing comment the sweep posted.

   If there is none yet, invoke `/workstreams:sweep` (the `Skill` tool) with the same
   milestone or issue set. If it stops before it posts one, for an incomplete read or
   nothing unblocked, report what it returned, and stop here too. Otherwise its own
   last step continues into the question phase itself. Once it returns, the round has
   already been questioned and planned. Stop here rather than repeat steps 2 onward.

2. Explore before you ask. For every open item the sweep names, open the file, the
   record (`docs/rfc`, `docs/adr`, the repository's own rules), or the docs it turns on.
   Say what they say. Grep for the claim. Do not recall it. A question whose answer is
   already in the tree is not a question. It is a ruling with a citation, and it goes in
   step 4.

3. Ask one question at a time. Ask only what is genuinely the human's to decide: scope,
   shape (layer count, one pull request or a stack), names that ship, what proves an
   acceptance line true, order against other efforts.

   Use `AskUserQuestion`: one question, two to four options, the recommended option
   first and labelled, with the argument against it in its own description. Wait for
   the answer before you ask the next one.

4. Take the rulings that are cheap to reverse, rather than ask: anything the human
   could reverse in one word, if they disagreed. Record each one with what was chosen,
   and the argument for and against it, so the reversal costs nothing.

5. Post the rulings comment: one comment, on every issue in the round and on any issue a
   ruling touches. Number each ruling. End it:

   ```
   _Recorded by <effort name>, <date>._
   ```

6. Enter plan mode yourself (`EnterPlanMode`), and write the plan in the shape
   [plan-shape.md](plan-shape.md) sets out. `ExitPlanMode` is the approval. The human
   approves or edits the plan there.

7. After approval, post the plan comment. Trim the approved plan to layers, file sets,
   size, the done condition, the review shape, and an estimate. Post it as a comment on
   every issue in the round. End it with the same `_Recorded by <effort name>, <date>._`
   line.

8. Housekeeping, before the first worktree.

   Read your own skill listing. If `/gh:sync` is in it, ask the person to run it.
   If not, fast-forward the default branch yourself: `git -C <repository root> fetch
   origin <default branch>:<default branch>`. This only ever fast-forwards a named
   ref, and refuses otherwise; say so if it refuses. Then continue. Remove any ignored
   leftover under `plugins/` that a deletion left behind.

   Then run the hook preflight, gated on one question: does a local hook run a full
   test suite on every push? Detect it from `core.hooksPath`, `.githooks/`, `.husky/`,
   `lefthook.yml`, or `.pre-commit-config.yaml`. If one does:

   - When the repository's own records (its ADRs, its CI comments) say CI is the
     enforcement boundary: propose that `core.hooksPath` point at an empty directory
     for the life of the round, with the human present to approve it, and restore it
     at close. This is a config change, never `--no-verify`.
   - When the records do not say so: ask this one question, with disabling the hook as
     the recommendation, and the per-push cost stated.

   Note any open pull request of another effort that shares files with the round.

9. Report what was asked and answered, what was ruled instead and why, the rulings comment,
   the plan comment once approved, and what housekeeping found.
