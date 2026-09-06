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
applier are subagents that return once and schedule nothing; the review itself runs here. Scripts are called by path, never
through a variable holding a command string (a Bash tool running zsh does not split one):
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/<script>"`. Every `ft-harden-state.sh` command takes the
`<plugin:skill>` being hardened as its first argument, after the command word.

Write every transition to state **before** taking the next action. The state file is what a
resumed session reads; acting first and recording after is how the same fix gets made twice.

## Step 1: Preflight and set up

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-preflight.sh"
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.sh" init <plugin:skill>
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.sh" add-target <plugin:skill> <path> --repo <owner/name>
```

`add-target` once per target, in the order given; `--repo` is `gh repo view --json nameWithOwner`
run in that directory. Stop with the install hints if preflight exits 1 (a `detail` field, when
present, says why a check failed), or with its stderr line if it exits 4. If a run already exists
(`init` exits 3), show it with `show <plugin:skill>` and ask whether to resume it or start over
with `--force`; never `--force` on your own, since the targets already worked are what would be
lost. Pass `--model` and `--effort` to `init` only when the user asked for a size; the defaults
are `opus` and `high`.

Read the repository conventions of each target once now: its `CLAUDE.md` and `.claude/rules/`
decide branch names, worktree locations, install commands, and commit style. The briefs below
quote them rather than inventing any.

## Step 2: Take the next target

```bash
TARGET="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.sh" next <plugin:skill>)"
```

Nothing printed means every target is finished: go to Step 7. A target whose status is already
`paused` comes back from `next` on purpose. Do not step over it: report its question and stop.

Otherwise set the target `running`, and work the phases below in order, writing the phase before
each. The command shape for every write is:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-harden-state.sh" set <plugin:skill> "$TARGET" <field> <value>
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
JSON numbers; `ft-collect.sh <run-dir> --report` prints the table it ended with) and check it:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-verify-report.sh" <report.json>
```

- Exit 0: every claim holds.
- Exit 1: the report and GitHub disagree. Each mismatch is a finding like any other: render it
  with `ft-issue.sh render`, show it to the user, file it, and add it to `issues`. A report that
  is wrong about what it merged is usually the most valuable finding of the round.
- Exit 3: the report named no pull requests. For a skill that is supposed to touch pull requests
  that is itself a finding (the report was missing or unreadable); for one that legitimately had
  nothing to do, note it in the summary and carry on.
- Exit 2 or 4: the report or gh could not be read. Fix the report (a missing `repo`, a number
  written as a string) and run it again; a gh failure pauses the target with the message.

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

**Review** (`phase review`). Review the PR **in this session**, the way `/workstreams:run` does:
invoke `/pr-review-toolkit:review-pr` on it, read the bot and human review comments already on it
(`gh pr view <n> --repo <repo> --json reviews,comments` and
`gh api "repos/<repo>/pulls/<n>/comments"`), and open the code behind every finding before acting
on it. A finding is a claim, not a fact. Drop the ones that do not hold, keeping each reason for
the summary. `review-pr` runs here rather than inside a subagent because its analyzer agents wake
whoever invoked them, and a subagent gets no such wake (issue #62).

Hand what survives to `workstreams:applier` as a filled-in `apply-prompt.md`. An `error` from the
applier pauses the target with that error, naming the findings it had already applied. Repeat the
review once if the applied changes were substantial; if a second round is also substantial, pause
the target rather than starting a third.

**Merge** (`phase merge`). Only once review applies nothing:

```bash
gh pr ready <n> --repo <repo>
gh pr merge <n> --repo <repo> --auto --<the repo's merge method from gh repo view>
bash "${CLAUDE_PLUGIN_ROOT}/scripts/ft-wait-pr.sh" <repo> <n> --timeout 540
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
- Exit 4 (gh could not answer): schedule one wake at least 600 seconds out and try the wait once
  more on return; a second exit 4 pauses the target with the stderr text.
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
carry a review loop of its own: `/workstreams:run` and `pr-review-toolkit` own that shape, and it
is reused here rather than restated.
