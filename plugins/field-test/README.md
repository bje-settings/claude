# field-test

Plugin quality assurance: run a skill under observation, turn what went wrong into issues
somebody who did not watch the run can reproduce, and keep going until they are fixed. Two
skills: `/field-test:run` observes one run; `/field-test:harden` loops it over a list of target
repositories. Each skill directory has a `FLOW.md` with the decision diagram.

This is not a test runner. The tests under `tests/` and the specs in `spec/` cover the
deterministic parts; a field test covers the part they cannot, which is how a skill behaves against a real repository in a state
nobody thought to write a fixture for. The point of the run is to come out of it with those
fixtures.

## Requirements

| Requirement | Install |
| --- | --- |
| `gh`, logged in | `brew install gh && gh auth login` |
| `jq` | `brew install jq` |
| `python3` | ships with macOS |
| `workstreams` plugin (harden only) | `/plugin install workstreams@bje` |
| `pr-review-toolkit` plugin (harden only) | `/plugin install pr-review-toolkit@claude-plugins-official` |

A `plugin:skill` target has to be installed, since it is resolved through Claude's own plugin
registry rather than from a path. A project or user command or skill is found on disk.

`/field-test:harden` reuses the `workstreams:stream-<effort>` agents for its fix phase and
invokes `/workstreams:review` for its review round rather than growing one of its own, so both
plugins have to be there: `workstreams` for the agents and the skill, `pr-review-toolkit` because
that round runs `review-pr`. `ft-preflight.sh` checks before a round starts rather than halfway
through one.

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
publish. `ft-enterprise.py` asks GitHub once, per run, whether the plugin's owner and the target
repository's owner are organizations in one enterprise. Only a clear yes keeps the names: an
error, a token without the scope, an owner that is a user rather than an organization, and an
empty result all mean redact.

Redaction is literal string replacement, longest value first, over the remote URL, `owner/name`,
owner, name, checkout path, branch names, recent commit subjects, and the `#N` references seen
during the run. It is not regular expressions: a branch name or commit subject can contain
anything, and a pattern built out of one is a way to leak the name it exists to remove. A value
under four characters is replaced only where it stands as a word, because a repository can be
called `cm` and replacing that inside every other word makes the issue unreadable. The
redacted issue carries a line saying the run was outside the enterprise, so the shape reads as
real and the names read as placeholders.

## `/field-test:harden <plugin:skill> --targets <repo-path>...`

The loop that hardened the first pass of `/gh:shepherd` by hand, made repeatable: field-test,
verify, file, fix, review, merge, next. Targets are explicit and worked in the order given; discovering them per
skill is not in this version.

Per target, with every transition written to state before the next action is taken:

1. **Field test.** `/field-test:run` in the target repository. It observes and files; `harden`
   records the issue numbers.
2. **Verify**, always, even when the field test saw nothing. `ft-verify-report.sh` re-reads
   every pull request the target skill's own report named and compares the claim against
   GitHub. A mismatch becomes a finding of its own, which in the by-hand pass was twice the most
   valuable finding of the round.
3. **Fix.** One `workstreams:stream-<effort>` worker, one worktree, one draft PR closing every
   issue of the round. A worker that pauses pauses the loop; one that fails marks the target
   `failed` and leaves its issues open for a person.
4. **Review.** `/workstreams:review`, run in the main session: `/pr-review-toolkit:review-pr` plus
   the PR's own bot and human comments, verified against the code, with a `workstreams:applier`
   subagent applying what holds. One repeat round if the changes were substantial, which that
   skill defines and this one cites. Each round is counted with `ft-harden-state.sh bump`.
5. **Merge.** Ready, auto-merge, then `ft-wait-pr.sh` blocking in the foreground. A mechanical CI
   failure goes back to the fix step once; anything behavioural pauses with the question, and so
   does a green pull request that auto-merge has not landed after three looks.
6. **Summarise** in the same table every round, then the next target.

The wait blocks rather than arming a wake on purpose. A worker that schedules a wake and ends its
turn leaves the loop looking at "waiting" with nothing running, which is one of the two failures
that prompted this skill; the other is a report nobody checked.

### State and resuming

