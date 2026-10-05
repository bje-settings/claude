---
name: start
description: Run a round of issue-tracker work, or continue one, from the sweep to reviewed draft pull requests. A round is a milestone or a set of issues. With `pr <n>`, take one pull request through review to done. The one entry to the workstreams primitives.
argument-hint: [milestone <n> | issues <n> <n> | pr <n>]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue list *) Bash(gh issue view *) Bash(gh issue comment *) Bash(gh issue create *) Bash(gh pr list *) Bash(gh pr view *) Bash(gh pr comment *) Bash(gh stack view *) Bash(git -C * switch *) Bash(gh run rerun *) Read Grep Glob Skill SendMessage AskUserQuestion Monitor TaskStop
---

Scope: $ARGUMENTS.

- `milestone <n>` or a bare number: that milestone.
- `issues <n> <n>`: those issues.
- `pr <n>`: that one pull request, with no sweep and no plan.
- Nothing: every milestone with open issues.

For other words, judge what the person asked. Check each number with `gh issue view`,
`gh pr view` or the milestones that `sweep` reports. If two readings stay possible, ask one
`AskUserQuestion`.

A round is its issue set. Each issue is in the round of its newest plan comment, and in no
other. Another round in this repository holds other issues. Act and comment only on the
issues and pull requests of this round.

Run this in the main conversation. A subagent has no `AskUserQuestion` and no plan mode,
and nothing wakes it.

## Where the round stands

Derive it on each call. Write nothing to disk.

1. **The round.** Find the rounds in flight that hold the scope:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" rounds [--milestone <n> | --issues <n,n>] --json
   ```

   A non-empty `unavailable` is a fact nobody could read. Say which, and stop.

   - One round, with issues, and `outside` empty: it is the round, in flight.
   - One round, with a milestone: it is the round, in flight. Say that the milestone's
     other open issues are in no round. `outside` is null for a milestone.
   - One round and an `outside` issue: the scope is part in a round and part in none.
     Stop, and name both parts.
   - Two or more, with a scope: the scope holds issues of more than one round. Stop, and
     name each round and its issues.
   - One or more, with no scope: ask one `AskUserQuestion`. Give one option for
     each round, by its `plan` line and issues, and one option to start a new round.
   - None, and an `unended` issue: that round's issues all closed before its round end.
     Read its plan from that issue, do [round-end.md](round-end.md) for it, and stop.
   - None: no round is in flight in the scope.

   `rounds` lists the open issues of a round. The plan is the comment whose first line is
   the round's `plan`. It names every issue of the round, the closed ones too, and each
   layer's branch, build model, review model, allowed file set and reviewers. Read it from
   one issue of the round:

   ```bash
   gh issue view <number> --json comments --jq '[.comments[].body | select(startswith("<plan>"))] | last'
   ```

   No output, or `null`: stop, and name the issue.

2. **The pull requests.** `gh pr list --state all --limit 1000 --json number,state,headRefName,baseRefName,closingIssuesReferences`
   names the ones that close a round issue, or whose head is a branch the plan names.
   Without `--limit`, gh gives only 30. When one branch has more than one pull request,
   the newest is its layer's.
   `gh stack view --json` gives the layer order, and names a layer whose body only refers
   to an issue. Take each head from `intersect`, not from `gh stack view`: its local heads
   can be old.

   A merged pull request is final for its layer. It needs no marker. A plan issue still
   open after its pull request merged is an open item for the round end, not a round in
   flight.
3. **The review facts.** `/workstreams:review` posts a marker comment after each round and
   after the rot check. Read them for each pull request:

   ```bash
   gh pr view <number> --json comments --jq '.comments[].body | split("\n")[0]'
   ```

   A marker is a first line that is exactly one of the four `/workstreams:review` posts.
   `Review round <n> done` gives `--round <n>`, the highest one. `Review round 1 done:
   substantial.` gives `--substantial`. `Rot check done.` gives `--rot-checked`. No marker
   gives `--round 0`. A set that `pr-state` refuses, or a round 2 with no round 1, is a
   stop. Name the markers.

   With `--round 1`, read line 2 of the newest round 1 marker:

   ```bash
   gh pr view <number> --json comments --jq '[.comments[].body | split("\n") | select(.[0] | startswith("Review round 1 done")) | .[1]] | last'
   ```

   A line `Head <sha>.` gives `--round-1-head <sha>`. Any other line gives no flag.

## Order

1. A round in flight: go on at step 3. No round, or a new round: invoke
   `/workstreams:sweep` with the scope. With no scope, also give it the issues of each
   round in flight, to leave out. If it stops, stop.
   Then invoke `/workstreams:question` with the same scope. Its plan mode is the approval.
   With no approved plan, stop.
2. `pr <n>`: that pull request is the whole round. Read its state first. `merged` or
   `closed` is a stop. Report it, and dispatch no round. Otherwise go to step 4.
   `/workstreams:review` chooses the review model when no plan names one.
3. Invoke `/workstreams:stream` with the next layer's issues only when there is no layer
   below, or `pr-state` for the layer below gives `done` or `merged`. Any other state runs
   its row in [tick.md](tick.md) step 4. For a layer below that is `closed`, that row asks
   one question.

   GitHub is the state of review: only `pr-state` marks a layer done. A person's message
   in chat never changes the state, and never takes the place of a review round. The one
   exception is an explicit request from the person to skip the review of a layer in
   `review-1`. Post one ruling comment on the pull request that quotes the request, in the
   form of [tick.md](tick.md) "A decision mid-round". Then post the `Review round 1 done.`
   and `Rot check done.` markers, as `/workstreams:review` posts them. Put a link to the
   ruling comment on the line after the marker, above the footer. In any other state, a
   request to skip is a question. There, the two markers may not give `done`: CI that is
   not green gives `fixing`. A substantial round 1, or logic after the round 1 head,
   gives `review-2`.
4. Wait for a wake. If no watch runs, arm it first ([Wakes](#wakes)). Then run the tick in
   [tick.md](tick.md), and wait again.
5. When every layer is `done`, merged, or dropped, and the plan has no layer left, do
   [round-end.md](round-end.md). A dropped layer is one that the `closed` question in
   [tick.md](tick.md) step 4 removed from the round. Check this on each call, before the
   first wait. Do not ask before the report. Nothing merges. After the report, the round
   end asks one `AskUserQuestion`: which parts of the recommended actions to accept.

## Wakes

Each time the wait loop starts, arm the watch with the Monitor tool, at the longest
timeout it allows:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" watch --heads <branch>,<branch>
```

`--heads` takes each branch the plan names, and the head of each pull request that step 2
found. Then another round's pull requests do not wake this round. For `pr <n>`, give its
`headRefName`. A pull request from a fork has no head to give, so leave out `--heads`:
then every pull request wakes the round. Hold the watch's task id in the conversation. Do
not arm a second watch while this one runs.

Each line the watch writes is a wake. The other wake is an agent's completion
notification.

- On expiry, arm the watch again. Give it `--since-head` and `--concluded`, and build both
  from the full heads you know. A concluded head goes in `--concluded`; every other head
  goes in `--since-head`. Each flag takes one comma-separated list of
  `<number>=<full 40-character sha>` pairs, for example
  `--concluded 302=<full sha>,303=<full sha>`. The new watch then stays silent about what
  it already said.
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

Add `--substantial`, `--round-1-head <sha>` and `--rot-checked` to `pr-state` when the
markers say so.
