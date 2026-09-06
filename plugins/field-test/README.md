# field-test

Plugin quality assurance: run a skill under observation, and turn what went wrong into issues
somebody who did not watch the run can reproduce. One skill so far, `/field-test:run`. The skill
directory has a `FLOW.md` with the decision diagram.

This is not a test runner. The specs in `spec/` cover the deterministic parts; a field test
covers the part specs cannot, which is how a skill behaves against a real repository in a state
nobody thought to write a fixture for. The point of the run is to come out of it with those
fixtures.

## Requirements

| Requirement | Install |
| --- | --- |
| `gh`, logged in | `brew install gh && gh auth login` |
| `jq` | `brew install jq` |
| `python3` | ships with macOS |

A `plugin:skill` target has to be installed, since it is resolved through Claude's own plugin
registry rather than from a path. A project or user command or skill is found on disk.

## `/field-test:run <target> [args...]`

Targets are `plugin:skill`, or the bare name of a project or user command or skill. A Workflow
target is refused: whether a background workflow agent's tool calls reach these hooks, and under
which session id, is unknown, and a field test that silently records nothing is worse than one
that says no.

1. Resolve the target, and with it the plugin, its version, and the commit of the marketplace
   checkout when it was added from a local directory.
2. Write the run marker. From here the hooks record.
3. Invoke the target with its arguments unaltered, and observe. The target is not told.
4. Collect the recorded events into candidate findings.
5. Decide which candidates are real problems and which are the target working correctly. That
   decision is the skill's, not a script's.
6. Render each real finding into an issue, redacted unless the repository under test is in the
   same enterprise as the plugin, check for an open issue with the same signature, show it to the
   user, and create it on a yes.
7. Summarise: every finding, what was decided, and the issue number or the reason it was not
   filed.

### Findings

| Kind | Raised when |
| --- | --- |
| `denied` | The `PreToolUse` hook refused a command on the deny list. Highest severity. |
| `deny_list_error` | A deny-list rule did not compile, so it was skipped and blocked nothing for the whole run. High severity: it is a hole in the guardrail, not a finding about the target. |
| `hook_error` | A hook raised on one tool call, so that call was neither recorded nor filtered. High severity, and about this plugin rather than the target. |
| `tool_failure` | A Bash tool call failed outright. |
| `bash_nonzero` | A Bash call exited non-zero. |
| `subagent_contradiction` | A subagent's last message claims success while its recorded events hold a failure that was never resolved by re-running the same command. |
| `args_dropped` | An option given to the target never reached any command it ran. |

Identical findings collapse on their signature, which normalises numbers and whitespace so the
same bug on a different PR number is one finding, and matches an issue already open for it.

### Redaction

A field test is often run against a repository that has nothing to do with the plugin's
enterprise. Findings from those runs are still worth having; the repository's name is not ours to
publish. `ft-enterprise.sh` asks GitHub once, per run, whether the plugin's owner and the target
repository's owner are organizations in one enterprise. Only a clear yes keeps the names: an
error, a token without the scope, an owner that is a user rather than an organization, and an
empty result all mean redact.

Redaction is literal string replacement, longest value first, over the remote URL, `owner/name`,
owner, name, checkout path, branch names, recent commit subjects, and the `#N` references seen
during the run. It is not regular expressions: a branch name or commit subject can contain
anything, and a pattern built out of one is a way to leak the name it exists to remove. The
redacted issue carries a line saying the run was outside the enterprise, so the shape reads as
real and the names read as placeholders.

## Hooks

Registered for the whole session, and doing nothing at all in a session that is not a field test:
the first thing each does is look for a run marker for the payload's session id, and there is
none. They are `python3`, not `jq`, because a hook runs on every tool call and should depend only
on what the machine already has.

| Hook | Records |
| --- | --- |
| `PreToolUse` (Bash) | Refuses a command matching `hooks/deny-list.txt` and records the attempt, plus any rule in that file that did not compile |
| `PostToolUse` (Bash) | Command, exit code, stderr tail, subagent id |
| `PostToolUseFailure` (Bash) | The same, for a call that failed outright. This payload carries no `tool_response`: the exit code is read from the first line of its `error` string and the rest of that string is the output |
| `SubagentStop` | The subagent's own transcript path and last message |
| `Stop` | Marks the run finished |

The cost in a session that is not a field test is one `bash` and one `python3` start, which
measures around 45 ms per Bash call on an M-series Mac and is all process startup: the hook reads
the payload, looks for a run marker, finds none, and returns. Reproduce it with

```bash
FT_STATE_DIR=/tmp/no-runs \
  bash plugins/field-test/hooks/ft-hook.sh PostToolUse < fixtures/field-test/hook-inputs/no-run.json
```

### The deny list

The one place a field test intervenes. It covers force-pushing without a lease, deleting a remote
branch, a mirror push, `filter-branch` and `filter-repo`, and a recursive delete of a rooted or
upward path. A denied command is recorded as the highest-severity finding: the target reaching
for it is the thing worth writing down.

Every rule is scoped to the one command it is about, not the whole line: `git push origin main &&
git branch -d feature` is a safe push followed by a local branch delete, and a rule that scanned
past the `&&` would refuse it and file the refusal as the run's headline finding. The recursive
delete rule finds the recursive flag and the force flag separately, so `rm -r -f /` and
`rm --recursive --force /` are refused alongside `rm -rf /`.

Every pattern has a denied sample in `fixtures/field-test/commands/deny.txt`, asserted one
pattern at a time, and `allow.txt` holds the near misses no pattern may match. Both files are
walked by the specs, so a pattern that stops matching, or starts matching too much, fails.

## State

`${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/runs/<session-id>/` holds `run.json` and `events.jsonl`,
the only two files the scripts and hooks own, beside whatever one run writes there for itself
(`resolved.json`, `names.json`). Nothing is cached: enterprise membership decides what gets
published, and a stale answer would decide it wrongly.

## Scripts

All deterministic, bash 3.2, spec'd under `spec/field-test/`.

| Script | Purpose |
| --- | --- |
| `ft-run.sh` | The run marker: `start`, `finish`, `show`, `dir` |
| `ft-resolve.sh` | Target to `{kind, plugin, skill, path, version, commit, repo}`; refuses Workflow targets |
| `ft-collect.sh` | Recorded events to candidate findings; `--report` prints the target's own final message |
| `ft-enterprise.sh` | Whether the plugin and the repository under test share an enterprise |
| `ft-redact.sh` | Text in, text out; identity inside the enterprise, placeholders outside |
| `ft-issue.sh` | `names`, `search`, `render`, `ensure-label` around filing a finding. Nothing here creates an issue; `ensure-label` creates or updates the `field-test` label, and `bug` is expected to exist already |

## Out of scope for now

Workflow targets, and any automatic fix. A field test observes and writes issues down; turning
those issues into merged fixes is a separate loop.
