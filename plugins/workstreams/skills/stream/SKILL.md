---
name: stream
description: Build one issue, or one stack of them, in one worktree, a layer at a time.
argument-hint: [issue-or-stack]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh pr close *) Bash(gh pr reopen *) Bash(gh pr diff *) Bash(gh issue view *) Read Grep Glob Write Agent SendMessage Skill
user-invocable: false
---

Issues to build: $ARGUMENTS. The issue order and the model per layer come from the plan
comment on the round's issues. The briefs go in the session's scratchpad. If the plan
comment does not name the order and model for every issue in `$ARGUMENTS`, stop. Say
which is missing rather than guess: a placeholder left in a brief is a layer that will
guess too.

One stream is one worktree, with one branch and one agent per layer, in sequence. The
lower layer is reviewed to `done` before the team writes the next layer.

## Process

1. Preflight.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight
   ```

   Exit 1 means something is missing. Print each hint verbatim and stop.

2. One worktree for the whole stack, created once, from the tip the round was planned
   against. Then install, from the lock file that is actually there: `pnpm-lock.yaml`
   means `pnpm install`, `yarn.lock` means `yarn install`, `package-lock.json` means
   `npm ci`, and a `uv.lock` beside any of them means `uv sync --locked` too.

   An install can write outside the worktree. lefthook writes into the clone's shared
   `.git/hooks/`, and leaves a hook file behind when a later revision stops using it. Say
   so in the brief when the repository installs git hooks, and check the root checkout
   afterward.

3. Write the brief as a file. Fill every placeholder of [brief.md](brief.md), the layer
   agent's whole instruction, into a file of its own, one per layer. The dispatch prompt
   points at that file, and repeats only the lines most often got wrong.

   Check the brief against the repository before you send it.

4. Dispatch one agent per layer: one `workstreams:stream` subagent, with the `model` the
   caller sized it at. The agent inherits this session's effort. The caller cannot pass
   effort per call.

   Dispatch once, then wait. A return that says the layer is still waiting is a layer
   stopped short. Send it back with `SendMessage` and a narrower instruction, rather than
   dispatch a second one.

   The layer opens its own draft pull request with `gh stack submit`, never
   `gh pr create`. A stack that is not a stack in the GitHub UI cannot be told apart from
   five unrelated drafts by a reviewer, and is harder to recover. [brief.md](brief.md)
   carries the command and what follows it.

5. Check each new head yourself. Every time a layer pushes, the caller checks what the
   layer cannot be the only witness to:

   ```bash
   gh pr diff <number> --name-only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --json
   git -C <worktree> status --porcelain
   git -C <root checkout> status --porcelain
   ```

   Check the changed files against the layer's allowed set. Check that every lower
   layer's SHA is unchanged. Check for a run with event `pull_request` on the head, and
   close and reopen the pull request once if there is none. Check that both checkouts are
   clean. Reviewer and layer artifacts have landed in the ROOT checkout twice before.

6. Review, then move to the next layer. On a layer's return, act on each of
   `constraints_checked`, `brief_vs_code`, `outside_set`, `lower_layer`, and
   `injected_text_seen` before you move on. A `brief_vs_code` entry corrects the next
   layer's brief. [brief.md](brief.md)'s Return section says what each field carries.

   Then invoke `/workstreams:review` on the pull request. Write the next layer only once
   this one reaches `done`. Add what this layer's review found to the next layer's brief,
   in its lessons section.

7. Report: the pull request per layer, with its head and CI state; what each layer
   returned under the five fields above; the cost of each agent, from its task
   notification; and the merge sequence. Nothing merges here. The caller merges the
   stack.
