---
name: shepherd
description: >
  Merge every open, non-draft pull request that has auto-merge set, one at a time, and each
  GitHub stack once every layer is ready. An optional argument narrows this to one label. A pull
  request that the review rules of its base do not allow yet (no approval, or unresolved review
  threads) is left out, unless `--all` is given. A stack is judged by the rules of its base, on
  every layer. Rebase each pull request, resolve its conflicts by merging the base branch into
  it, wait for CI, and fix failures that the base caused. This applies to any pull request,
  whether a human or a bot authored it. Let auto-merge land each one before you move to the
  next. Scope comes from the working directory. Inside a git repo, it shepherds that repo.
  Outside one, it shepherds every immediate subdirectory that is a git repo, one subagent per
  repo, in parallel. It never merges by hand, except a stack with gh stack merge. It never
  enables auto-merge, never force pushes, and never bypasses a check.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" *) Agent
argument-hint: "[label] [--all] [--dry-run]"
disable-model-invocation: true
---

Shepherd the open, auto-merge pull requests of the current checkout, or of every checkout one
level down. Serial within a repo, parallel across repos.

## Step 1: Discover

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" discover "$PWD"
```

One path per line. If there are none, say "No git repositories directly inside <cwd>" and
stop. Do not classify the directory yourself. The command already did that.

## Step 2: Status

Parse `$ARGUMENTS`: `--dry-run` and `--all` when present, and whatever text remains, if any, as
one label. Do not enforce a second label yourself; the script refuses it.

For each path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" shepherd-status <path> [label] [--all]
```

Pass `--all` only when it was given. Read `targets` and `not_ready`. A repo with no targets gets no
agent. Report it in one line. If `--dry-run` was given, print each repo's target list in order
(number, title, author, `mergeStateStatus`, `checks.state`; for a stack, `stack`, `base` and
`layers`), then its `not_ready` entries with their `reasons` (for a stack, each `failing` layer
and its `reasons`), and stop here.

## Step 3: Shepherd

Launch one `shepherd-prs` agent per repo that has targets. Send them all in a single message, so
they run in parallel. Each agent gets the repo path, the ordered targets from `targets` (each
pull request number, and each stack as `stack:<s>`), `ci_seconds`, and whether `--all` is on,
and returns a JSON report. The agent takes a stack as one unit, with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" shepherd-stack <path> <s> <action>`. It does not run
`status` itself. Do not start a second agent for the same repo. Do not shepherd a repo yourself. The
serial-within-a-repo guarantee lives in the agent.

## Step 4: Verify the skipped entries

Auto-merge fires on GitHub's own schedule. A pull request can merge in the seconds between the
worker's last read and its report. One `skipped` shape is that race's signature: a
`mergeStateStatus` of `CLEAN` or `UNKNOWN` **with** `autoMerge` true, and no other cause named.
For each such entry, once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" shepherd-pr <path> <n> merged
```

A skipped stack with `result` `accepted` gets the same read for each of its `layers`. When
every layer reads `merged: true`, the stack moves to merged.

`merged: true` moves the entry to `merged`, with its `mergeCommit`. Anything else leaves it
skipped, unchanged. This is a read, and one round trip per entry. It never merges anything. It is
not run for a skipped entry that names a cause: `BLOCKED`, `DIRTY`, `BEHIND`, a
`reviewDecision`, "needs an approval" or "has unresolved review threads". GitHub decided those,
not timing.

## Step 5: Report

Collate the agents' JSON into one table per repo:

| PR | Outcome | Detail |
| --- | --- | --- |
| #n | merged `sha` | rebases: 1; each conflicted file and how it was resolved |
| #n | closed | reason |
| #n | skipped | reason; `hypothesis` when present; the conflicted files, when there were any |
| stack s | merged | each layer and its merge commit |
| stack s | skipped | each layer that failed, and the requirement, or gh's own words |

Then list each `not_ready` entry from step 2 as not shepherded, with its `reasons` ("needs an
approval", "has unresolved review threads"). For a stack, name each `failing` layer and its
`reasons`. Then list the `ci_seconds` each agent measured.

The `gh-security` plugin may be installed. When it is, and at least one pull request merged,
mention `/gh-security:resolve-alerts` as the natural next step. A merge of auto-merge pull
requests usually shrinks the alert set.

## What this skill never does

Never:
- enable or disable auto-merge
- merge a pull request by hand. The one exception is a stack: the agent runs `gh stack merge`
  through `shepherd-stack merge`, once every layer is ready, and GitHub applies the rules of the
  base to it
- bypass or re-run a required check
- force-push, a stack included
- change a repository's merge method

Those are the human's decisions. The report tells them where each one is needed.
