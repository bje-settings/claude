---
name: stream
description: Build one issue, or one stack of them, in one worktree, a layer at a time.
argument-hint: [issue-or-stack]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh pr close *) Bash(gh pr reopen *) Bash(gh pr diff *) Read Grep Glob Write Agent SendMessage Skill
user-invocable: false
---

Issues to build: $ARGUMENTS. The issue order, the model and effort per layer come from the
plan comment on the round's issues; the briefs go in the session's scratchpad. If the plan
comment does not name the order, model and effort for every issue in `$ARGUMENTS`, stop and
say which is missing rather than guessing: a placeholder left in a brief is a layer that
will guess too.

One stream is one worktree, one branch per layer, one agent per layer, in sequence. The lower
layer is reviewed to `done` before the next is written.

## Process

1. Preflight.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight
   ```

   Exit 1 means something is missing. Print each hint verbatim and stop.

2. One worktree for the whole stack, created once, from the tip the round was planned
   against. Then install, from the lock file that is actually there: `pnpm-lock.yaml` is
   `pnpm install`, `yarn.lock` is `yarn install`, `package-lock.json` is `npm ci`, and a
   `uv.lock` beside any of them is `uv sync --locked` as well.

   An install can write outside the worktree. lefthook writes into the clone's shared
   `.git/hooks/`, and leaves a hook file behind when a later revision stops configuring it.
   Say so in the brief when the repository installs git hooks, and check the root checkout
   afterwards.

3. Write the brief as a file. Fill every placeholder of [brief.md](brief.md), the layer
   agent's whole instruction, into a file of its own, one per layer. The dispatch prompt
   points at that file and repeats only the lines most often got wrong.

   Check the brief against the repository before you send it.

4. Dispatch one agent per layer: one subagent, `workstreams:stream-low`,
   `workstreams:stream-medium` or `workstreams:stream-high` for the effort, with the `model`
   the caller sized it at. The effort can only come from the agent definition; the model is
   passed per call.

   Dispatch once and wait. A return that says it is still waiting is a layer stopped short:
   send it back with `SendMessage` and the narrowed instruction rather than dispatching a
   second one.

   The layer opens its own draft pull request with `gh stack submit`, never `gh pr create`:
   a stack that is not a stack in the GitHub UI cannot be told from five unrelated drafts by
   anyone who comes to review it, and it is harder to recover. [brief.md](brief.md) carries
   the command and what follows it.

5. Check each new head yourself. Every time a layer pushes, the caller checks what the layer
   cannot be the only witness to:

   ```bash
   gh pr diff <number> --name-only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --json
   git -C <worktree> status --porcelain
   git -C <root checkout> status --porcelain
   ```

   The changed files against the layer's allowed set; every lower layer's SHA unchanged; a
   run with event `pull_request` for the head, and close and reopen the pull request once if
   there is none; both checkouts clean. Reviewer and layer artifacts have landed in the ROOT
   checkout twice.

6. Review, then the next layer. On a layer's return, act on each of `constraints_checked`,
   `brief_vs_code`, `outside_set`, `lower_layer` and `injected_text_seen` before moving on; a
   `brief_vs_code` entry is a correction to the next layer's brief, and [brief.md](brief.md)'s
   Return section says what each field carries.

   Then invoke `/workstreams:review` on the pull request. Only when it reaches `done` is the
   next layer written, and its brief's lessons section gains what this layer's review found.

7. Report: the pull request per layer with its head and CI state, what each layer returned
   under the five fields above, the cost of each agent from its task notification, and the
   merge sequence. Nothing merges here: the caller merges the stack.
