---
name: review
description: Take one step of the review loop on one draft pull request, from its state. Dispatch a review round, record a finished one, reopen for a missing run, do the rot check, or report.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh pr close *) Bash(gh pr reopen *) Bash(gh pr diff *) Bash(gh pr view *) Bash(gh pr edit *) Bash(gh pr comment *) Bash(gh issue view *) Bash(gh api graphql *) Bash(git worktree list *) Bash(git -C * diff *) Read Grep Glob Agent
user-invocable: false
---

Pull request, and any `pr-state` flags: $ARGUMENTS. `pr-state` reads the review facts from
the [statuses](#statuses). A flag from the caller wins over a status.

Its worktree comes from `git worktree list`, matched against the pull request's head
branch. The round's issues are the ones its body closes (`gh pr view <number>`), or
the ones the caller names. No worktree match, or more than one, is a stop. Name what is
absent. A round dispatched into a guessed worktree will guess again inside it.

The model for the round agent comes from the newest plan comment on those issues, or from
the caller. When neither names one, choose it by this rule. Do not ask, and do not stop:

- `opus` for round 2.
- `opus` for round 1 when the diff changes logic under `src/`, `lib/`, `scripts/` or
  `hooks/`, as in [Statuses](#statuses).
- `opus` for round 1 when the layer is new behaviour at the top of a stream.
- `sonnet` for any other round 1: prose, tests, metadata or renames.

Give the model and the reason in the return of the call that dispatches the round.

Both commands below run in that worktree. They take no repository argument, and read it
from the working directory. So, outside a checkout, they report on git rather than on
the pull request.

Do one step for each call, then return. Never wait: the caller waits.

## Statuses

After each review round, and after the rot check, record it as a commit status:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" mark <number> <name> [--description <text>] [--head <sha>]
```

`<name>` is `review-1`, `review-2` or `rot-check`. For a round, `--head` is the full `head`
of the round agent's return. For `review-1`, `--description` is `substantial` or `minor`.
Step 4 runs the rot check with neither flag. `pr-state` reads the statuses back. The first
`review-1` status gives the round 1 head, so a second one, after a resumed round, does not move
it.

After a `mark`, a comment on the pull request tells a person what the round did
([comment.md](comment.md)). `pr-state` reads only the statuses, never a comment.

Round 1 is substantial only when its own commits changed logic under `src/`, `lib/`,
`scripts/` or `hooks/`. Logic is a new or changed branch, state, output line or contract.
A rename, comment, type, message text or one-line guard is minor. Prose, tests and
metadata are never substantial. For the commits after the round 1 head, `pr-state` applies
the path part of this rule. Each changed file under those directories counts, except a
test file, a file under a test directory, or a Markdown file. Then the state is `review-2`.

## Process

0. Called with a round agent's JSON return: check its `substantial` against
   `git -C <worktree> diff <from> <head>`. The diff decides the description. Record that
   round's status with `mark` and its `head`, and name any disagreement. A `mark` that
   failed is a stop: say so, post no comment, and settle no thread. Then post the round
   comment. A comment that did not post is no stop: the status is the state. Name it in the
   return. Then settle each entry of the return's `bot_threads`. Reply `Fixed in <commit>.`,
   or `Not changed: <reason>.` when `commit` is `null`. Then resolve the thread, and return.

   ```bash
   gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}' -f id=<thread id> -f body='<reply>'
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread id>
   ```

   A reply or a resolve that failed is a stop. Name the thread.

1. Read the state once.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --json
   ```

   Add each flag the caller passes. `sinceRound1` says why the state is `review-2` after a
   round 1 that was not substantial.

   A non-empty `unavailable` means a fact could not be read. Say which fact. Do not act
   on a `state` of `null`: no state at all means the command declines to name one from
   facts nobody has seen.

   `contextsFrom: "head"` is different. It means no ruleset covers `rulesBranch`, the
   base of the stack bottom. An upper layer reads the rules of that base, so this is a
   stack, or a pull request, on a branch with no ruleset. The command then takes the
   verdict over what has reported on the head. Say so once, and say the rest of it too:
   that verdict cannot see a check nobody has created. So `green` there means everything
   that reported is satisfying, not that the pull request would pass a ruleset. A layer
   is fully checked only once its stack is on a branch that has one.

2. Act on the state, then return it.

   | State | What to do |
   | --- | --- |
   | `awaiting-pr` | Nothing. GitHub said this pull request number does not exist. A read gh refused for another reason gives `state: null` instead. |
   | `merged`, `closed` | Nothing. The pull request already finished. Report the state, then return. |
   | `no-run` | No workflow run for this head. `gh pr close <n> && gh pr reopen <n>`. |
   | `review-1`, `review-2` | Step 3. CI can still run, or be red, at `review-1`: the round reads it. At `review-1` with `layerReturned: false`, the layer agent has not returned: dispatch no round. Report it, then return. |
   | `fixing` | CI is not green, or a review thread is unresolved, from a person or a bot (`botThreads`, review bots such as Copilot included). Name the contexts that failed. A bot thread that no round settled, such as one a push opened after the round, is yours: read the threads with the query of [round-brief.md](round-brief.md) step 5. Settle each mermaid preview thread by its rule there, with the two calls of step 0. No round can run while this state holds. So name each other bot thread with its id, for the person, and stop. |
   | `rot-check` | Step 4. |
   | `done` | Step 5. |

3. Dispatch one round agent: one subagent, `general-purpose`, in the pull request's
   worktree, with the model from the rule above. Build its brief from
   [round-brief.md](round-brief.md), the round agent's whole instruction, and add
   [round-2.md](round-2.md) verbatim for round 2. Round 2's brief carries round 1's
   findings and rejected list, from the round 1 return that the caller passes. Fill in
   every placeholder the template names; a brief with a placeholder left in it is a round
   that will guess.

   Reviewers by what the diff changes, from `gh pr diff <n> --name-only`:

   | The diff changes | Reviewers |
   | --- | --- |
   | prose only | `comment-analyzer`, `code-reviewer` |
   | any code | add `silent-failure-hunter` |
   | tests, or code that should have them | add `pr-test-analyzer` |
   | a new exported type | add `type-design-analyzer` |

   Return once it is dispatched. The agent returns once, with the JSON block
   [round-brief.md](round-brief.md) asks for, as a completion notification to the
   caller. Findings under `lower_layer` are never applied here: they belong to a branch
   this round does not own.

4. Rot check. Read [rot-check.md](rot-check.md) and do what it says with the rot lists the
   rounds returned. Then record it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" mark <number> rot-check
   ```

   Then post the rot check comment, as step 0 does for a round. A comment that did not post
   is no stop: step 5 names it.

5. Report five things, with the URL of each comment posted, and each comment that did not
   post: the state reached, what each round applied and rejected with its
   reason, the rot check's corrections, anything returned under `lower_layer`, and each
   bot thread the caller settled, with its reply.
