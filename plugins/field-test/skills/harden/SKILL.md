---
name: harden
description: >
  Run the hardening loop for one skill against an ordered list of field-test targets: field-test
  it in each repository with /field-test:run, verify what it claimed against GitHub, fix the
  findings in one PR per round through a workstreams worker, review, merge, and move to the next
  target. Stops only when every target is clean or a finding needs a decision a person has to
  make. Resumable: the loop's state is on disk and re-running picks it up.
allowed-tools: Bash, Read, Skill, Agent, ScheduleWakeup, AskUserQuestion
disable-model-invocation: true
---

Invocation: `/field-test:harden <plugin:skill> --targets <repo-path>...`

Harden one skill against the repositories named in `--targets`, in the order given. Targets are
explicit: there is no discovery in this version, and a target list you did not write is a list
you cannot reason about.

This skill runs in the main session. Only the main session schedules wakes; the worker and the
applier are subagents that return once and schedule nothing, and the review round runs here
because `/pr-review-toolkit:review-pr` wakes whoever dispatched its analyzers, and a subagent gets
no such wake (issue #62). Scripts are called by path, never through a variable holding a command
string (a Bash tool running zsh does not split one):
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/<script>.py"`. Every `ft-harden-state.py` command takes
the `<plugin:skill>` being hardened as its first argument, after the command word.

Write every transition to state **before** taking the next action. The state file is what a
resumed session reads; acting first and recording after is how the same fix gets made twice.

## Step 1: Preflight and set up

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-preflight.py"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" init <plugin:skill>
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" add-target <plugin:skill> <path> --repo <owner/name>
```

`add-target` once per target, in the order given; `--repo` is `gh repo view --json nameWithOwner`
run in that directory. Stop with the install hints if preflight exits 1 (a `detail` field, when
present, says why a check failed).

`init` exiting 3 means a run for this skill is still in progress: show it with
`show <plugin:skill>` and ask whether to resume it or start over with `--force`; never `--force`
on your own, since the targets already worked are what would be lost. A file at that path `init`
cannot parse exits 3 as well, since there is no run in it to call finished; `show` says which of
the two it is, and `--force` is the way forward for both, archiving the file intact rather than
destroying it. A run whose targets are all
`done` or `failed` is not that case: `init` archives it itself, says on stderr where it went, and
carries on, so there is nothing to ask about. Pass `--model` and `--effort` to `init` only when
the user asked for a size; the defaults are `opus` and `high`.

Read the repository conventions of each target once now: its `CLAUDE.md` and `.claude/rules/`
decide branch names, worktree locations, install commands, and commit style. The briefs below
quote them rather than inventing any.

## Step 2: Take the next target

```bash
TARGET="$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" next <plugin:skill>)"
```

`next` exiting non-zero is not an empty list: the state file describes a target no command could
act on (a status outside the vocabulary, a path that is not a string). Stop the loop and report
its stderr; the file needs a person, and continuing would work the wrong target or none.

Otherwise, nothing printed means every target is finished: go to Step 7. Unless the run has no
targets at all, which `show <plugin:skill>` says: `add-target` never landed, so there is nothing
to report or archive. Say so and stop. A target whose status is
already `paused` comes back from `next` on purpose. Do not step over it: report its question and
stop.

A target that comes back `running` was started by a session that stopped. Read the run with
`show <plugin:skill>` and resume it at the `phase` recorded on that target, with its `pr` and
`review_rounds` as they stand. Only phase `field-test` starts at Step 3; `verify` starts at Step
4, `fix`, `review`, and `merge` at their part of Step 5, and `summary` at Step 6. Starting a
`running` target over would field-test a repository whose issues are already filed and open a
second pull request for them.

A `pending` target starts at Step 3. Set it `running` first, and work the phases below in order,
writing the phase before each. The command shape for every write is:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" set <plugin:skill> "$TARGET" <field> <value>
```

written below as `set "$TARGET" <field> <value>`. A `set` that exits non-zero stops the loop with
its message: the state is what the next tick reads, so continuing past a failed write would do
the same work twice.

## Step 3: Field test (`phase field-test`)

Invoke `/field-test:run <plugin:skill>` with the `Skill` tool, running in the target directory.
That skill does the observing and the filing; this one records what came back:

```bash
set "$TARGET" issues '[<issue numbers it filed>]'
```

Then verify, always. A clean field test with a wrong final report is exactly the case Step 4
exists for.

## Step 4: Verify the report (`phase verify`)

