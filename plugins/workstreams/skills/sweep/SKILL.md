---
name: sweep
description: >
  Find the work a round can start on. Reads a repository's open milestones and issue
  dependencies, reports the unblocked set and the tier one issue behind it, reads the
  bodies and the decision records, maps the files each issue touches, sizes each one,
  sequences them into parallel streams, a stack, or one pull request, and posts the
  sequencing comment on every affected issue. Use it before planning a round of work,
  or on its own to find out what is reachable.
allowed-tools: Bash, Read, Grep, Glob
disable-model-invocation: true
---

The command answers the deterministic half: which issues are unblocked, which are one
issue behind that, and which are further out. Everything below it is reading.

## Step 1: preflight

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight
```

Exit 1 means something is missing. Print each hint verbatim and stop.

## Step 2: sweep

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" sweep --json
```

Add `--milestone 4` or `--milestone 4,5` when the user named milestones. Read the JSON.

`unavailable` non-empty means the sets are short of what was asked for. Say so and stop,
unless the user tells you to plan on a partial read; sequencing against a blocker graph
with a hole in it is how an issue gets dispatched before its blocker lands.

No open pull requests is a precondition for a round. If `pullRequests` is not empty, name
each one before going on: a round planned around a branch someone else is about to merge
collides on files the sweep cannot see.

## Step 3: read, do not remember

For every issue in the unblocked set and the next tier, read the full body **and every
comment**. A findings comment is often the specification; the body is often out of date.

Then read the decision records for the milestone: every file under `docs/rfc/` and
`docs/adr/`, the Decisions lists in particular, and check each decision against what has
actually merged. A requirement recorded in an ADR and absent from every issue body is
still a requirement, and it has been missed twice.

Every factual claim you are about to write down gets cited to a line you have just read.
Grep for it; do not recall it. Three sweeps have asserted something about a test file, a
CI job or a caller that was not there.

## Step 4: map the files

Read `file-map.md` and apply every rule in it before writing a file map. It is the
accumulated list of what file maps have missed, each rule from a round that lost time to
it.

## Step 5: classify and size each issue

Per issue, answer in this shape:

- **Classification**: work now, defer with a reason, or blocked on another issue.
- **Touched files and regions**, from step 4, including the ones it may touch in comments
  only.
- **Sizing**: model and effort, with the reason. Say what the review is likely to cost as
  well as the stream: reviews have been 54% and 61% of a round's tokens, and a sizing that
  counts only the writing understates the round by half.
- **Cross-repository dependencies**, if any.

## Step 6: sequence

Collisions first. Two issues collide when they touch the same file or region, when both
add a job to the same CI workflow (adding a job is a collision by itself, whatever else
the diffs do), or when one creates something the other reads.

Then choose the shape, in this order:

1. **One pull request closing both issues** when the changes cannot be reviewed or merged
   apart. The tell is explicit and easy to check: if layer N's diff would contain a
   reference to something layer N+1 introduces, they are not separable. Splitting them
   manufactures findings that cannot exist in one pull request, serialises the round, and
   forces a mid-round rebase.
2. **A stack** when the changes are genuinely separable but ordered, and each layer has
   independent review or merge value: someone would plausibly approve or ship one without
   the other.
3. **Parallel streams** when the file sets are disjoint.

Overlap alone is not a reason to stack.

## Step 7: post the sequencing comment

One comment, posted on **every** issue in the round and on every issue the round unlocks,
so it can be found from whichever issue someone opens. It carries the unblocked set, the
next tier, the file map, the collisions, the recommended shape with its argument, the
sizing, and the hidden dependencies, each cited.

Every hidden dependency is checked against the code before the comment is posted. The last
sweep that stated one from the issue bodies alone was wrong about it, and the correction
changed the round's scope.

End the comment with a line naming the effort and the date:

```
_Recorded by <effort name>, <date>._
```

Show the comment before posting it.

## Step 8: report

Four things, in this order:

1. The unblocked set, with what each issue is.
2. The stream shape, with the argument for it.
3. What the round unlocks when it lands.
4. What nothing can reach yet, and what it is waiting on.
