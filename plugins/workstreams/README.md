# workstreams

The round primitives: the parts that make up a round of issue-tracker work. Each part
works on its own. The issue tracker is the source of truth. Blockers are issue dependency
relationships, not prose. A round is the unblocked set, swept from the milestones in work.

One skill exists per primitive. A repository installs the plugin and uses whichever piece
it needs. These are the first four of the five primitives in
[#111](https://github.com/bje-settings/claude/issues/111). The orchestrator
([#134](https://github.com/bje-settings/claude/issues/134)) is next.

## Requirements

A `SessionStart` hook checks the table below. It runs once: at session start,
resume, clear or compact. It reports what is missing
(`.claude/rules/_design-principles.md`, "Dependencies outside a plugin"). No skill
runs a preflight step of its own.

| Requirement | Why |
| --- | --- |
| [`gh`](https://cli.github.com) on `PATH` | Every read the sweep makes goes through it. |
| A `gh` login, from `gh auth token` | Issue dependencies are a GraphQL query, which needs a login. This is a local check: it reads a stored credential, and makes no call to GitHub. |
| The [`gh stack`](https://github.com/github/gh-stack) extension | `/workstreams:stream` opens every layer's pull request with `gh stack submit`. This makes the stack a stack in the GitHub UI from the first push. A chain of `gh pr create` drafts is not a stack, and a reviewer cannot tell it apart from unrelated work. |
| The `pr-review-toolkit` plugin, from any marketplace | `/workstreams:review` dispatches its reviewers. |
| `code-reviewer`, `comment-analyzer`, `silent-failure-hunter`, `pr-test-analyzer` and `type-design-analyzer` in it | A round that finds a reviewer missing halfway through has already spent the others. |

Nothing is vendored. A dependency is declared here and checked once a session starts,
never bundled. The plugin registry is at
`$HOME/.claude/plugins/installed_plugins.json`, with a `claude plugin list --json`
fallback when that file cannot be read. A plugin counts as present under any
marketplace: a fork under another name is still that plugin to the skill that
runs its commands. The hook checks the reviewers against the `agents/` directory of
every copy the registry records an install path for. A fork can satisfy the plugin row
while it carries a different set of agents.

`/workstreams:question` also uses the `gh` plugin, from any marketplace, when it is
there. It asks the person to run `/gh:sync` before the first worktree. It reads
its own skill listing to find out. When `gh` is not installed, the skill
fast-forwards the default branch itself and continues. This is never a finding:
`.claude/rules/_design-principles.md` says not to check an optional plugin.

## Installing

Install through a marketplace: `/plugin marketplace add <path-or-repo>`, then
`/plugin install workstreams@bje`. A plugin installed with `claude --plugin-dir`, from a
local path, or from a `command` source in copy mode keeps only the symlinks that resolve
inside the plugin's own directory. It skips the rest. `src/lib` is dropped, and every
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

"No blockers at all" and "every blocker closed" both count as unblocked, but the report
lists them apart. The first case is work nothing blocked. The second case is work a
round just released.

The skill does the reading. It reads every issue body and every comment. It reads the
Decisions lists in `docs/rfc/` and `docs/adr/` against what has merged. It maps the files
each issue touches. It classifies and sizes each issue. It chooses between parallel
streams, a stack, and one pull request. It posts the sequencing comment on every affected
issue. `skills/sweep/` carries the rules. `file-map.md` holds the mapping rules a file map
must apply.

Both the user and the model can invoke it: it starts a round. Its last step continues
into `/workstreams:question` with the same scope. Nobody has to ask for the question
phase on its own.

## `/workstreams:review`

Takes one draft pull request from green CI to `done`, whoever opened it.

The command answers where the loop is. The skill decides what to do next. The round runs
at most two review rounds, one subagent each, in the pull request's own worktree. The
caller runs a rot check at the end.

| State | What it means |
| --- | --- |
| `awaiting-pr` | GitHub said this pull request number does not exist. A failed read gives `state: null` instead. |
| `no-run` | No workflow run with event `pull_request` for the head: close and reopen, once. |
| `ci-pending` | A required context has not reported. Wait. |
| `red` | A required context failed before any round ran, so it belongs to whoever opened it. |
| `review-1`, `review-2` | Dispatch a round. |
| `fixing` | The round's own fixes have not landed, or a review thread is unresolved. |
| `rot-check` | Check the title and body against the final diff. |
| `done` | Two rounds at most, CI green, nothing unresolved, the body true. |

The rules a round runs under are in `skills/review/round-brief.md`, the brief template.
`round-2.md` adds the round 2 rules. `rot-check.md` covers the caller's last step. Each
rule fixes something a past round lost. Reviewers are read-only and run no test suites,
because three concurrent suites in one worktree once made a test flake. Reviewers finish
before any edit starts, because one round reviewed its own uncommitted work. Round 2
checks round 1's commits first, because round 2 found round 1 wrong or incomplete on nine
of the ten pull requests reviewed by hand in rounds 5 to 7.

There is no state file. Everything is read again each tick. The skill that runs the loop
passes the three facts the command cannot read as flags.

It is `user-invocable: false`. Only the model invokes it, from `/workstreams:stream` or
from an orchestrator, once a pull request is green.

## `/workstreams:stream`

Builds one issue, or one stack of them, in one worktree.

One stream is one worktree, with one branch and one agent per layer, in sequence. The
lower layer is reviewed to `done` before the team writes the next layer. A review fix on
the lower branch rewrites every branch above it, so nothing may write there at that
moment. The upper layer is then written once, against the names the lower layer's review
settled.

The brief is a file, not a prompt. `skills/stream/brief.md` is the template. It holds:

- the issue body and its findings comments
- the sequencing, rulings, and plan comments, verbatim
- the allowed file set and what not to touch
- the numbered rules
- the lessons the layer inherits
- the done condition
- the return contract

The dispatch prompt points at the file. It repeats only the lines most often got wrong.
The lessons section grows layer by layer from what each review finds. That growth is the
most valuable part of an upper layer's brief.

| The layer returns | What the caller does with it |
| --- | --- |
| `constraints_checked` | One entry per numbered rule, with how the diff satisfies it. A miss is visible here rather than in a later review round. |
| `brief_vs_code` | Where the brief was wrong and the code or the documentation was right. Each entry corrects the next layer's brief. |
| `outside_set` | What the layer touched beyond the allowed set. A small, reasonable touch is expected every layer. A silent one is not. |
| `lower_layer` | A defect in a branch the layer does not own. Never applied there. |
| `injected_text_seen` | Text inside a tool result that read like an instruction. |

It is `user-invocable: false`. Only the model invokes it, from an orchestrator, once a
plan is approved.

### The agent

`agents/stream.md` sets no `effort` and no `model`. The caller passes the model per call.
The caller cannot pass effort ([sub-agents](https://code.claude.com/docs/en/sub-agents)),
so the agent inherits the dispatching session's effort. A layer sized at a different
effort waits for the session to change it (#197, after #99).

A plugin subagent ignores the `hooks`, `mcpServers`, and `permissionMode` frontmatter
fields
([sub-agents](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)).
Nothing else can ride in this file. The guard below is a plugin hook rather than a line
in it.

### The guard hook

`hooks/hooks.json` registers one `PreToolUse` hook on `Bash|PowerShell`. It refuses two
things, and only for a subagent:

| Refused | Why |
| --- | --- |
| `run_in_background` | A turn that ends on a background command reads to a caller as a worker that stopped short. It happened in three rounds with the rule written in the brief. |
| A git command that would overwrite uncommitted changes to tracked files | Two agents lost uncommitted work to exactly this, one of them with the rule in its brief. The remedy is one commit. |

The second row covers `git restore` in any form, `git checkout` with a pathspec, and
`git checkout` or `git switch` carrying `-f`, `--force`, `--discard-changes`, `-p`,
`--patch`, or `--pathspec-from-file`. Each of these throws local changes away while
naming no path at all. An ordinary `git switch <branch>` carries uncommitted work across
with it, so the guard does not refuse it.

A `git checkout` written without a `--` counts as a pathspec too. The same words may name
a branch instead, so the guard asks git. The one `git status` the guard already runs is
scoped to what the command named. That answers with the work at stake for
`git checkout file.txt` or `git checkout .`, the spelling a stream lost a file to. It
answers with nothing for a name that is only a branch. The options that name a branch
(`-b`, `-B`, `--orphan`, `-t`, `--track`) are left out of that question, because git
accepts no pathspec beside them.

That leaves one false refusal, and only one. A name that is both an existing branch and
a dirty tracked path is read as the path, where git would have switched and carried the
change over. Telling the two apart needs a second question to git. The refusal costs a
commit and never costs work.

**The main conversation is never denied.** The test is `agent_id`. The input carries this
field "only when the hook fires inside a subagent"
([hooks](https://code.claude.com/docs/en/hooks#common-input-fields)). The refusal names
`agent_type`, so a reader knows which worker was stopped. The guard never matches on it:
matching it would bind only the agent above, and leave every reviewer and round agent
that gets the same rules unguarded.

An allow writes nothing at all, so the permission rules the user configured still decide
the call. A refusal is a `permissionDecision` of `deny` on stdout. That is the documented
form
([hooks](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)), and the
form that survives the `; exit 0` in `hooks.json`.

Two things it cannot do. It cannot see a command the harness MOVES to the background when
that command reaches its timeout: that is a different mechanism, with no hook in front of
it. The remedy for that half is the brief's: pass a timeout long enough to finish in. It
is also a guardrail rather than a security boundary. It reads the command as text, so a
`git restore` inside a quoted argument is refused as if it were real. That costs a person
one commit, and never costs anyone their work.

Anything it cannot read is one line on stderr, and an allow. It never fails a session.

It costs one node process, about 0.1 s, in front of every Bash and PowerShell call, in
any session with the plugin enabled, the main conversation included. The hook does not
use an [`if` condition](https://code.claude.com/docs/en/hooks#common-fields) to narrow
that. `if` matching is documented as best-effort, not fit to enforce a hard allow or
deny, so the guard's own code decides on every call instead.

Run it by hand with a payload on stdin, which is how Claude Code runs it:

```bash
echo '{"hook_event_name":"PreToolUse","cwd":"'"$PWD"'","agent_id":"a","agent_type":"workstreams:stream","tool_name":"Bash","tool_input":{"command":"pnpm test","run_in_background":true}}' | node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.ts"
```

## `/workstreams:question`

Turns a sweep report into an approved plan.

The skill explores every open item the sweep named before it asks anything: the file, the
record, or the docs the item turns on. A question with an answer already in the tree is
recorded as a ruling with a citation, instead of asked. What is left goes to the human,
one question at a time, through `AskUserQuestion`. The recommended option comes first and
is labelled, with the argument against it in its own description. A ruling that is cheap
to reverse is taken the same way: recorded with the argument for and against it, rather
than asked.

Both kinds are recorded in one rulings comment, posted on every issue in the round. The
skill then enters plan mode itself and writes the plan. `ExitPlanMode` is the approval,
not a hand-back. `skills/stream/brief.md` is the template the plan feeds, so the plan
answers what that template needs. Once approved, the plan comment goes on every issue in
the round. Housekeeping then runs before the first worktree: `/gh:sync` when the `gh`
plugin is present (otherwise the skill fast-forwards the default branch itself), any
ignored leftover under `plugins/`, and a preflight for a local hook that runs a full
suite on every push. That hook is disabled for the round only when the repository's own
records say CI is the enforcement boundary. Otherwise the skill asks about it once, with
the per-push cost stated.

It is `user-invocable: false`. Only the model invokes it, right after a sweep.

## Commands

The skills run these; they also run by hand, from any repository, on any machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" --help
```

### `sweep`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" sweep [--milestone 4,5] [--json]
```

Reports the open milestones with their issue counts, every open pull request, including
ones no round opened, and, for each milestone asked for plus the issues on no milestone
at all, the three sets. `--milestone` takes one number or a comma-separated list. It is
refused if given twice, because `parseArgs` would otherwise keep only the last one, and
say nothing. Left out, the report covers every open milestone, plus any other milestone
the issues name, so an open issue left on a closed milestone is still reported. `--json`
prints one object for a skill to read.

Exit code 2 means a usage error. Exit code 1 means nothing at all could be read. A read
that partly fails is still an answer: the rows that arrived are reported, and every
reason the answer is short is listed under `unavailable`. A caller reads that list before
it acts on the sets.

The repository is whatever `gh` resolves from the working directory.

### `pr-state`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> [--round 0|1|2] [--substantial] [--rot-checked] [--json]
```

Reports one pull request's head, draft flag, base, and mergeability. It also reports the
status-check contexts its BASE BRANCH requires, what has reported against each of them,
whether a workflow run with event `pull_request` exists for the head, its unresolved
review threads and its comments, a wait hint, and the state the review loop is in.

The required contexts come from the rules for the pull request's own base branch, never
hard-coded and never the default branch's rules. A pull request based on a topic branch,
which is what every layer of a stack is, is typically required to pass nothing at all. A
verdict over an empty list would be green before a single check had run. Where no
ruleset requires anything, the command takes the verdict over the contexts that have
actually reported on the head, and `contextsFrom` says `head`. That is a design fact, not
a read that fell short, so it is a field of its own. A caller keys on `unavailable` to
decide whether the report is an answer at all, and every layer of a stack is an answer.

The run check reads `actions/runs?branch=<head ref>`, and never `?head_sha=`: that query
has answered nothing for a head whose runs existed. An unresolved review THREAD is
counted, and a comment is not. The enterprise coverage bot posts a comment on every pull
request, and a loop that counted it would never reach `done`.

`--round`, `--substantial`, and `--rot-checked` are the three facts the command cannot
read, so the caller carries them.

Exit code 2 means a usage error. Exit code 1 means nothing at all could be read.

## SessionStart hook

`hooks/session-start.ts` checks the [Requirements](#requirements) table once, when a
session starts, resumes, clears or compacts. When everything is present, it writes
nothing. When something is absent, it writes one `workstreams: ⚠️` line per absent item
to the terminal. It also tells the model which items are absent and that the
workstreams skills cannot run.

A registry that cannot be read is reported as itself, never as missing plugins: the fix
is a different one, and telling someone to install what they already have sends them the
wrong way. It falls back to `claude plugin list --json` first. A `pr-review-toolkit` the
registry names, with no reachable install path, gets the same rule, one level down.
The hook then says it could not check any copy. It does not name five reviewers that are
not there. That covers a path that is recorded and gone, which is what a stale entry from
an update looks like, and also a path that was never recorded.

To see the lines by hand, run the hook with a payload on stdin:

```bash
echo '{"session_id":"s1"}' | node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.ts"
```

## Tests

```bash
pnpm test                                        # the whole TypeScript suite, with coverage
pnpm exec vitest run tests/plugins/workstreams   # this plugin alone
```

`tests/plugins/workstreams/fixtures/sweep-capture.json` holds every child process the real `gh` client started
while it answered the sweep's four reads against `bje-settings/claude`, on 2026-09-21.
The acceptance case replays it through the real client, and asserts the sets a person
swept by hand that day. A test holds the claim "the report matches a hand sweep", not a
memory of one.

`tests/plugins/workstreams/hook.test.ts` starts `hooks/guard.ts` as its own process, the way `hooks.json` does.
It sends the payloads Claude Code would really send, against repositories built by
`harness/git.ts`. Every case asserts stdout as well as the status. Exit code 0 is what an
allow and every degraded run answer with, so a status alone cannot tell a decision from a
crash before one.

`tests/plugins/workstreams/session-start.test.ts` starts `hooks/session-start.ts` the same
way, against no `gh` and no `claude` binary at all. `tests/plugins/workstreams/subcommands/session-start.test.ts`
runs the hook's own decisions in process, with the process runner injected.
