---
name: shepherd
description: >
  Merge a repository's open `dependencies` pull requests one at a time: rebase
  each, wait for CI, fix mechanical failures, skip anything that needs a logic
  change, and let auto-merge land it before moving to the next. Only pull
  requests a human has already marked for auto-merge are touched. Scope is
  detected from the working directory: inside a git repo it shepherds that
  repo; outside one it shepherds every immediate subdirectory that is a git
  repo, one subagent per repo in parallel. Never merges by hand, never enables
  auto-merge, never bypasses a check.
allowed-tools: Bash, Agent
disable-model-invocation: true
---

Shepherd the `dependencies` pull requests of the current checkout, or of every checkout one
level down, to merge. Serial within a repo, parallel across repos.

## Step 1 — Discover

```bash
S="${CLAUDE_PLUGIN_ROOT}/scripts"
python3 "$S/lib/discover.py" "$PWD"
```

One path per line. If there are none, say "No git repositories directly inside <cwd>" and
stop. Do not classify the directory yourself; the library already did.

## Step 2 — Status

For each path:

```bash
python3 "$S/gh-shepherd-status.py" <path>
```

Read `targets` and `skipped_no_automerge`. A repo with no targets gets no agent; report it in
one line, including any `skipped_no_automerge` entries so the user can enable auto-merge and
rerun. If the user passed `--dry-run`, print each repo's target list in order (number, title,
author, `mergeStateStatus`, `checks.state`) and stop here.

## Step 3 — Shepherd

Launch one `shepherd-repo` agent per repo that has targets, all in a single message so they
run in parallel. On a first run each agent gets exactly one argument, the repo path, and
returns a JSON report. Do not start a second agent for the same repo, and do not shepherd a repo yourself:
the serial-within-a-repo guarantee lives in the agent.

If the user named a single repo with `--repo <path>`, shepherd only that one.

## Step 4 — Verify the blocked entries

Auto-merge fires on GitHub's own schedule, and a pull request can merge in the seconds between
the worker's last read and its report. One `blocked` shape is that race's signature: a
`mergeStateStatus` of `CLEAN` or `UNKNOWN` **with** `autoMerge` true and nothing named against
it. For each such entry, once:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/gh-shepherd-pr.py" <path> <n> merged
```

`merged: true` moves the entry to `merged` with its `mergeCommit`; anything else leaves it
blocked, unchanged. This is a read, and one round trip per entry. It never merges anything, and
it is not run for a `blocked` entry that names a cause (`BLOCKED`, `DIRTY`, `BEHIND`, or a
`reviewDecision`): those were decided by GitHub, not by timing.

## Step 5 — Report

Collate the agents' JSON into one table per repo:

| PR | Outcome | Detail |
| --- | --- | --- |
| #n | merged `sha` | rebases: 1; `merged_as` when the version differs from the title |
| #n | skipped | reason, comment URL |
| #n | blocked | `mergeStateStatus`, `reviewDecision`, `waited`, reason |
| #n | needs escalation | reason; `hypothesis` when present |
| #n | closed | reason |

Then list `skipped_no_automerge` per repo, and the `ci_seconds` each agent measured.

If any pull request needs escalation, offer to rerun just those with a larger model
(`shepherd-repo` with `model: opus`), and wait for the user's answer; do not rerun on your own.
When rerunning, dispatch one `shepherd-repo` agent per repo with the repo path plus the
escalated pull request numbers, each with its `reason` and, if present, `hypothesis`, so the
larger model works only those pull requests and starts from the first worker's diagnosis
instead of from zero.

If the `gh-security` plugin is installed, mention that `/gh-security:resolve-alerts` is the
natural next step: merging `dependencies` pull requests first usually shrinks the alert set
considerably.

## What this skill never does

Enable or disable auto-merge, merge a pull request by hand, bypass or re-run a required check,
resolve conflicts on a branch a human authored, or change a repository's merge method. Those
are the human's decisions; the report tells them where each one is needed.