`${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/harden/<plugin>__<skill>.json`, written by
`ft-harden-state.sh`. Target statuses: `pending`, `running`, `paused`, `done`, `failed`. Phases:
`field-test`, `verify`, `fix`, `review`, `merge`, `summary`, `done`. A target is `failed` when its
fix worker failed or returned no report; its issues stay open. `next` prints the first target
that is neither done nor failed, including a paused one, so a question cannot be stepped over.
A target that comes back `running` is resumed at its recorded phase, with its `pr` and
`review_rounds` as they stand, rather than started over. `init` refuses to overwrite a run in
progress without `--force`.

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
| `Stop` | The turn's last message. Fires at every turn boundary, not only the end of the field test, so it never finishes the run; the run skill's own Step 4 does that. No finding reads this field: `ft-collect.py --report` reads the transcript instead, and `ft-issue.py names` scans it, like every event field, for the `#N` references redaction has to catch. A run that never finishes stays live, so resuming that session keeps recording and keeps the deny list armed until `ft-run.py finish` runs; the next `start` in the same session exits 3 |

The cost in a session that is not a field test is one `python3` start: the hook reads the
payload, looks for a run marker, finds none, and returns. Reproduce it with

```bash
FT_STATE_DIR=/tmp/no-runs \
  python3 plugins/field-test/hooks/hook-io.py PostToolUse < tests/field-test/hook-inputs/no-run.json
```

### The deny list

The one place a field test intervenes. It covers force-pushing without a lease, in both the
`--force` and the `+refspec` spelling, deleting a remote branch, a mirror push, `filter-branch`
and `filter-repo`, and a recursive delete of a rooted or upward path. A denied command is
recorded as the highest-severity finding: the target reaching for it is the thing worth writing
down.

Every rule is scoped to the one command it is about, not the whole line: `git push origin main &&
git branch -d feature` is a safe push followed by a local branch delete, and a rule that scanned
past the `&&` would refuse it and file the refusal as the run's headline finding. The recursive
delete rule finds the recursive flag and the force flag separately, so `rm -r -f /` and
`rm --recursive --force /` are refused alongside `rm -rf /`. The git rules step over git's
global options, so `git -C <worktree> push --force` is refused like the bare form; the options
are enumerated rather than matched as any leading flag, or `git --no-pager log --grep
filter-repo` would be refused for naming a command it only reads about.

Every pattern has a denied sample in `tests/field-test/commands/deny.txt`, asserted one
pattern at a time, and `allow.txt` beside it holds the near misses no pattern may match. Both
files are walked by `tests/field-test/test_ft_hooks.py`, so a pattern that stops matching, or
starts matching too much, fails.

## State

`${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/runs/<session-id>/` holds `run.json` and `events.jsonl`,
the whole of the run side's state, beside whatever one run writes there for itself
(`resolved.json`, `names.json`). The harden side keeps state of its own. Nothing is cached: enterprise membership decides what gets
published, and a stale answer would decide it wrongly.

## Scripts

All deterministic. The run side is Python (stdlib only, 3.9), tested under `tests/field-test/`;
the harden side is still bash 3.2, spec'd under `spec/field-test/`, and issue #60 ports it.

| Script | Purpose |
| --- | --- |
| `ft-run.py` | The run marker: `start`, `finish`, `show`, `dir` |
| `ft-resolve.py` | Target to `{kind, plugin, skill, path, version, commit, repo}`; refuses Workflow targets |
| `ft-collect.py` | Recorded events to candidate findings; `--report` prints the target's own final message |
| `ft-enterprise.py` | Whether the plugin and the repository under test share an enterprise |
| `ft-redact.py` | Text in, text out; identity inside the enterprise, placeholders outside |
| `ft-issue.py` | `names`, `search`, `render`, `ensure-label` around filing a finding. Nothing here creates an issue; `ensure-label` creates or updates the `field-test` label, and `bug` is expected to exist already |
| `ft-preflight.sh` | Dependency check for `harden`; JSON `{ok, missing[]}` with install hints |
| `ft-harden-state.sh` | Atomic read/write of one hardening run; validates fields, statuses, and phases. `bump` adds one to a numeric field, so no caller counts a round by hand |
| `ft-verify-report.sh` | A report's claims against `gh pr view`, per pull request |
| `ft-wait-pr.sh` | Blocking, bounded wait on one pull request: `merged`, `passed`, `failed`, `pending` |

## Out of scope for now

Workflow targets. Discovering field-test targets per skill rather than being handed them.
Approving pull requests, bypassing a check or a ruleset, and deciding what counts as a mechanical
fix beyond the definitions `/gh:shepherd` already carries.
