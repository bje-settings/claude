---
name: sweep
description: Find the work a round can start on, and say how it should be sequenced.
argument-hint: [milestone]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob
user-invocable: false
---

Milestones to sweep: $ARGUMENTS. With no argument, sweep every milestone that has open issues
and report per milestone.

## Process

1. Sweep the tracker.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" sweep --json
   ```

   Add `--milestone 4` or `--milestone 4,5` for the milestones named above.

   A non-empty `unavailable` means the sets are short of what was asked for. Say so and
   stop.

   If `pullRequests` is not empty, name each one before you go on. A round planned around
   a branch someone else is about to merge collides on files the sweep cannot see.

   If nothing is unblocked, stop. Name the blocked issues (`blocked`) and how many there are.

2. Read, do not remember. For every issue in the unblocked set, read the full body **and
   every comment**. A findings comment is often the specification; the body is often out
   of date. Leave the blocked set alone: nothing there is read, mapped, sized, or
   commented on.

   Then read the decision records for the milestone: every file under `docs/rfc/` and
   `docs/adr/`, and the Decisions lists in particular. [file-map.md](file-map.md) has the
   check against what has merged.

   Every factual claim you are about to write down gets cited to a line you have just read.
   Grep for it; do not recall it.

3. Map the files. Apply every rule in [file-map.md](file-map.md) before writing one.

4. Classify and size each issue, in this shape:

   - **Classification**: work now, defer with a reason, or blocked on another issue.
   - **Touched files and regions**, from step 3. Include files it may touch in comments
     only.
   - **Size**: the model per layer, and the session effort the round runs at, with the
     reason. The stream agent inherits the session's effort. Say what the review is
     likely to cost as well as the stream. [file-map.md](file-map.md) carries the figures
     to size against.
   - **Cross-repository dependencies**, if any.

5. Sequence. Collisions first. Two issues collide when they touch the same file or
   region, when both add a job to the same CI workflow (a second job added is a collision
   by itself, whatever else the diffs do), or when one creates something the other reads.
   A shared version line, or separate sections of one README, is not a collision. One
   stream of the round owns each version line. Name it.

   Then choose the shape, in this order:

   1. **One pull request that closes both issues**, when the changes cannot be reviewed or
      merged apart, or when both rewrite the same section of one file. The tell for the
      first: layer N's diff would contain a reference to something layer N+1 introduces.
   2. **A stack**, when changes are ordered and in different regions, and a person would
      review or merge each layer alone.
   3. **Parallel streams**, when the file sets are disjoint.

6. Post the sequencing comment. Post one comment on **every** issue in the round. It
   carries the unblocked set and the file map. It names the collisions, the recommended
   shape with its argument, the size, and the hidden dependencies, each cited.

   Check every hidden dependency against the code before you post the comment.

   End the comment with a line that names the effort and the date:

   ```
   _Recorded by <effort name>, <date>._
   ```

7. Report four things:

   1. The unblocked set, with what each issue is.
   2. The stream shape, with the argument for it.
   3. What the round unlocks once it lands, from each issue's own `unlocks`.
   4. How many issues are blocked, and their numbers.
