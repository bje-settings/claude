---
name: start
description: Run a round of issue-tracker work, or continue one, from the sweep to reviewed draft pull requests. With `#<pr>`, take one pull request through review to done. The one entry to the workstreams primitives.
argument-hint: [milestone | #pr]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue comment *) Bash(gh pr list *) Bash(gh pr view *) Bash(gh stack view *) Bash(git -C * switch *) Bash(gh run rerun *) Read Grep Glob Skill SendMessage AskUserQuestion Monitor TaskStop
---

Round: $ARGUMENTS. A milestone, or nothing, starts or continues a round. `#<pr>` reviews
that one pull request, with no sweep and no plan.

Run this in the main conversation. A subagent has no `AskUserQuestion` and no plan mode,
and nothing wakes it.

## Where the round stands

Derive it on each call. Write nothing to disk.

1. **The plan.** The latest comment whose first line reads `<round> plan, approved <date>.`
   It names each layer's issues, branch, model, allowed file set and reviewers. Find the
   open issues that carry one:

   ```bash
   gh issue list --state open --search '"plan, approved" in:comments' [--milestone <milestone>] --json number,title
   ```

   The round is the newest plan. An open issue whose latest plan names an earlier round is
   not in it.
2. **The pull requests.** `gh pr list --json number,headRefName,baseRefName,closingIssuesReferences`
   names the ones that close a round issue. `gh stack view --json` gives the layer order,
   and names a layer whose body only refers to an issue. Take each head from `intersect`,
   not from `gh stack view`: its local heads can be old.
3. **The review facts.** `/workstreams:review` posts a marker comment after each round and
   after the rot check. Read them for each pull request:

   ```bash
   gh pr view <number> --json comments --jq '.comments[].body | split("\n")[0]'
   ```

   A marker is a first line that is exactly one of the four `/workstreams:review` posts.
   `Review round <n> done` gives `--round <n>`, the highest one. `Review round 1 done:
   substantial.` gives `--substantial`. `Rot check done.` gives `--rot-checked`. No marker
   gives `--round 0`. A set that `pr-state` refuses, or a round 2 with no substantial
   round 1, is a stop. Name the markers.

## Order

1. No plan comment: invoke `/workstreams:sweep` with the milestone. If it stops, stop.
   Then invoke `/workstreams:question` with the same milestone. Its plan mode is the
   approval. With no approved plan, stop.
2. `#<pr>`: that pull request is the whole round. Read its state first. `merged` or
   `closed` is a stop. Report it, and dispatch no round. Otherwise, ask the person for
   the review model if no plan names one. Go to step 4.
3. When the layer below is `done`, or there is none, invoke `/workstreams:stream` with the
   next layer's issues.
4. Wait for a wake. Then run the tick in [tick.md](tick.md), and wait again.
5. When every pull request is `done` and the plan has no layer left, do
   [round-end.md](round-end.md). Nothing merges.

## Wakes

Each time the wait loop starts, arm the watch with the Monitor tool, at the longest
timeout it allows:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" watch
```

Hold its task id in the conversation. Do not arm a second watch while this one runs.

Each line the watch writes is a wake. The other wake is an agent's completion
notification.

- On expiry, arm the watch again. Give it `--since-head` and `--concluded`, and build both
  from the full heads you know. A concluded head goes in `--concluded`; every other head
  goes in `--since-head`. The new watch then stays silent about what it already said.
- On an exit that is not an expiry, read the watch's last line. If the cause can clear,
  such as a usage error in your arguments, correct it and arm the watch again, once.
  Otherwise the watch cannot run.
- Between wakes, end the turn. Never poll an agent. Never sleep in the foreground.
- A return that says the agent still waits has stopped short. Send it back with
  `SendMessage` and a narrower instruction. Do not dispatch a second agent.
- No agent works, and the watch cannot run: report where the round stands, and stop.
  The person runs `/workstreams:start` again.

## The reads of each tick

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> --round <0|1|2> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" intersect --json
```

Add `--substantial` and `--rot-checked` to `pr-state` when the markers say so.
