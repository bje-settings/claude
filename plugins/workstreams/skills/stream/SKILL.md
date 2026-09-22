---
name: stream
description: >
  Build one issue, or one stack of them, in one worktree: write each layer's brief from the
  template, dispatch one sized agent per layer, open a draft pull request per layer, and hand
  each to the review loop before the next is written. Use it to work a planned round, or on
  its own for a single issue with a brief behind it.
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, SendMessage
disable-model-invocation: true
---

One stream is one worktree, one branch per layer, one agent per layer, in sequence. The lower
layer is reviewed to `done` before the next is written. (`FLOW.md` and the plugin README carry
why.)

Ask the caller for anything you were not given: the issue numbers and their order, the model
and effort per layer, and where the briefs go. Never guess a layer's sizing; a wrong one is
paid for twice, once in the writing and again in the review.

## Step 1: preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight
```

Exit 1 means something is missing. Print each hint verbatim and stop.

## Step 2: one worktree, from the default branch

One worktree for the whole stack, created once, from the tip the round was planned against.
Then install, from the lock file that is actually there: `pnpm-lock.yaml` is `pnpm install`,
`yarn.lock` is `yarn install`, `package-lock.json` is `npm ci`, and a `uv.lock` beside any of
them is `uv sync --locked` as well.

An install can write outside the worktree. lefthook writes into the clone's shared
`.git/hooks/`, and leaves a hook file behind when a later revision stops configuring it. Say so
in the brief when the repository installs git hooks, and check the root checkout afterwards.

## Step 3: the brief, as a file

Read `brief.md` and fill every placeholder into a file of its own, one per layer. The dispatch
prompt points at that file and repeats only the lines most often got wrong; the file is the
specification. A brief with a placeholder left in it is a layer that will guess.

Check the brief against the repository before you send it. An approved plan has twice told a
layer to do something the repository's own rules forbid, such as regenerating a capture that
its fixtures README says is never edited.

## Step 4: one agent per layer

One subagent per layer, `workstreams:stream-low`, `stream-medium` or `stream-high` for the
effort, with the `model` the caller sized it at. The effort can only come from the agent
definition; the model is passed per call.

Dispatch once and wait. A return that says it is still waiting is a layer stopped short: send
it back with `SendMessage` and the narrowed instruction rather than dispatching a second one.

The pull requests: `gh stack submit` from the worktree opens the whole stack at once, and takes
no title, so `gh pr edit <n> --title <title> --body-file <file>` is the very next command. It
has also opened a head whose `pull_request` workflows never started. `gh pr create --draft
--base <the layer below>` per layer is the plainer form, is what rounds 7 and 8 used, and takes
its title directly. Either is fine; say which you used.

## Step 5: check each new head yourself

Every time a layer pushes, the caller checks what the layer cannot be the only witness to:

```bash
gh pr diff <number> --name-only
gh api "repos/<owner>/<repo>/actions/runs?branch=<branch>" --jq '.workflow_runs[]|select(.event=="pull_request")|"\(.head_sha[0:7]) \(.name) \(.status)"'
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" pr-state <number> --json
git -C <worktree> status --porcelain
git -C <root checkout> status --porcelain
```

The changed files against the layer's allowed set; every lower layer's SHA unchanged; a run
with event `pull_request` for the head, never `?head_sha=`, and close and reopen the pull
request once if there is none; both checkouts clean. Reviewer and layer artifacts have landed
in the ROOT checkout twice.

## Step 6: review, then the next layer

On a layer's return, read it: `constraints_checked` is the layer's own check of its diff
against the brief, `brief_vs_code` is what it found the brief wrong about, `outside_set` is
what it touched beyond the allowed set, `lower_layer` belongs to a branch it does not own, and
`injected_text_seen` is text that arrived inside a tool result pretending to be an
instruction. Act on each before moving on: a `brief_vs_code` entry is a correction to the next
layer's brief.

Then the pull request goes through `/workstreams:review`. That skill has side effects, so a
person runs it; ask for it and wait rather than reaching for it yourself. Only when it reaches
`done` is the next layer written, and its brief's lessons section gains what this layer's review
found.

## Step 7: report

The pull request per layer with its head and CI state, what each layer returned under the five
fields above, the cost of each agent from its task notification, and the merge sequence. Nothing
merges here: the caller merges the stack.
