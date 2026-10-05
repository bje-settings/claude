# Map the files an issue touches

Every rule here comes from a round that lost time to its absence. Apply all of them
before you map the files. A map that skips one rule is a map that is already wrong.

## Start from the tree, not from the body

Grep for every path the issue names, and treat what the grep finds as the map. An issue
body written before the last three rounds names files that have moved or gone.

**When the issue body has been overruled**, by a ruling or by a question phase, redo the
map from scratch. Do not just amend it. A port that became a deletion touches records,
such as an RFC or an ADR amendment, that the port never would have touched. An amended
map keeps the shape of the plan it was written for.

## What a fix issue hides

- **For a `fix` issue, find the code path or the test that shows the defect today. Cite
  it in the sequencing comment.** If the defect no longer happens, the issue is already
  fixed. Do not schedule it. Comment the commit on the issue, and name the issue in the
  report. Round 12 scheduled #298 for a defect that `watch` had handled since #284, and
  the stream built a type rework instead.

## What a deletion touches

- **Map references by basename, not by the plugin or feature name**, and include
  `.claude/` in the search. A rule file that references a deleted fixture by its basename
  was missed by a map that grepped only for the plugin name.
- **For every file an issue deletes, grep the prose for invocations of it.** A skill or
  an agent that runs it as a script is a caller, not a document to reword. Map each
  invocation to whichever layer ports its entry point. A skill step that ran a deleted
  script surfaced only after the deletion had landed.
- **Ask whether a directory becomes empty**, then grep the test tree for that directory's
  path. Git tracks no empty directory, and a test that walks one throws when it goes.

## What a new name touches

- **A new top-level directory is a collision class of its own, and a file list cannot
  show it.** Grep every toolchain in the tree for that NAME as an import, a package, a
  glob or a path:

  ```bash
  git grep -nw lib -- '*.py' '*.toml' '*.json' '*.yml' '*.yaml' '*.ts'
  ```

  A root `lib/` made ruff reclassify a plugin's own `lib` imports and failed four
  untouched test files.

- **Grep the gate configs for every directory an unblocked issue creates**: the
  type-check include list, the coverage source set, the linter's file set, the CI job
  filters. A comment that promises later issues will not need to edit a config file is a
  claim to check, not a fact to trust.

## What a contract change touches

- **When a command's exit status, stdout, or argv changes, trace every caller to the
  line where the status is consumed. Quote that line.** "The hook is unaffected because
  it reads output, not status" was drawn from one line, and was wrong: the hook read the
  status first, and discarded the output.
- **A job added to a CI workflow is a collision by itself.** Two issues that each add one
  collide, whatever else their diffs do.
- **Map a README or a skill by section.** Step 5 of `SKILL.md` must know if two issues
  rewrite one section or two.

## What a changed behaviour touches

- **When an issue adds or removes a behaviour, grep for text that describes or counts
  it.** Search the manifests (`hooks.json`, `plugin.json`, agent files), the READMEs
  and the tests. #303 added a third guard rule. `hooks.json` said "two things", and
  `agents/stream.md` said "two of the brief's rules". `hook.test.ts` pins the `hooks.json`
  description by exact string. Ruling 14 on #299 had to add `hooks.json` and its test
  mid-round.
- **When an issue changes what a command function receives, such as its injected client
  or options, map the dispatcher that builds it.** #304 changed the `watch` client, and
  `plugins/workstreams/scripts/workstreams.ts` builds that client.

## What the records say

- **Read the Decisions lists in `docs/rfc/` and `docs/adr/` for the scope**, and
  check each decision against what has merged. A requirement can sit in an ADR, absent
  from every issue body, and still bind the work. A sweep that reads the bodies alone has
  missed one twice. Each time, the miss surfaced only in a review round.
- **A design record can imply a dependency the tracker does not carry.** Fix it as a
  relationship field on the issue, never as a sentence in a comment.

## What an acceptance line can hide

- **An acceptance line can be physically impossible.** Byte-for-byte or string equality
  across two runtimes, two languages, or two libraries is one example. Probe it with a
  ten-line script before the question phase. Do not hand it to a stream.
- **An acceptance line can name a later issue's work.** That makes it a blocker the
  tracker does not carry.

## The comment-only column

Say which files a layer may touch **in comments only**, as a column of the map. Without
that column, a layer corrects stale comments across files that belong to another layer,
by analogy. Nobody can then tell an allowed edit from an overreach. Check that column
against a diff with the comment lines stripped.

## Size

Estimate the review's cost as well as the cost to build the code. Reviews have made up
54% and 61% of a round's tokens. The two-round rule on a top layer of new behaviour is
where that cost sits. Record the estimate. Record the actual cost at round end, so the
next estimate has something to stand on.
