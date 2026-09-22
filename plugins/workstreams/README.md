# workstreams

The round primitives: the pieces a round of issue-tracker work is run out of, each usable
on its own. The issue tracker is the source of truth, blockers are recorded as issue
dependency relationships rather than as prose, and a round is the unblocked set swept from
the milestones being worked.

One skill per primitive, so a repository installs the plugin and reaches for whichever
piece it wants. These are the first two of the five in
[#111](https://github.com/bje-settings/claude/issues/111); the stream
([#132](https://github.com/bje-settings/claude/issues/132)), the question phase
([#131](https://github.com/bje-settings/claude/issues/131)) and the orchestrator
([#134](https://github.com/bje-settings/claude/issues/134)) land after them.

## Requirements

Every skill runs `preflight` first and stops with a hint per finding. It checks:

| Requirement | Why |
| --- | --- |
| [`gh`](https://cli.github.com) on `PATH` | Every read the sweep makes goes through it. |
| `gh auth status` | Issue dependencies are a GraphQL query, which needs a login. |
| The [`gh stack`](https://github.com/github/gh-stack) extension | Declared here for the stream ([#132](https://github.com/bje-settings/claude/issues/132)), which opens a stack of pull requests; the sweep itself does not call it. |
| The `gh` plugin, from any marketplace | Declared here for the orchestrator ([#134](https://github.com/bje-settings/claude/issues/134)), which runs `/gh:sync` between rounds; the sweep itself does not call it. |
| The `pr-review-toolkit` plugin, from any marketplace | `/workstreams:review` dispatches its reviewers. |
| `code-reviewer`, `comment-analyzer`, `silent-failure-hunter`, `pr-test-analyzer` and `type-design-analyzer` in it | A round that found a reviewer missing halfway through has already spent the others. |

Nothing is vendored: a dependency is declared here and checked before a round starts,
never bundled. The plugin registry is read at
`$HOME/.claude/plugins/installed_plugins.json`, and a plugin counts as present under any
marketplace, because a fork under another name is still that plugin to the skill that
runs its commands. The reviewers are checked against the `agents/` directory of every
copy the registry records an install path for, precisely because a fork satisfies the
plugin row while carrying a different set of agents.

## Installing

Install through a marketplace: `/plugin marketplace add <path-or-repo>`, then
`/plugin install workstreams@bje`. A plugin installed with `claude --plugin-dir`, from a
local path, or from a `command` source in copy mode keeps only the symlinks that resolve
inside the plugin's own directory and skips the rest, so `src/lib` is dropped and every
command fails at import.

## `/workstreams:sweep`

Finds what a round could start on, and says how it should be sequenced.

The command answers the deterministic half and the skill does the reading. What the
command answers:

| Set | Rule |
| --- | --- |
| unblocked | Every `blockedBy` entry is closed or merged, or there are none at all. |
| next tier | Exactly one open blocker, and that blocker is itself unblocked. |
| blocked | Everything else, with its open blockers named. |

"No blockers at all" and "every blocker closed" are both unblocked and are reported
separately: the first is work nothing was waiting for, the second is work a round just
released.

What the skill does with that: reads every body and every comment, reads the Decisions
lists in `docs/rfc/` and `docs/adr/` against what has merged, maps the files each issue
touches, classifies and sizes each one, chooses between parallel streams, a stack and one
pull request, and posts the sequencing comment on every affected issue. `skills/sweep/`
carries the rules, with `file-map.md` holding the mapping rules a file map has to apply.

It is a read of the tracker until the last step, which posts comments, so it is not
model-invocable: a person runs it.

## `/workstreams:review`

Takes one draft pull request from green CI to `done`, whoever opened it.

The command answers where the loop is and the skill decides what to do about it. Up to
two review rounds, one subagent each in the pull request's own worktree, and a rot check
by the caller at the end.

| State | What it means |
| --- | --- |
| `awaiting-pr` | Nothing answered for that number. |
| `no-run` | No workflow run with event `pull_request` for the head: close and reopen, once. |
| `ci-pending` | A required context has not reported. Wait. |
| `red` | A required context failed before any round ran, so it belongs to whoever opened it. |
| `review-1`, `review-2` | Dispatch a round. |
| `fixing` | The round's own fixes have not landed, or a review thread is unresolved. |
| `rot-check` | Check the title and body against the final diff. |
| `done` | Two rounds at most, CI green, nothing unresolved, the body true. |

The rules a round runs under are in `skills/review/round-brief.md`, which is the brief
template, with `round-2.md` for what round 2 adds and `rot-check.md` for the caller's
last step. Each rule in them is a round that lost something: reviewers are read-only and
run no suites because three concurrent suites in one worktree made a test flake, they
all finish before any edit because one reviewed a round's own uncommitted work, and
round 2 checks round 1's commits first because in eight of the last nine rounds it found
them wrong or incomplete.

There is no state file. Everything is read again each tick, and the three things the
command cannot read are passed as flags by the skill that is running the loop.

It commits and pushes, so it is not model-invocable: a person runs it.

## Commands

The skills run these; they also run by hand, from any repository, on any machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" --help
```

### `sweep`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" sweep [--milestone 4,5] [--json]
```

Reports the open milestones with their issue counts, every open pull request including
ones no round opened, and the three sets for each milestone asked for plus the issues on
no milestone at all. `--milestone` takes one number or a comma-separated list and is
refused if given twice, because `parseArgs` would otherwise keep only the last one
silently. Left out, the report covers every open milestone and any other milestone the
issues name, so an open issue left on a closed milestone is still reported. `--json`
prints one object for a skill to read.

Exit 2 on a usage error, 1 only when nothing at all could be read. A read that partly
failed is still an answer: the rows that arrived are reported and every reason the answer
is short is listed under `unavailable`, which a caller reads before acting on the sets.

The repository is whatever `gh` resolves from the working directory.

### `pr-state`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" pr-state <number> [--round 0|1|2] [--substantial] [--rot-checked] [--json]
```

Reports one pull request's head, draft flag, base and mergeability, the status-check
contexts its BASE BRANCH requires, what has reported against each of them, whether a
workflow run with event `pull_request` exists for the head, its unresolved review
threads and its comments, a wait hint, and the state the review loop is in.

The required contexts are read from the rules that apply to the pull request's own base
branch, never hard-coded and never the default branch's: a pull request based on a topic
branch, which is what every layer of a stack is, is typically required to pass nothing at
all, and a verdict over an empty list would be green before a single check had run. Where
no ruleset requires anything, the verdict is taken over the contexts that have actually
reported on the head and `contextsFrom` says `head`. That is a design fact and not a read
that fell short, so it is a field of its own: a caller keys on `unavailable` to decide
whether the report is an answer at all, and every layer of a stack is an answer.

The run assertion reads `actions/runs?branch=<head ref>` and never `?head_sha=`, which
has answered nothing for a head whose runs existed. An unresolved review THREAD is
counted and a comment is not: the enterprise coverage bot posts a comment on every pull
request, and a loop that counted it would never reach `done`.

`--round`, `--substantial` and `--rot-checked` are the three facts the command cannot
read, so the caller carries them.

Exit 2 on a usage error, and 1 only when nothing at all could be read.

### `preflight`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/workstreams.ts" preflight [--json]
```

Prints `{"ok": ..., "missing": [{"id": ..., "hint": ..., "detail": ...}]}` with `--json`
and the same findings as lines without it. Each hint is a command to run, except where
the hint says what could not be checked instead: an unreadable registry names the file,
and a missing reviewer names the agent. Exit 0 when everything is present, 1 when
anything is missing, and 2 on a usage error.

A registry that cannot be read is reported as itself and never as missing plugins: the fix
is a different one, and telling someone to install what they already have sends them the
wrong way. A `pr-review-toolkit` the registry names with no install path is the same rule
one level down, reported as reviewers that could not be checked rather than as five that
are not there.

## Tests

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run plugins/workstreams         # this plugin alone
```

`src/fixtures/sweep-capture.json` is every child process the real `gh` client started
while answering the sweep's four reads against `bje-settings/claude` on 2026-09-21. The
acceptance case replays it through the real client and asserts the sets a person swept by
hand that day, so "the report matches a hand sweep" is held by a test rather than by a
memory of one.
