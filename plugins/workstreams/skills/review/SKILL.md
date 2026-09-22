---
name: review
description: >
  Review one draft pull request through to done. Runs the pr-review-toolkit reviewers
  over the pull request's own diff in its worktree, verifies every finding and every
  rejection against the code, applies what holds, commits, pushes and waits for CI, in
  at most two rounds, then checks the title and body against the final diff. Use it on
  any pull request with green CI, whoever opened it.
allowed-tools: Bash, Read, Grep, Glob, Agent
disable-model-invocation: true
---

The command answers what is true of the pull request and which state that adds up to.
Everything below it is judgement: which reviewers, what holds, and what to do next.

Ask the caller for anything you were not given: the pull request number, the absolute
path of its worktree, and the model to size the round agent with. Never guess a worktree.

## Step 1: preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight
```

Exit 1 means something is missing. Print each hint verbatim and stop. A missing reviewer
is named here so that a round does not discover it after spending the others.

## Step 2: read the state

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" pr-state <number> --round <0|1|2> --json
```

Add `--substantial` once round 1 has returned substantial, and `--rot-checked` once
step 6 is done. Those three are the only things the command cannot read, so they are
what you carry between ticks; nothing is written to disk.

`unavailable` non-empty means a fact could not be read. Say which, and do not act on a
`state` of `null`: no state at all is the command declining to name one from facts
nobody has seen.

## Step 3: act on the state

| State | What to do |
| --- | --- |
| `awaiting-pr` | No pull request answered for. Stop and say so. |
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

## Step 4: one round agent

One subagent, `general-purpose`, in the pull request's worktree, with the model the
caller sized it at. Build its brief from `round-brief.md`, and add `round-2.md` verbatim
for round 2. Fill in every placeholder the template names; a brief with a placeholder
left in it is a round that will guess.

Reviewers by what the diff changes, from `gh pr diff <n> --name-only`:

| The diff changes | Reviewers |
| --- | --- |
| prose only | `comment-analyzer`, `code-reviewer` |
| any code | add `silent-failure-hunter` |
| tests, or code that should have them | add `pr-test-analyzer` |
| a new exported type | add `type-design-analyzer` |

Dispatch once and wait. The agent returns once, with the JSON block `round-brief.md`
asks for. A return that says it is still waiting is a round stopped short: send it back
with `SendMessage` rather than dispatching a second one.

## Step 5: after the round

Read the return. Then step 2 again, with `--round` raised and `--substantial` if the
round said so.

Findings under `lower_layer` are never applied here: they belong to a branch this
round does not own. Pass them to the caller.

Read `substantial` generously. In eight of the nine hand-run rounds this skill is made
of, round 2 found round 1 wrong or incomplete, so a round that changed behaviour at all
is substantial. Two rounds is the ceiling whatever round 2 returns.

## Step 6: rot check

Read `rot-check.md` and do what it says with the rot lists the rounds returned. It is
the caller's job, not the round agent's: two rounds running have each returned "rot
list: empty" on a pull request that had ten stale claims in its body.

## Step 7: report

Four things: the state reached, what each round applied and rejected with its reason,
the rot check's corrections, and anything returned under `lower_layer`. Name each
round's cost from its task notification.
