---
name: sweep
description: Find the work a round can start on, and say how it should be sequenced.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" *) Bash(gh issue view *) Bash(gh issue comment *) Read Grep Glob
user-invocable: false
---

Scope: $ARGUMENTS. A milestone or issue numbers scope the sweep. With no scope, sweep every
milestone that has open issues and report per milestone. The caller can name issues to leave
out: each one is in another round. The caller can also give an ordered list and a target
size (step 1, the walk).

## Process

1. Sweep the tracker.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" sweep --json
   ```

   Add `--milestone 4` or `--milestone 4,5` for the milestones named above, or
   `--issues 12,13` for the issues.

   A non-empty `unavailable` means the sets are short of what was asked for. Say so and
   stop.

   If `pullRequests` is not empty, name each one before you go on. A round planned around
   a branch someone else is about to merge collides on files the sweep cannot see.

   If nothing is unblocked, stop. Name the blocked issues (`blocked`) and how many there are.

   **Pass over.** Each pull request carries `files`, the paths it changes, and
   `filesComplete`. After step 3 maps an issue's files, pass the issue over for one of
   three reasons:

   - **Shared file**: an open pull request edits a file the issue would touch.
   - **Needed code**: an open pull request carries code the issue depends on.
   - **Short list**: an open pull request has `filesComplete` false. Its list is short, so
     it is a possible overlap. Pass over every issue, whatever files it touches, and name
     the short list as the overlap.

   This applies to every open pull request, also the viewer's. Do not plan an issue you
   pass over. Never stack a layer on a pull request the round does not own. Name each issue
   passed over, the pull request, and the overlap. Continue with the rest.

   **The walk.** The caller can give an ordered list of issues and a target size. Then take
   the unblocked issues in the caller's order, not in the order of the report. Do steps 2
   and 3 for each issue, then keep it or pass it over. An issue that is already fixed is
   neither, and does not count toward the target. Stop when you keep the target number of
   issues, 3 to 5 if the caller gives none, or at the end of the list. With no ordered
   list, there is no target: the walk reaches every unblocked issue. If the walk keeps
   none, stop and say so. Give the size of the set, and how many issues you passed over for
   each reason. The set is the caller's ordered list, or else the unblocked set.

2. Read, do not remember. For every unblocked issue that the walk reaches, read the full
   body **and every comment**. A findings comment is often the specification; the body is
   often out of date. Leave the blocked set alone: nothing there is read, mapped, sized, or
   commented on.

   Read the decision records for the scope once, before the walk's first issue: every file
   under `docs/rfc/` and `docs/adr/`, and the Decisions lists in particular.
   [file-map.md](file-map.md) has the check against what has merged.

   Every factual claim you are about to write down gets cited to a line you have just read.
   Grep for it; do not recall it.

   For a `fix` issue, check that the defect still happens. [file-map.md](file-map.md) says how,
   and what to do when it does not.

3. Map the files. Apply every rule in [file-map.md](file-map.md) before writing one.

4. Classify and size each issue, in this shape:

   - **Classification**: work now, defer with a reason, blocked on another issue, or
     already fixed, with the commit ([file-map.md](file-map.md)). An issue the caller
     leaves out is deferred, with its round as the reason. Do not read, map, size or
     comment on it. An issue passed over (step 1) is read and mapped, then deferred. Its
     reason names the pull request and the overlap. It is not blocked: step 2 leaves the
     blocked set alone.
   - **Touched files and regions**, from step 3. Include files it may touch in comments
     only.
   - **Size**: the build model and the review model per layer, and the session effort the
     round runs at, each with the reason. The stream agent inherits the session's effort.
     Say what the review is likely to cost as well as the stream.
     [file-map.md](file-map.md) carries the figures to size against.
   - **Cross-repository dependencies**, if any.

5. Sequence. Collisions first. Two issues collide when they touch the same file or
   region, when both add a job to the same CI workflow (a second job added is a collision
   by itself, whatever else the diffs do), or when one creates something the other reads.
   A shared version line, or separate sections of one README, is not a collision. One
   stream of the round owns each version line. Name it.

   Then choose the shape, in this order:

   1. **One pull request that closes both issues**, when nobody can review or merge the
      changes apart. The tell: layer N's diff would contain a reference to something layer
      N+1 introduces. Also when both rewrite the same section of one file.
   2. **A stack**, when changes are ordered and in different regions, and a person would
      review or merge each layer alone.
   3. **Parallel streams**, when the file sets are disjoint.

   Then fold small issues of one plugin, with disjoint files, into one stream: code with
   code, prose with prose. A reviewer must read the whole diff in one pass. Each extra
   pull request costs a review loop.

6. Post the sequencing comment. Post one comment on **every** issue in the round. It
   carries the unblocked set and the file map. It names the collisions, the recommended
   shape with its argument, the size, and the hidden dependencies, each cited.

   Check every hidden dependency against the code before you post the comment.

   End the comment with a line that names the primitive and the date:

   ```
   _Recorded by `workstreams:sweep` <date>._
   ```

7. Report five things:

   1. The unblocked set, with what each issue is. After a walk, the issues it kept.
   2. The stream shape, with the argument for it.
   3. What the round unlocks once it lands, from each issue's own `unlocks`.
   4. How many issues are blocked, and their numbers.
   5. Each issue passed over, with its pull request and overlap. Give the size of the set
      and how many issues you passed over for each reason.
