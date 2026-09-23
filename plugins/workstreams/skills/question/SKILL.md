---
name: question
description: Turn a sweep report into an approved plan, one question at a time.
argument-hint: [milestone]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob AskUserQuestion Skill EnterPlanMode ExitPlanMode
user-invocable: false
---

Round: $ARGUMENTS. The effort name and tag line come from the `_Recorded by <effort>, <date>._`
line already on the round's issues; the milestone or issue set comes from the sweep report.

Run this in the main conversation. `AskUserQuestion` is removed from every subagent
([sub-agents](https://code.claude.com/docs/en/sub-agents#available-tools)), so a subagent
reaches step 4 and cannot ask.

## Process

1. Preflight.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight
   ```

   Exit 1 means something is missing. Print each hint verbatim and stop.

2. Read the sequencing comment the sweep posted.

   If there is none yet, invoke `/workstreams:sweep` (the `Skill` tool) with the same
   milestone or issue set. If it stops before posting one (its own preflight, an incomplete
   read, or nothing unblocked), report what it returned and stop here too. Otherwise its own
   last step continues into the question phase itself, so once it returns the round has
   already been questioned and planned: stop here rather than repeating steps 3 onward.

3. Explore before asking. For every open item the sweep names: open the file, the record
   (`docs/rfc`, `docs/adr`, the repository's own rules), or the docs it turns on, and say
   what they say. Grep for the claim; do not recall it. A question whose answer is already
   in the tree is not a question, it is a ruling with a citation, and it goes in step 5.

4. Ask one question at a time. Only what is genuinely the human's to decide: scope, shape
   (layer count, one pull request or a stack), names that ship, what proves an acceptance
   line true, order against other efforts.

   `AskUserQuestion`, one question, two to four options, the recommended option first and
   labelled, with the argument against it in its own description. Wait for the answer before
   asking the next one.

5. Take the rulings that are cheap to reverse rather than ask: anything the human could
   reverse in one word if they disagreed. Record each with what was chosen and the argument
   for and against it, so the reversal costs nothing.

6. Post the rulings comment: one comment, on every issue in the round and on any issue a
   ruling touches. Number each ruling. End it:

   ```
   _Recorded by <effort name>, <date>._
   ```

7. Enter plan mode yourself (`EnterPlanMode`) and write the plan in the shape
   [plan-shape.md](plan-shape.md) sets out. `ExitPlanMode` is the approval: the human approves
   or edits the plan there.

8. After approval, post the plan comment. Trim the approved plan to layers, file sets,
   sizing, the done condition, the review shape, and an estimate. Post it as a comment on
   every issue in the round, ending with the same `_Recorded by <effort name>, <date>._`
   line.

9. Housekeeping, before the first worktree.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight --json
   ```

   Read `optional` for `gh`. Present: ask the person to run `/gh:sync`. Absent: fast-forward
   the default branch yourself (`git -C <repository root> pull --ff-only`) and go on. Remove
   any ignored leftover under `plugins/` that a deletion left behind.

   Then the hook preflight, gated on one question: does a local hook run a full test suite
   on every push? Detect it from `core.hooksPath`, `.githooks/`, `.husky/`, `lefthook.yml`,
   or `.pre-commit-config.yaml`. If one does:

   - The repository's own records (its ADRs, its CI comments) say CI is the enforcement
     boundary: propose pointing `core.hooksPath` at an empty directory for the life of the
     round, with the human present to approve it, and restore it at close. This is a config
     change, never `--no-verify`.
   - The records do not say so: ask this one question, with disabling it as the
     recommendation and the per-push cost stated.

   Note any open pull request of another effort that shares files with the round.

10. Report what was asked and answered, what was ruled instead and why, the rulings comment,
    the plan comment once approved, and what housekeeping found.
