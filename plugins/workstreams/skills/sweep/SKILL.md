---
name: sweep
description: Find the work a round can start on, and say how it should be sequenced.
argument-hint: [milestone]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" *) Read Grep Glob
disable-model-invocation: true
---

Milestones to sweep: $ARGUMENTS. Ask which milestones the round covers when that is empty.

## Process

1. Preflight.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight
   ```

   Exit 1 means something is missing. Print each hint verbatim and stop.

2. Sweep the tracker.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" sweep --json
   ```

   Add `--milestone 4` or `--milestone 4,5` when the user named milestones.

   `unavailable` non-empty means the sets are short of what was asked for. Say so and stop,
   unless the user tells you to plan on a partial read.

   If `pullRequests` is not empty, name each one before going on.

3. Read, do not remember. For every issue in the unblocked set and the next tier, read the
   full body **and every comment**. A findings comment is often the specification; the body
   is often out of date.

   Then read the decision records for the milestone: every file under `docs/rfc/` and
   `docs/adr/`, the Decisions lists in particular, and check each decision against what has
   actually merged.

   Every factual claim you are about to write down gets cited to a line you have just read.
   Grep for it; do not recall it. Three sweeps have asserted something about a test file, a
   CI job or a caller that was not there.

4. Map the files. Apply every rule in [file-map.md](file-map.md), the rules a file map has
   to apply, before writing one.

5. Classify and size each issue, in this shape:

   - **Classification**: work now, defer with a reason, or blocked on another issue.
   - **Touched files and regions**, from step 4, including the ones it may touch in comments
     only.
   - **Sizing**: model and effort, with the reason. Say what the review is likely to cost as
     well as the stream; [file-map.md](file-map.md) carries the figures to size against.
   - **Cross-repository dependencies**, if any.

6. Sequence. Collisions first. Two issues collide when they touch the same file or region,
   when both add a job to the same CI workflow (adding a job is a collision by itself,
   whatever else the diffs do), or when one creates something the other reads.

   Then choose the shape, in this order:

   1. **One pull request closing both issues** when the changes cannot be reviewed or merged
      apart. The tell is explicit and easy to check: if layer N's diff would contain a
      reference to something layer N+1 introduces, they are not separable.
   2. **A stack** when the changes are genuinely separable but ordered, and each layer has
      independent review or merge value: someone would plausibly approve or ship one without
      the other.
   3. **Parallel streams** when the file sets are disjoint.

7. Post the sequencing comment. One comment, posted on **every** issue in the round and on
   every issue the round unlocks. It carries the unblocked set, the next tier, the file map,
   the collisions, the recommended shape with its argument, the sizing, and the hidden
   dependencies, each cited.

   Every hidden dependency is checked against the code before the comment is posted. The last
   sweep that stated one from the issue bodies alone was wrong about it, and the correction
   changed the round's scope.

   End the comment with a line naming the effort and the date:

   ```
   _Recorded by <effort name>, <date>._
   ```

   Show the comment before posting it.

8. Report four things, in this order:

   1. The unblocked set, with what each issue is.
   2. The stream shape, with the argument for it.
   3. What the round unlocks when it lands.
   4. What nothing can reach yet, and what it is waiting on.
