# The round end

Do this once, when every pull request of the round is `done`, merged, or dropped. A
dropped layer closed with no merge, and the person dropped it ([tick.md](tick.md) step 4).
Nothing merges: the person merges.

## 1. Read once more

Run `intersect`. The root checkout and each worktree of the round are clean. Each head is
the head that its review reached `done` on. Skip this read for a merged or closed pull
request.

## 2. The merge sequence and the open items

Recommend the merge sequence from `intersect` and `gh stack view --json`, for the pull
requests that are open. When none is open, skip to the open items.

- **Order.** A stack merges bottom to top, as one: `gh stack merge`. Parallel streams merge
  in the order of the fewest conflicts against the default branch.
- **Retargets.** Name each pull request whose base is a branch that merges before it. It
  moves to the default branch when that branch merges.
- **Expected rebase conflicts.** Each conflict path under `againstDefault`, each pair with
  a `conflict` result, and each head with `behind` above 0.

The open items, by the part of step 4 that holds them:

- Part 2: each mid-round ruling that is cheap to reverse, and each choice that a stream
  or a review made in place of a question.
- Part 3: each defect that a mid-round ruling kept for later.
- Part 4: each change of scope that the round found for an issue outside it.
- Part 5: each `lower_layer` finding not applied, each open bot thread
  (`botThreadAuthors` from `pr-state`), each plan issue still open after its pull request
  merged, and each dropped layer, with its issues.

## 3. The cost

One table row for each agent the round dispatched, from its completion notification. Give
the agent, its pull request and round, its model, tokens, tool uses, and duration. Add the
totals, and the elapsed time from the first dispatch to now. Idle time is not in any
notification. Say so, and give the sum of agent minutes instead.

For each pull request, the lines changed:

```bash
gh pr view <number> --json additions,deletions
```

Name each agent with no notification in this conversation, such as after a clear. Its row
gets the lines changed, and `not recorded` in each other cell. Estimate nothing.

## 4. Report, ask, act and record

Stop the watch with `TaskStop`, if one runs. Then report to the person in these six
parts, in this order:

1. **State.** Each pull request with its head and state. Then the merge sequence.
2. **Decisions the model made.** Each mid-round ruling and each choice in place of a
   question. They are already applied: give what was chosen, and how to reverse it.
3. **Defects from before the round.** What is wrong, and where. The usual action is a new
   issue, apart from the round.
4. **Scope changes for other issues.** For each issue: what changed, and the comment to
   post on it.
5. **Other items.** Each other open item that has an action.
6. **Cost.** The table of step 3.

Each item in parts 2 to 5 has one recommended action, and its owner: the person, or
Claude on the person's word. In each part, put the items with the same action together.
An item with no action is in no part. A fact for the record goes in the issue comment
only. Write the items in ASD-STE100 Simplified Technical English.

Then ask one `AskUserQuestion` with one question, `multiSelect: true`. Give one option for
each of parts 2 to 5 that has an item. The label names the part and its actions. Examples:
`Open the 4 new issues`, `Comment on #14 and #22; set #28 blocked by #17`. The
description lists the items in short form, and says who does each action. Do not give an
option for each item. When only one part has items, ask yes or no for that part. When no
part has items, do not ask.

An action that only the person can do, such as a merge or a ruleset change, stays in the
report. It is in no option, unless Claude can help with it.

Act on the answer:

- A checked option accepts each recommended action of its part. An unchecked option
  accepts none.
- Part 2 checked confirms the decisions. Part 2 unchecked keeps them applied: ask the
  person to name the items to reverse, in free text, and reverse only those.
- Parts 3 to 5: do each accepted action that Claude owns. For each accepted action that
  the person owns, give the exact steps.
- Before you open an issue, find an open issue with the same title, and reuse it when the
  title is an exact match:
  `gh issue list --state open --search '"<title>" in:title' --json number,title`.
- Follow an exception in the "Other" field, such as `all of part 3 except the timings
  issue`.

Then report what Claude did, and what it did not do. Post the same six parts, the facts
for the record, and that result as one comment on each issue of the round. Its first line
is `<round> end, <date>.`, for example `Round 14 end, 2026-10-02.`. `rounds` finds a
finished round by the prefix `<round> end`. End the comment with the round's
`_Recorded by <effort>, <date>._` line.
