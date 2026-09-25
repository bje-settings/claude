---
name: review
description: Review one draft pull request through to done, in at most two rounds.
argument-hint: [pr-number]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh pr close *) Bash(gh pr reopen *) Bash(gh pr diff *) Bash(gh pr view *) Bash(gh issue view *) Bash(git worktree list *) Read Grep Glob Agent SendMessage
user-invocable: false
---

Pull request: $ARGUMENTS. Its worktree comes from `git worktree list`, matched against the
pull request's head branch; the round's issues are the ones its body closes (`gh pr view
<number>`, the `Closes #n` line `/workstreams:stream` writes into every layer's body), or
whichever issues this session already has in view from dispatching the stream; the model to
size the round agent with comes from the plan comment on those issues. No match, more than
one match, or no model named for this pull request in the plan comment is a stop, with what
is missing named: a round dispatched into a guessed worktree or with a guessed model is a
round that will guess again inside it.
Both commands below run in that worktree: they take no repository argument and read it from
the working directory, so outside a checkout they report on git rather than on the pull
request.

## Process

1. Preflight.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight
   ```

   Exit 1 means something is missing. Print each hint verbatim and stop.

2. Read the state.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --round <0|1|2> --json
   ```

   Add `--substantial` once round 1 has returned substantial, and `--rot-checked` once
   step 6 is done. Those three are the only things the command cannot read, so they are
   what you carry between ticks; nothing is written to disk.

   `unavailable` non-empty means a fact could not be read. Say which, and do not act on a
   `state` of `null`: no state at all is the command declining to name one from facts
   nobody has seen.

   `contextsFrom: "head"` is not that. It means the base branch is one no ruleset covers,
   which every layer of a stack is, so the verdict is over what has reported on the head.
   Say so once and carry on, and say the rest of it too: that verdict cannot see a check
   nobody has created, so `green` there means everything that reported is satisfying, not
   that the pull request would pass the default branch's ruleset. A layer is fully checked
   only when it is rebased onto a branch that has one.

3. Act on the state.

   | State | What to do |
   | --- | --- |
   | `awaiting-pr` | Nothing answered for this number. Read `unavailable` before saying there is no such pull request: a read gh refused lands here too. Stop either way. |
   | `no-run` | No workflow run for this head. `gh pr close <n> && gh pr reopen <n>`, once, then step 2 again. A second `no-run` after a reopen is a stop. |
   | `ci-pending` | Wait, then step 2 again. |
   | `red` | CI was red before any round ran. That belongs to whoever opened the pull request: report it and stop. |
   | `review-1`, `review-2` | Step 4. |
   | `fixing` | The round's own fixes have not landed, or a review thread is unresolved. Wait, then step 2 again. |
   | `rot-check` | Step 6. |
   | `done` | Step 7. |

   Wait by sleeping for `waitHint.medianMs` when there is one and 60 seconds when there is
   not, and never longer than 30 minutes in one wait. Run the wait in the foreground.
   Never poll a subagent; only the pull request is watched.

   Ten waits on one state is a stop. Stop and name the contexts whose `reported` is false.

4. Dispatch one round agent: one subagent, `general-purpose`, in the pull request's
   worktree, with the model the caller sized it at. Build its brief from
   [round-brief.md](round-brief.md), the round agent's whole instruction, and add
   [round-2.md](round-2.md) verbatim for round 2. Fill in every placeholder the template
   names; a brief with a placeholder left in it is a round that will guess.

   Reviewers by what the diff changes, from `gh pr diff <n> --name-only`:

   | The diff changes | Reviewers |
   | --- | --- |
   | prose only | `comment-analyzer`, `code-reviewer` |
   | any code | add `silent-failure-hunter` |
   | tests, or code that should have them | add `pr-test-analyzer` |
   | a new exported type | add `type-design-analyzer` |

   Dispatch once and wait. The agent returns once, with the JSON block
   [round-brief.md](round-brief.md) asks for. A return that says it is still waiting is a
   round stopped short: send it back with `SendMessage` rather than dispatching a second
   one.

5. Step 2 again, with `--round` raised and `--substantial` if the round said so.

   Findings under `lower_layer` are never applied here: they belong to a branch this
   round does not own. Pass them to the caller.

   Read `substantial` generously: a round that changed behaviour at all is substantial.
   Two rounds is the ceiling whatever round 2 returns.

6. Rot check. Read [rot-check.md](rot-check.md) and do what it says with the rot lists the
   rounds returned.

7. Report four things: the state reached, what each round applied and rejected with its
   reason, the rot check's corrections, and anything returned under `lower_layer`. Name
   each round's cost from its task notification.
