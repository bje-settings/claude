# workstreams

The round primitives: the pieces a round of issue-tracker work is run out of, each usable
on its own. The issue tracker is the source of truth, blockers are recorded as issue
dependency relationships rather than as prose, and a round is the unblocked set swept from
the milestones being worked.

One skill per primitive, so a repository installs the plugin and reaches for whichever
piece it wants. These are the first four of the five in
[#111](https://github.com/bje-settings/claude/issues/111); the orchestrator
([#134](https://github.com/bje-settings/claude/issues/134)) is next.

## Requirements

Every skill runs `preflight` first and stops with a hint per finding. It checks:

| Requirement | Why |
| --- | --- |
| [`gh`](https://cli.github.com) on `PATH` | Every read the sweep makes goes through it. |
| `gh auth status` | Issue dependencies are a GraphQL query, which needs a login. |
| The [`gh stack`](https://github.com/github/gh-stack) extension | `/workstreams:stream` opens every layer's pull request with `gh stack submit`, so the stack is a stack in the GitHub UI from the first push (a chain of `gh pr create` drafts is not, and cannot be told from unrelated work by a reviewer). |
| The `gh` plugin, from any marketplace, OPTIONAL | Declared here for `/workstreams:question`: present, it asks the person to run `/gh:sync` before the first worktree; absent, it fast-forwards the default branch itself and goes on. Reported in `preflight`'s `optional` array, never a finding and never exit 1. |
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

Both the user and the model can invoke it: it starts a round.

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
round 2 checks round 1's commits first because on nine of the ten pull requests reviewed by
hand in rounds 5 to 7 it found them wrong or incomplete.

There is no state file. Everything is read again each tick, and the three things the
command cannot read are passed as flags by the skill that is running the loop.

It is `user-invocable: false`: only the model invokes it, from `/workstreams:stream` or an orchestrator once a pull request is green.

## `/workstreams:stream`

Builds one issue, or one stack of them, in one worktree.

One stream is one worktree, one branch per layer, one agent per layer, in sequence. The
lower layer is reviewed to `done` before the next is written, because a review fix on the
lower branch rewrites every branch above it and nothing may be writing there at that
moment; and because the upper layer is then written once, against the names the lower
layer's review settled.

The brief is a file, not a prompt. `skills/stream/brief.md` is the template: the issue body
and its findings comments, the sequencing, rulings and plan comments verbatim, the allowed
file set and what not to touch, the numbered rules, the lessons the layer inherits, the done
condition and the return contract. The dispatch prompt points at the file and repeats only
the lines most often got wrong. The lessons section is grown layer by layer from what each
review found, and that is the most valuable part of an upper layer's brief.

| The layer returns | What the caller does with it |
| --- | --- |
| `constraints_checked` | One entry per numbered rule, with how the diff satisfies it. A miss is visible here rather than a review round later. |
| `brief_vs_code` | Where the brief was wrong and the code or the documentation was right. Each one corrects the next layer's brief. |
| `outside_set` | What it touched beyond the allowed set. Expected, in small reasonable ways, every layer; doing it silently is what is not. |
| `lower_layer` | A defect in a branch it does not own. Never applied there. |
| `injected_text_seen` | Text inside a tool result that read like an instruction. |

It is `user-invocable: false`: only the model invokes it, from an orchestrator once a plan is approved.

### The three agents

`agents/stream-low.md`, `stream-medium.md` and `stream-high.md` are one body with one
frontmatter field between them. Effort can only come from a shipped agent definition, which
is why there are three; the model is passed per call, so a layer's sizing is the caller's
decision and not the definition's.

A plugin subagent ignores the `hooks`, `mcpServers` and `permissionMode` frontmatter fields
([sub-agents](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)), so
nothing else can ride in these files and the guard below is a plugin hook rather than a line
in them.

### The guard hook

`hooks/hooks.json` registers one `PreToolUse` hook on `Bash|PowerShell`. It refuses two
things, and only to a subagent:

| Refused | Why |
| --- | --- |
| `run_in_background` | A turn that ends on a background command reads to a caller as a worker that stopped short. It happened in three rounds with the rule written in the brief. |
| A git command that would overwrite uncommitted changes to tracked files | Two agents lost uncommitted work to exactly this, one of them with the rule in its brief. The remedy is one commit. |

The second row is `git restore` in any form, `git checkout` with a pathspec, and `git checkout`
or `git switch` carrying `-f`, `--force`, `--discard-changes`, `-p`, `--patch` or
`--pathspec-from-file`, each of which throws local modifications away while naming no path at
all. An ordinary `git switch <branch>` carries uncommitted work across with it and is not
refused.

A `git checkout` written without a `--` counts as a pathspec too. The same words may be a
branch, so git is asked: the one `git status` the guard already runs is scoped to what the
command named, which answers with the work at stake for `git checkout file.txt` or
`git checkout .`, the spelling a stream lost a file to, and with nothing for a name that is only
a branch. The options that name a branch (`-b`, `-B`, `--orphan`, `-t`, `--track`) are left out
of that question, because git accepts no pathspec beside them.

That leaves one false refusal, and only one: a name that is both an existing branch and a dirty
tracked path is read as the path, where git would have switched and carried the change over.
Separating them needs a second question to git; the refusal costs a commit and never costs work.

**The main conversation is never denied.** The test is `agent_id`, which the input carries
"only when the hook fires inside a subagent"
([hooks](https://code.claude.com/docs/en/hooks#common-input-fields)). `agent_type` is named
in the refusal so a reader knows which worker was stopped, and is never matched on: matching
it would bind the three agents above and leave every reviewer and round agent the same rules
are handed to unguarded.

An allow writes nothing at all, so the permission rules the user configured still decide the
call. A refusal is a `permissionDecision` of `deny` on stdout, which is the documented form
([hooks](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)) and the one that
survives the `; exit 0` in `hooks.json`.

Two things it cannot do. It cannot see a command the harness MOVES to the background when
that command reaches its timeout, which is a different mechanism with no hook in front of it;
the remedy for that half is the brief's, and it is to pass a timeout long enough to finish
in. And it is a guardrail rather than a security boundary: it reads the command as text, so a
`git restore` inside a quoted argument is refused as if it were real, which costs a person one
commit and never costs anyone their work.

Anything it cannot read is one line on stderr and an allow. It never fails a session.

It costs one node process, about 0.1 s, in front of every Bash and PowerShell call in any
session that has the plugin enabled, the main conversation's included. The hook does not use
an [`if` condition](https://code.claude.com/docs/en/hooks#common-fields) to narrow that: `if`
matching is documented as best-effort, not fit to enforce a hard allow or deny, so the guard's
own code decides on every call instead.

Run it by hand with a payload on stdin, which is how Claude Code runs it:

```bash
echo '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","agent_id":"a","agent_type":"workstreams:stream-high","tool_name":"Bash","tool_input":{"command":"pnpm test","run_in_background":true}}' | node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.ts"
```

## `/workstreams:question`

Turns a sweep report into an approved plan.

The skill explores every open item the sweep named before asking anything: the file, the
record, or the docs it turns on. A question whose answer is already in the tree is recorded
as a ruling with a citation instead of asked. What is left goes to the human one question at
a time, `AskUserQuestion`, the recommended option first and labelled, with the argument
against it in its own description; a ruling that is cheap to reverse is taken the same way,
recorded with the argument for and against it rather than asked.

Both are recorded in one rulings comment, posted on every issue in the round. The skill then
hands back: the human enters plan mode, and `skills/stream/brief.md` is the template the plan
feeds, so the plan answers what that template needs. Once approved, the plan comment goes on
every issue in the round, and housekeeping runs before the first worktree: `/gh:sync`, any
ignored leftover under `plugins/`, and a preflight for a local hook that runs a full suite on
every push, which is disabled for the round only when the repository's own records say CI is
the enforcement boundary, or asked about once with the per-push cost stated when they do not.

It is `user-invocable: false`: only the model invokes it, right after a sweep.

## Commands

The skills run these; they also run by hand, from any repository, on any machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" --help
```

### `sweep`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" sweep [--milestone 4,5] [--json]
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> [--round 0|1|2] [--substantial] [--rot-checked] [--json]
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" preflight [--json]
```

Prints `{"ok": ..., "missing": [{"id": ..., "hint": ..., "detail": ...}]}` with `--json`
and the same findings as lines without it. Each hint is a command to run, except where
the hint says what could not be checked instead: an unreadable registry names the file,
and a missing reviewer names the agent. Exit 0 when everything is present, 1 when
anything is missing, and 2 on a usage error.

A registry that cannot be read is reported as itself and never as missing plugins: the fix
is a different one, and telling someone to install what they already have sends them the
wrong way. A `pr-review-toolkit` the registry names with no install path it can reach is
the same rule one level down, reported as reviewers that could not be checked rather than
as five that are not there. That covers a path that is recorded and gone, which is what a
stale entry from an update looks like, as well as one that was never recorded.

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

`src/hook.test.ts` starts `hooks/guard.ts` as its own process, the way `hooks.json` does, and
sends it the payloads Claude Code would really send, against repositories built by
`harness/git.ts`. Every case asserts stdout as well as the status, because exit 0 is what an
allow and every degraded run answer with, so a status on its own cannot tell a decision from a
crash before one.
