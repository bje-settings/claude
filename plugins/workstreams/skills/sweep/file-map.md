# Mapping the files an issue touches

Every rule here comes from a round that lost time to its absence. Apply all of them before
writing a file map; a map that skips one is the map that has already been wrong.

## Start from the tree, not from the body

Grep for every path the issue names, and treat what the grep finds as the map. An issue
body written before the last three rounds names files that have moved or gone.

**When the issue body has been overruled**, by a ruling or by a question phase, redo the
map from scratch rather than amending it. A port that became a deletion touches records
(an RFC, an ADR amendment) that the port never would have, and an amended map keeps the
shape of the plan it was written for.

## What a deletion touches

- **Map references by basename, not by the plugin or feature name**, and include
  `.claude/` in the search. A rule file referencing a deleted fixture by its basename was
  missed by a map that grepped for the plugin name.
- **For every file an issue deletes, grep the prose for invocations of it**: a skill or an
  agent that runs it as a script is a caller, not a document to reword, and each
  invocation has to be mapped to whichever layer ports its entry point. A skill step
  running a deleted script surfaced only after the deletion had landed.
- **Ask whether a directory becomes empty**, then grep the test tree for that directory's
  path. Git tracks no empty directory, and a test that walks one throws when it goes.

## What a new name touches

- **A new top-level directory is a collision class of its own, and a file list cannot show
  it.** Grep every toolchain in the tree for that NAME as an import, a package, a glob or
  a path:

  ```bash
  git grep -nw lib -- '*.py' '*.toml' '*.json' '*.yml' '*.yaml' '*.ts'
  ```

  A root `lib/` made ruff reclassify a plugin's own `lib` imports and failed four untouched
  test files.

- **Grep the gate configs for every directory an unblocked issue creates**: the type-check
  include list, the coverage source set, the linter's file set, the CI job filters. A
  comment promising that later issues will not have to edit a config file is a claim to
  check, not a fact to rely on.

## What a contract change touches

- **When a command's exit status, stdout or argv changes, trace every caller to the line
  where the status is consumed, and quote that line.** "The hook is unaffected because it
  reads output, not status" was drawn from one line and was wrong: the hook read the status
  first and discarded the output.
- **Adding a job to a CI workflow is a collision by itself.** Two issues that each add one
  collide whatever else their diffs do.

## What the records say

- **Read the Decisions lists in `docs/rfc/` and `docs/adr/` for the milestone**, and check
  each decision against what has merged. A requirement can be recorded in an ADR, absent
  from every issue body, and still binding; the sweep has read the bodies alone and missed
  one twice, each time surfacing only in a review round.
- **A design record can imply a dependency the tracker does not carry.** Fix it as a
  relationship field on the issue, never as a sentence in a comment.

## What an acceptance line can be hiding

- **An acceptance line can be physically impossible.** One naming byte or string equality
  across two runtimes, two languages or two libraries is a claim to probe with a ten line
  script before the question phase, not to hand to a stream.
- **An acceptance line can name a later issue's work**, which makes it a blocker the
  tracker does not carry.

## The comment-only column

Say which files a layer may touch **in comments only**, as a column of the map. Without it
a layer corrects stale comments across files that belong to another layer by analogy, and
nobody can tell an allowed edit from an overreach. A diff with comment lines stripped is
how that column is checked.

## Sizing

Estimate the review as well as the writing. Reviews have been 54% and 61% of a round's
tokens, and the two-round rule on a top layer of new behaviour is where the cost sits.
Record the estimate, then record the actual at round end, so the next estimate has
something to stand on.
