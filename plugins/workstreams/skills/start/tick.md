# The tick

Do these steps on each wake, in this order. The reads are in `SKILL.md`.

## 1. Read

Run `pr-state` for each pull request of the round, and `intersect` once. A non-empty
`unavailable`, or a `state` of `null`, is a fact nobody could read. Name it, and do no
action that depends on it.

## 2. Check each new head

A head is new when the watch names it in an `open` or `new head` line, or an agent
returns. For each new head, check what its agent cannot be the only witness to:

- **Files.** Its `ownFiles` against the layer's allowed set in the plan. A file outside the
  set that the layer did not declare under `outside_set` goes back to the layer.
- **Lower layers.** Each lower layer's `headSha` is the same as at the last tick. A lower
  head moved, and no step of this round moved it: stop.
- **The run.** `pullRequestRun` is `true`. `pr-state` names the remedy (`no-run`).
- **The watch.** Its `--heads` holds this pull request's head, unless the watch runs with
  no `--heads`. If not, stop the watch with `TaskStop`, and arm it again with the head
  added ([Wakes](SKILL.md#wakes)).
- **The checkouts.** `checkout.clean` is `true`. When no agent writes to a worktree, its
  `worktree.clean` is `true` too. A dirty checkout is a stop. Name it.

An agent works when this conversation dispatched it and its return has not come. A new
conversation has no agent at work.

## 3. Look for a collision

A collision is a pair in `intersect` whose `merge.result` is `conflict`, from two streams.
Two pull requests are one stream when a chain of `stackedOn` joins them. A pull request
that no round opened is a stream of its own.

On a collision:

1. Stop the next action of the stream whose layer is not yet under review.
2. Ask the person one `AskUserQuestion`: the redirect you recommend first, and the argument
   against it in its description. Examples of a redirect: rebase one stream onto the
   other, or hold one until the other merges.
3. Record the ruling as one comment on the issue of each stream of this round. A pull
   request of another round, or one that no round opened, gets no comment: name it in the
   ruling. End it with the round's `_Recorded by <effort>, <date>._` line.

## 4. Do the next action for each pull request

| State | Next action |
| --- | --- |
| `awaiting-pr` | Stop. GitHub said this number does not exist. |
| `merged` | Stop for this pull request. Report it. A layer that merges mid-round gets a report only, never a review. A merged layer is finished: step 3 of `SKILL.md` writes the next layer. |
| `closed` | Closed with no merge. Report it, never a review. Read the `Mid-round ruling` comments on the layer's issues: `gh issue view <number> --json comments`. One about this layer is the answer: do not ask again. With no answer, ask one [question](#a-decision-mid-round), once: drop this layer and each layer above it from the round, reopen it, or replan. Record the answer on each of the layer's issues. Drop: the round can end, and the round end lists the dropped layers. Reopen: the person reopens it, and its state acts on the next wake. Replan: stop. |
| `no-run` | Invoke `/workstreams:review`. It closes and reopens the pull request. A second `no-run` on the same head is a stop. |
| `review-1`, `review-2`, `rot-check` | Nothing while an agent works on this pull request, the layer agent or a round agent. `pr-state` sees no agent: `review-1` comes as soon as the head has a run, while the layer agent can still build. CI can still run, or be red: the round reads it. Otherwise, in a stack, switch the worktree to this layer's branch first: `git -C <worktree> switch <branch>`. `intersect` names the worktree under the layer of the stack that has it checked out. Switch only when no agent works in it and its `clean` is `true`. A switch carries uncommitted work to the other branch. Then invoke `/workstreams:review` with the number and the markers' flags, `--round-1-head` included. For `review-2`, also give it round 1's return. |
| `fixing` | Nothing while a round agent works on this pull request: its return, or a person who resolves a thread, is the next wake. With no agent at work and a `red` verdict, the agent that pushed the head fixes it. If it returned with red on a file it did not touch, run `gh run rerun <its run id> --failed`, once. Otherwise resume it with `SendMessage`. A pull request from a person, with no agent: report it, and stop. With a `pending` verdict, the watch names each check as it reports. |
| `done` | This layer is finished. Step 3 of `SKILL.md` writes the next layer. |

Ten wakes on one state, with no agent at work on that pull request, is a stop. A watch
line in which a context of its head reports is not one of the ten: CI can still run in
`fixing`. Name the contexts whose `reported` is `false`.

## 5. Read an agent's return

- **A layer agent.** Invoke `/workstreams:stream` to read it. An `outside_set` file or a
  `brief_vs_code` entry that the plan does not answer is a [decision](#a-decision-mid-round).
- **A round agent.** Invoke `/workstreams:review` with the number and the return. It posts
  the round's marker.
- **`lower_layer`, from either.** To apply it is a [decision](#a-decision-mid-round).
  Apply it to its layer only in a gap: no agent writes to that layer or to one above it.
  Resume that layer's agent with `SendMessage`. Tell it to commit on its own branch, then
  to run `(cd <worktree> && gh stack rebase --upstack)`, a full type check, and
  `(cd <worktree> && gh stack push)`. `gh stack` acts on the current directory, so the
  subshell is the only safe form (the stream brief, rule 12). Then check each
  head of the stack again. Outside a gap, keep the finding for the round-end report.

## 6. End the turn

Write one line for each pull request whose state changed, and the action you took. Name
each ruling of this tick.

## A decision mid-round

A decision that the plan does not answer is a ruling when all three are true:

- It has a recommended option.
- A reversal costs about one commit or one comment.
- It adds or drops no issue, layer or acceptance line. It changes only behaviour that an
  issue of the round names.

For a ruling, apply the recommended option, and go on. Post one comment on each issue it
touches. Its first line is `Mid-round ruling <n> (<round>, cheap to reverse):`, with `<n>`
after the round's last ruling number. Give what you chose, the argument for, the argument
against, and how to reverse it. End it with the round's `_Recorded by <effort>, <date>._`
line.

Any other decision is a question: one `AskUserQuestion`, with a recommended option first if
there is one. Record the answer in the same form, with `answered by the person` in place
of `cheap to reverse`. A collision is a question, in step 3. A runner with no
`AskUserQuestion` does not ask. It stops only the actions that the decision holds. It puts
the question in its return: the options, the recommended one first, and the argument
against each.

Examples from real rounds:

- A one-clause fix to a false claim, in a file the layer already edits: a ruling.
- A `lower_layer` finding that corrects a field, applied in a gap: a ruling.
- A code defect that no issue of the round names: keep it for the round-end open items, a
  ruling. To fix it in this round changes behaviour that no issue names, so that is a
  question.
- To drop an issue from the round: a question.
- A layer that closed with no merge: a question, in step 4.
