---
name: question
description: Turn a sweep report into an approved plan. Look up the guidance for each open item, then ask the open decisions in frontier rounds.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob EnterPlanMode ExitPlanMode
user-invocable: false
---

Scope: $ARGUMENTS. The milestone or issue set comes from the sweep report.

Run this in the main conversation. `AskUserQuestion` is removed from every subagent
([sub-agents](https://code.claude.com/docs/en/sub-agents#available-tools)), so a subagent
reaches step 3 and cannot ask.

## Process

1. Read the sequencing comment the sweep posted. If there is none, say so, and stop.

2. Explore before you ask. For every open item the sweep names, open the file and the
   record (`docs/rfc`, `docs/adr`, the repository's own rules). Say what they say. Grep for
   the claim. Do not recall it.

   For every open item, look up the canonical guidance on what it turns on, in this order:

   - The installed package docs, for example `node_modules/<pkg>/docs` or a package's
     `AGENTS.md`. They match the version in use.
   - The official docs, fetched fresh.
   - The established community patterns.

   Then search for a recorded project deviation. Look for a code comment at the site, a
   context file (`CLAUDE.md`, a path-scoped rule), an ADR or an RFC. Then sort the item:

   - The guidance applies, and the project follows it: a ruling that cites the guidance.
   - The project deviates, and a record gives the reason: a ruling that cites the record.
   - The project deviates with no recorded reason, or two canonical sources disagree: a
     question. Its options cite the guidance and the deviation.
   - The decision is genuinely the person's (step 3): a question.

   Each ruling and each question cites its source. A question's description says what the
   guidance recommends, and the recommended option follows the guidance. A question whose
   answer is already in the tree is not a question. It is a ruling with a citation, and it
   goes in step 4. A decision that this step settles never enters the frontier.

3. Build a design tree from the decisions that are left. Each decision branches into the
   decisions that depend on it. The frontier is each decision whose prerequisites are
   settled.

   Ask only what is genuinely the person's to decide. That is scope, shape, names that ship,
   what proves an acceptance line true, and order against other efforts. Shape is the layer
   count, and one pull request or a stack. The shape question states the review cost of each
   extra layer or pull request, from the sweep's size estimate.

   Ask the whole frontier in each round. Use `AskUserQuestion`, with at most four questions
   in each call. A larger frontier takes more calls in the same round.

   Each question has two to four options, with the recommended option first and labelled.
   The argument against it goes in its own description. A question that depends on another
   question still open in this round goes to a later round. After the answers, compute the
   frontier again.

   Facts are your work, never the person's. Read a short fact yourself. For a fact that
   would fill the context, dispatch an `Explore` subagent. Ask the rest of the frontier while
   it runs. Only the questions that wait on that fact wait. Put its result through step 2
   before the next round.

   The phase is done when the frontier is empty. Each branch then has a visit, and no
   decision stays a silent assumption. A lookup that still runs keeps the frontier open.

4. Take the rulings that are cheap to reverse, rather than ask. Such a ruling is one that
   the person could reverse in one word. Record each one with what was chosen, and the
   argument for and against it, so the reversal costs nothing. A ruling takes its decision
   out of the frontier.

5. Post the rulings comment: one comment, on every issue in the round and on any issue a
   ruling touches. Number each ruling. End it:

   ```
   _Recorded by `workstreams:question` <date>._
   ```

6. Enter plan mode yourself (`EnterPlanMode`), and write the plan in the shape
   [plan-shape.md](plan-shape.md) sets out. `ExitPlanMode` is the approval, and the person's
   confirmation of the shared understanding. The human approves or edits the plan there.

7. After approval, check the round's issues once more:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" rounds --all --issues <n,n> --json`.
   Stop, and name the cause, when a round in flight now holds one of them, when
   `unavailable` is not empty, or when the command fails. Another session can have planned
   them first. Then post the plan comment. Its first line names it the plan:
   `<round> plan, approved <time>.`, with the approval time to the minute in UTC, for
   example `Round 15 plan, approved 2026-10-04T18:22Z.`. The time makes the line unique
   to this round. Trim the approved plan to its layers, with each layer's issues, branch, build model,
   review model and file set, and the one layer that changes each version line. Add the
   done condition, the review shape, and an estimate, as [plan-shape.md](plan-shape.md)
   sections 3 and 4 say. Post it on every issue in the round, and end it with the same
   ``_Recorded by `workstreams:question` <date>._`` line.

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

9. Report each frontier round, with what it asked and what the person answered. Report what
   was ruled instead and why, the rulings comment, the plan comment once approved, and what
   housekeeping found.
