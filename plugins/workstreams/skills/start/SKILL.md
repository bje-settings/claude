---
name: start
description: Run a round of issue-tracker work, or continue one, from the sweep to reviewed draft pull requests. With `#<pr>`, take one pull request through review to done. The one entry to the workstreams primitives.
argument-hint: [milestone | #pr]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue comment *) Bash(gh pr list *) Bash(gh pr view *) Bash(gh stack view *) Bash(git -C * switch *) Read Grep Glob Skill SendMessage AskUserQuestion Monitor TaskStop
---

Round: $ARGUMENTS. A milestone, or nothing, starts or continues a round. `#<pr>` reviews
that one pull request, with no sweep and no plan.

Run this in the main conversation. A subagent has no `AskUserQuestion` and no plan mode,
and nothing wakes it.

## Where the round stands

Derive it on each call. Write nothing to disk.

1. **The plan.** The latest comment whose first line reads `<round> plan, approved <date>.`
   It names each layer's issues, branch, model, allowed file set and reviewers. Find the
   open issues that carry one, with `--milestone <milestone>` when one is given:

   ```bash
   gh issue list --state open --search '"plan, approved" in:comments' --json number,title
   ```
2. **The pull requests.** `gh pr list --json number,headRefName,baseRefName,closingIssuesReferences`
   names the ones that close a round issue. `gh stack view --json` gives the layer order,
   and names a layer whose body only refers to an issue. Take each head from `intersect`,
   not from `gh stack view`: its local heads can be old.
3. **The review facts.** For each pull request: the rounds done, whether round 1 was
   substantial, and whether the rot check is done. Only this conversation holds them.
   When they are not in view, ask the person for them. Do not guess.

## Order

1. No plan comment: invoke `/workstreams:sweep` with the milestone. If it stops, stop.
   Then invoke `/workstreams:question` with the same milestone. Its plan mode is the
   approval. With no approved plan, stop.
2. `#<pr>`: that pull request is the whole round. Ask the person for the review model if
   no plan names one. Go to step 4.
3. When the layer below is `done`, or there is none, invoke `/workstreams:stream` with the
   next layer's issues.
4. Wait for a wake. Then run the tick in [tick.md](tick.md), and wait again.
5. When every pull request is `done` and the plan has no layer left, do
   [round-end.md](round-end.md). Nothing merges.

## Wakes

The plugin monitor starts the first time this skill runs in a session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" watch
```

Each line it writes is a wake. The other wake is an agent's completion notification.

- The watch writes an `open` line for each open pull request. A pull request is open, and
  no `open` line for it came: the plugin monitor does not run. Start that command with
  the Monitor tool yourself. On its expiry, start it again, with `--since-head` and
  `--concluded` set to the full heads you know.
- Between wakes, end the turn. Never poll an agent. Never sleep in the foreground.
- A return that says the agent still waits has stopped short. Send it back with
  `SendMessage` and a narrower instruction. Do not dispatch a second agent.
- No agent works, and no monitor can run: report where the round stands, and stop. The
  person runs `/workstreams:start` again.

## The reads of each tick

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --round <0|1|2> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" intersect --json
```

Add `--substantial` and `--rot-checked` to `pr-state` when the review facts say so.
