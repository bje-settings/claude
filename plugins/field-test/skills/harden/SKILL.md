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
reviewer are subagents that return once and schedule nothing. Scripts are called by path, never
through a variable holding a command string (a Bash tool running zsh does not split one):
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
present, says why a check failed). If a run already exists (`init` exits 3), show it with
`show <plugin:skill>` and ask whether to resume it or start over with `--force`; never `--force`
on your own, since the targets already worked are what would be lost. Pass `--model` and
`--effort` to `init` only when the user asked for a size; the defaults are `opus` and `high`.

Read the repository conventions of each target once now: its `CLAUDE.md` and `.claude/rules/`
decide branch names, worktree locations, install commands, and commit style. The briefs below
quote them rather than inventing any.

## Step 2: Take the next target

```bash
TARGET="$(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.py" next <plugin:skill>)"
```

Nothing printed means every target is finished: go to Step 7. A target whose status is already
`paused` comes back from `next` on purpose. Do not step over it: report its question and stop.

Otherwise set the target `running`, and work the phases below in order, writing the phase before
each. The command shape for every write is:

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
  is wrong about what it merged is usually the most valuable finding of the round.
- Exit 3: the report named no pull requests. For a skill that is supposed to touch pull requests
  that is itself a finding (the report was missing or unreadable); for one that legitimately had
  nothing to do, note it in the summary and carry on.
- Exit 2: the report could not be read. Fix it (a missing `repo`, a pull request number that is
  not a number) and run it again.
- Exit 4: gh answered for nothing, so no claim was checked, or the script hit an arm of its own.
  Nothing here is a finding about the target: run it once more, and pause the target with the
  stderr text if it says the same thing again.

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

**Review** (`phase review`). Fill in `review-prompt.md` and start `workstreams:reviewer` on the
PR. Repeat until a pass applies nothing. An `error` from the reviewer pauses the target with that
error; the review did not run, so nothing has been checked.

**Merge** (`phase merge`). Only once review applies nothing:

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

## Step 7: Report

Print every target's summary in one table, in order, then stop the loop with `ScheduleWakeup`
`stop: true`. Below the table: every paused target with the exact question it is waiting on, and
every issue filed that did not end up in a merged PR.

## Out of scope

Approving PRs; bypassing a check, a ruleset, or a required review; and deciding what counts as a
mechanical fix beyond the definitions `/gh:shepherd` already carries. This skill also does not
review PRs itself: `workstreams:reviewer` and `pr-review-toolkit` own that, and a second review
loop here would drift from theirs.