The target skill's own final table is a claim. Write it to a report file
(`{"repo": "...", "prs": [{"number": N, "claimed": "merged|closed|open|skipped"}]}`, numbers as
JSON numbers; `ft-collect.py <run-dir> --report` prints the table it ended with) and check it:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-verify-report.py" <report.json>
```

- Exit 0: every claim holds.
- Exit 1: the report and GitHub disagree. Each mismatch is a finding like any other: render it
  with `ft-issue.py render`, show it to the user, file it, and add it to `issues`. A report that
  is wrong about what it merged is usually the most valuable finding of the round. The exception
  is a mismatch whose `reason` begins `could not be read on GitHub`: that is gh, not the target,
  and filing it blames the report for a call that never landed. Run the whole verification once
  more, and pause the target with that reason if the same claim comes back unreadable.
- Exit 3: the report named no pull requests. For a skill that is supposed to touch pull requests
  that is itself a finding (the report was missing or unreadable); for one that legitimately had
  nothing to do, note it in the summary and carry on.
- Exit 2: the report could not be read. Fix it (a missing `repo`, a pull request number that is
  not a number) and run it again.
- Exit 4: gh answered for nothing, or failed the same way more than once part-way through, so the
  claims were not checked; or the script hit an arm of its own. Nothing here is a finding about
  the target: run it once more, and pause the target with the stderr text if it says the same
  thing again.

No findings from the field test and no mismatches: skip to Step 6 and summarise the target as
clean.

## Step 5: Fix, review, merge

**Fix** (`phase fix`). Fill in `fix-prompt.md` from this directory and start one worker with the
`Agent` tool: `subagent_type` `workstreams:stream-<effort>` and `model` from the run's state
(`show` prints them). One worktree, one draft PR, closing every issue of the round. On `draft`,
record `set "$TARGET" pr <n>`. If the worker returns `paused`, or the issues plainly do not fit
one PR, set the target `paused` with its question and stop the loop: that is a decision for a
person. If it returns `failed`, or no JSON block at all, set the target `failed` with the error
as its `question` and go to Step 6: the findings stay filed as issues for a person to pick up.

**Review** (`phase review`). Count the round before running it, and only when it has not been
counted: `review_rounds` counts rounds *scheduled*, so a session that stopped mid-round knows the
round it is picking up was already counted. Read it from `show <plugin:skill>`; when it is `0`,
count this one, and at any other value the round about to run was counted already and nothing is
written:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" bump <plugin:skill> "$TARGET" review_rounds
```

Then run it with the `Skill` tool:

`/workstreams:review <n> --worktree <the worker's worktree> --base <the PR's base branch> --model <the run's model>`

`<n>` is the pull request number. The round is `/workstreams:review`'s, invoked here rather than
restated: it reviews, reads the PR's own bot and human threads, verifies every finding against the
code, applies the ones that hold through `workstreams:applier`, replies on the threads, and
returns one JSON block.

Decide on what it returned by the definition of substantial and cosmetic in `/workstreams:review`'s
Return section, read off the `diffstat` in its block:

- **Substantial, and `review_rounds` is 1**: `bump` it to 2 and run the round again from the top of
  this phase. One repeat, because a round that changed the diff that much reviewed a different PR
  than the one that now exists.
- **Substantial, and `review_rounds` is 2 or more**: `set "$TARGET" status paused` with the
  question `PR #<n> has applied substantial review changes twice; decide whether it needs a rethink or another pass`.
- **Cosmetic, or nothing pushed**: fall through to the merge step below.
- **`error` with `error_status` 4**: gh itself failed inside the round. Report it, leave the target
  where it is, and try the round again rather than pausing: a rate limit is not a decision for a
  person.
- **`error` for any other reason**: pause the target with that error, naming the findings it had
  already applied.

Keep every rejected finding with its reason for the summary.

**Merge** (`phase merge`). Only once a review round applied nothing, or only cosmetic changes:

```bash
gh pr ready <n> --repo <repo>
gh pr merge <n> --repo <repo> --auto --<the repo's merge method from gh repo view>
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-wait-pr.py" <repo> <n> --timeout 540
```

Check the exit code of `gh pr ready` and `gh pr merge --auto` before waiting: if either fails
(auto-merge disabled on the repository, a merge method the repository does not allow), pause the
target with the error. Waiting on a pull request that cannot merge is the loop that never ends.

Set the Bash tool's own `timeout` to `600000` for the wait: it blocks in the foreground on
purpose. Never arm a `Monitor` or a wake in place of it.

- `merged`: read the sha with `gh pr view <n> --repo <repo> --json mergeCommit --jq .mergeCommit.oid`,
  record `set "$TARGET" merge_sha <sha>`, and go to Step 6.
- `passed`: checks are green and auto-merge has not landed it yet. Schedule a wake at least 600
  seconds out and wait again on return. After three `passed` results in a row, pause the target
  with the question `PR #<n> is green but auto-merge has not merged it; check its rulesets`.
- `pending`: schedule a wake at least 1200 seconds out and continue from here on return.
- Exit 4 (gh could not answer, or the wait hit an arm of its own): schedule one wake at least 600
  seconds out and try the wait once more on return; a second exit 4 pauses the target with the
  stderr text.
- Exit 5 (there is no such pull request): pause the target with the stderr text at once. The
  number or the repository is wrong, and no amount of waiting turns that into a merge.
- `failed`: read the failure. A **mechanical** one (a lint rule, a spec the fix broke, a
  formatting check) goes back to the fix step **once**, with the failure quoted in the brief.
  Anything that would change behaviour pauses the target with the question. One retry, not a
  loop: a second mechanical failure on the same PR is a sign the fix is wrong, not unlucky.

## Step 6: Summarise the target (`phase summary`)

Fill in `summary-template.md` and store it with `set "$TARGET" summary "<text>"`. Set the target
`done` unless Step 5 already set it `failed`, then go back to Step 2.

## Step 7: Report and archive

Print every target's summary in one table, in order, then stop the loop with `ScheduleWakeup`
`stop: true`. Below the table: every paused target with the exact question it is waiting on, and
every issue filed that did not end up in a merged PR.

Then archive the run, but only if it is over:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" finished <plugin:skill>
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" archive <plugin:skill>
```

Run `archive` only when `finished` exits 0, and print the path it prints so the user knows where
the record went. Exit 3 means the run is not over: leave the file where it is. Any other exit is a
failure to report and stop on, since it says nothing about whether the run finished. A run holding
a `paused` target is not finished: its file stays where it is, so the user can answer the question
and re-run this skill. Never pass `--force` here.

## Out of scope

Approving PRs; bypassing a check, a ruleset, or a required review; and deciding what counts as a
mechanical fix beyond the definitions `/gh:shepherd` already carries. This skill also carries no
review round of its own: `/workstreams:review` is the round, and it is invoked here rather than
restated.
