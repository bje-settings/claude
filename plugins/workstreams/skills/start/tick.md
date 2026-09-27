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
- **The checkouts.** `checkout.clean` is `true`. When no agent writes to a worktree, its
  `worktree.clean` is `true` too.

## 3. Look for a collision

A collision is a pair in `intersect` whose `merge.result` is `conflict`, from two streams.
Two pull requests are one stream when a chain of `stackedOn` joins them. A pull request
that no round opened is a stream of its own.

On a collision:

1. Stop the next action of the stream whose layer is not yet under review.
2. Ask the person one `AskUserQuestion`: the redirect you recommend first, and the argument
   against it in its description. Examples of a redirect: rebase one stream onto the
   other, or hold one until the other merges.
3. Record the ruling as one comment on the issue of each stream. End it with the round's
   `_Recorded by <effort>, <date>._` line.

## 4. Do the next action for each pull request

| State | Next action |
| --- | --- |
| `awaiting-pr` | Stop. GitHub said this number does not exist. |
| `no-run` | Invoke `/workstreams:review`. It closes and reopens the pull request. A second `no-run` on the same head is a stop. |
| `ci-pending` | Nothing. The watch names each check as it reports. |
| `red` | The agent that pushed the head fixes it. If it returned, send it back with `SendMessage`. A pull request from a person, with no agent: report it, and stop. |
| `review-1`, `review-2`, `rot-check` | Nothing while a round agent works on this pull request. Otherwise, in a stack, switch the worktree to this layer's branch first: `git -C <worktree> switch <branch>`. `intersect` names the worktree under the layer of the stack that has it checked out. Switch only when no agent works in it and its `clean` is `true`. A switch carries uncommitted work to the other branch. Then invoke `/workstreams:review` with the number and the markers' flags. |
| `fixing` | Nothing. The round agent's return, or a person who resolves a thread, is the next wake. |
| `done` | This layer is finished. Step 3 of `SKILL.md` writes the next layer. |

Ten wakes on one state, with no agent at work on that pull request, is a stop. Name the
contexts whose `reported` is `false`.

## 5. Read an agent's return

- **A layer agent.** Invoke `/workstreams:stream` to read it.
- **A round agent.** Invoke `/workstreams:review` with the number and the return. It posts
  the round's marker.
- **`lower_layer`, from either.** Apply it to its layer only in a gap: no agent writes to
  that layer or to one above it. Resume that layer's agent with `SendMessage`. Tell it to
  commit on its own branch. Then it runs `gh stack rebase --upstack`, a full type check,
  and `gh stack push`. Then check each head of the stack again. Outside a gap, keep the
  finding for the round-end report.

## 6. End the turn

Write one line for each pull request whose state changed, and the action you took.
