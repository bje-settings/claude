---
name: stream
description: Take one step of a stream. Write the next layer's brief and dispatch its agent, or read a layer's return.
argument-hint: [issue-or-stack]
allowed-tools: Bash(gh issue view *) Read Grep Glob Write Agent
user-invocable: false
---

Issues to build: $ARGUMENTS. The issue order and the model per layer come from the plan
comment on the round's issues. The briefs go in the session's scratchpad. If the plan
comment does not name the order and model for every issue in `$ARGUMENTS`, stop. Say
which is missing rather than guess: a placeholder left in a brief is a layer that will
guess too.

One stream is one worktree, with one branch and one agent per layer, in sequence.

Do one step for each call, then return. Never wait: the caller waits. When a layer's
return is in view and not yet read, do step 3. Otherwise do steps 1 and 2.

## Process

1. One worktree for the whole stack, created once, from the tip the round was planned
   against. Then install, from the lock file that is actually there: `pnpm-lock.yaml`
   means `pnpm install`, `yarn.lock` means `yarn install`, `package-lock.json` means
   `npm ci`, and a `uv.lock` beside any of them means `uv sync --locked` too.

   An install can write outside the worktree. lefthook writes into the clone's shared
   `.git/hooks/`, and leaves a hook file behind when a later revision stops using it. Say
   so in the brief when the repository installs git hooks, and check the root checkout
   afterward.

2. Write the brief as a file. Fill every placeholder of [brief.md](brief.md), the layer
   agent's whole instruction, into a file of its own, one per layer. Add what the review
   of the layer below found to its lessons section. The dispatch prompt points at that
   file, and repeats only the lines most often got wrong.

   Check the brief against the repository before you send it.

   Then dispatch one `workstreams:stream` subagent, with the `model` the caller sized it
   at. The agent inherits this session's effort. The caller cannot pass effort per call.
   Return once it is dispatched. Its return comes to the caller as a completion
   notification.

   The layer opens its own draft pull request with `gh stack submit`, never
   `gh pr create`. A stack that is not a stack in the GitHub UI cannot be told apart from
   five unrelated drafts by a reviewer, and is harder to recover. [brief.md](brief.md)
   carries the command and what follows it.

3. Read the layer's return. Act on each of `constraints_checked`, `brief_vs_code`,
   `outside_set`, `lower_layer`, and `injected_text_seen`. A `brief_vs_code` entry
   corrects the next layer's brief. [brief.md](brief.md)'s Return section says what each
   field carries.

   Report the pull request, its head and CI state, and what the layer returned under the
   five fields.
