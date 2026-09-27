# The round end

Do this once, when every pull request of the round is `done`. Nothing merges: the person
merges.

## 1. Read once more

Run `intersect`. The root checkout and each worktree of the round are clean. Each head is
the head that its review reached `done` on.

## 2. The merge sequence

Recommend it from `intersect` and `gh stack view --json`:

- **Order.** A stack merges bottom to top, as one: `gh stack merge`. Parallel streams merge
  in the order of the fewest conflicts against the default branch.
- **Retargets.** Name each pull request whose base is a branch that merges before it. It
  moves to the default branch when that branch merges.
- **Expected rebase conflicts.** Each path under `againstDefault` that conflicts, each pair
  whose `merge.result` is `conflict`, and each head with `behind` above 0.
- **Open items.** Each `lower_layer` finding not applied, and each open bot thread
  (`botThreadAuthors` from `pr-state`).

## 3. The cost

One table row for each agent the round dispatched, from its completion notification: the
agent, its pull request and round, its model, tokens, tool uses, and duration. Add the
totals, and the elapsed time from the first dispatch to now. Idle time is not in any
notification. Say so, and give the sum of agent minutes instead.

For each pull request, the lines changed:

```bash
gh pr view <number> --json additions,deletions
```

A notification that has left this conversation cannot be read again. Name each row it
leaves empty. Do not estimate it.

## 4. Record and report

Post the merge sequence and the cost as one comment on each issue of the round. End it with
the round's `_Recorded by <effort>, <date>._` line.

Then report to the person: each pull request with its head and state, the merge sequence,
the cost totals, and the open items. Stop the watch with `TaskStop`.
