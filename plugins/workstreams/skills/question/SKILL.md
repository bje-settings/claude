---
name: question
description: Turn a sweep report into an approved plan, one question at a time.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob EnterPlanMode ExitPlanMode
user-invocable: false
---

Scope: $ARGUMENTS. The effort name and tag line come from the
`_Recorded by <effort>, <date>._` line already on the round's issues. The milestone or issue
set comes from the sweep report.

Run this in the main conversation. `AskUserQuestion` is removed from every subagent
([sub-agents](https://code.claude.com/docs/en/sub-agents#available-tools)), so a subagent
reaches step 3 and cannot ask.

## Process

1. Read the sequencing comment the sweep posted. If there is none, say so, and stop.

2. Explore before you ask. For every open item the sweep names, open the file, the
   record (`docs/rfc`, `docs/adr`, the repository's own rules), or the docs it turns on.
   Say what they say. Grep for the claim. Do not recall it. A question whose answer is
   already in the tree is not a question. It is a ruling with a citation, and it goes in
   step 4.

3. Ask one question at a time. Ask only what is genuinely the human's to decide: scope,
   shape (layer count, one pull request or a stack), names that ship, what proves an
   acceptance line true, order against other efforts. The shape question states the review
   cost of each extra layer or pull request, from the sweep's size estimate.

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

7. After approval, check the round's issues once more:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" rounds --issues <n,n> --json`.
   Stop, and name the cause, when a round in flight now holds one of them, when
   `unavailable` is not empty, or when the command fails. Another session can have planned
   them first. Then post the plan comment. Its first line names it the plan:
   `<round> plan, approved <time>.`, with the approval time to the minute in UTC, for
   example `Round 15 plan, approved 2026-10-04T18:22Z.`. The time makes the line unique
   to this round. Trim the approved plan to its layers, with each layer's issues, branch, build model,
   review model and file set, and the one layer that changes each version line. Add the
   done condition, the review shape, and an estimate, as [plan-shape.md](plan-shape.md)
   sections 3 and 4 say. Post it on every issue in the round, and end it with the same
   `_Recorded by <effort name>, <date>._` line.

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

   Read each CI workflow's `pull_request` filter: Grep `.github/workflows/` in the root
   checkout for `pull_request`, and the `branches` or `branches-ignore` lines below it.
   The filter matches the base branch. In a GitHub stack, CI for the default branch runs on
   each layer. Without one, as when stacks are not enabled, an upper layer's base can get
   no `pull_request` CI. Then post one comment on each issue of the round. Name the layer,
   and give its order: merge the layer below, retarget this layer onto the branch it
   merged into, then CI runs.

   Note any open pull request of another effort that shares files with the round.

9. Report what was asked and answered, what was ruled instead and why, the rulings comment,
   the plan comment once approved, and what housekeeping found.
