# workstreams

The round primitives: the parts that make up a round of issue-tracker work. Each part
works on its own. The issue tracker is the source of truth. Blockers are issue dependency
relationships, not prose. A round is the unblocked set, swept from the milestones in work.

One skill exists for each of the five primitives in
[#111](https://github.com/bje-settings/claude/issues/111). `/workstreams:start`, the
orchestrator, is the one entry. It holds the order of the steps. The other four are
`user-invocable: false`: only the model invokes them, from `/workstreams:start`.

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

## `/workstreams:start`

Runs a round, or continues one, to reviewed draft pull requests. Nothing merges.

| Call | What it does |
| --- | --- |
| `/workstreams:start 4` (an example milestone) | The sweep and the question phase, if the round has no plan yet. Then a layer at a time, each reviewed to `done`, then the round end. |
| `/workstreams:start` | The same, over every milestone with open issues. |
| `/workstreams:start #260` (an example number) | The review loop on that one pull request, to `done`. No sweep and no plan. |

Each call derives where the round stands from the tracker, and writes no file. The plan
is the comment whose first line reads `<round> plan, approved <date>.`. The pull requests
are the ones that close the round's issues, in the order `gh stack view` gives. Each pull
request has three review facts. They are the rounds done, whether round 1 was substantial,
and whether the rot check is done. `/workstreams:review` posts a marker comment on the pull
request for each one, and `start` reads the markers back. So a new conversation needs no
question.

It runs in the main conversation. The two human gates need it there: the plan approval in
plan mode, and one `AskUserQuestion` when two streams collide. A subagent has neither.

On each wake it runs a tick, in `skills/start/tick.md`. The tick reads each pull
request's state and runs one `intersect`. It checks each new head, and looks for a
collision. Then it takes the next action for each state. `review` and `stream` each take
one step for each call and never wait. Only `start` waits.

At the round end, in `skills/start/round-end.md`, it posts the merge sequence and the
cost on each issue of the round. The cost comes from each agent's completion
notification and from `gh pr view --json additions,deletions`. Idle time is in no
notification, so the report gives agent minutes instead.

### The monitor

`monitors/monitors.json` declares one monitor. It runs `watch` in the session's working
directory, from the first time `/workstreams:start` runs in a session
(`"when": "on-skill-invoke:start"`). Each line it writes wakes the session. The other
wake is an agent's completion notification. Nothing polls an agent, and nothing sleeps in
the foreground.

Plugin monitors are experimental. They run only in interactive sessions, and not on
Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry
([plugins reference](https://code.claude.com/docs/en/plugins/manifest-reference#monitors)).

The watch writes an `open` line for each open pull request. If a pull request is open and
no such line came, the monitor does not run. The skill then starts `watch` with the
Monitor tool itself.

That watch expires after 30 minutes at most. The skill starts it again with `--since-head` and
`--concluded`, so the new watch stays silent about what it already said. Where neither can
run, agent returns are the only wake. With no agent at work, the skill reports and stops.

`claude plugin validate --strict` does not read the entries of `monitors.json`, at
2.1.263 or at 2.1.283. A key it does not know passes both. Claude Code refuses it at load
time only, so a real session is the check.

## `/workstreams:sweep`

Finds what a round could start on, and says how it should be sequenced.

The command answers the deterministic half and the skill does the reading. What the
command answers:

| Set | Rule |
| --- | --- |
| unblocked | Every `blockedBy` entry is closed or merged, or there are none at all. Carries `unlocks`: the open issues it is the only open blocker of. |
| blocked | At least one open `blockedBy` entry. Reported as a count, number and title only. |

"No blockers at all" and "every blocker closed" both count as unblocked, but the report
lists them apart. The first case is work nothing blocked. The second case is work a
round just released. A blocked issue carries no reason, and no blocker list. The round
does not read, map, size, or comment on it.

The skill does the reading. It reads every issue body and every comment, for the
unblocked set alone. It reads the Decisions lists in `docs/rfc/` and `docs/adr/` against
what has merged. It maps the files each issue touches. It classifies and sizes each
issue. It chooses between parallel streams, a stack, and one pull request. It posts the
sequencing comment on every issue in the round. `skills/sweep/` carries the rules.
`file-map.md` holds the mapping rules a file map must apply.

It is `user-invocable: false`. `/workstreams:start` invokes it when a round has no plan
yet. It ends at its report.

## `/workstreams:review`

Takes one draft pull request from green CI to `done`, whoever opened it.

The command answers where the loop is. The skill takes the one step that the state calls
for, and returns. It dispatches a round, reopens for an absent run, does the rot check, or
reports. It never waits. The loop runs at most two review rounds, one subagent
each, in the pull request's own worktree.

| State | What it means |
| --- | --- |
| `awaiting-pr` | GitHub said this pull request number does not exist. A failed read gives `state: null` instead. |
| `no-run` | No workflow run with event `pull_request` for the head: close and reopen, once. |
| `ci-pending` | A required context has not reported. The caller waits. |
| `red` | A required context failed before any round ran, so it belongs to whoever opened it. |
| `review-1`, `review-2` | Dispatch a round. |
| `fixing` | The round's own fixes have not landed, or a review thread from a person is unresolved. A bot's own thread, review bots such as Copilot included, is named apart and does not hold this state (#219). |
| `rot-check` | Check the title and body against the final diff. |
| `done` | Two rounds at most, CI green, no unresolved thread from a person, the body true. A bot's own thread can still be open. |

The rules a round runs under are in `skills/review/round-brief.md`, the brief template.
`round-2.md` adds the round 2 rules. `rot-check.md` covers the caller's last step. Each
rule fixes something a past round lost. Reviewers are read-only and run no test suites,
because three concurrent suites in one worktree once made a test flake. Reviewers finish
before any edit starts, because one round reviewed its own uncommitted work. Round 2
checks round 1's commits first, because round 2 found round 1 wrong or incomplete on nine
of the ten pull requests reviewed by hand in rounds 5 to 7.

There is no state file. Everything is read again each tick. After each round and after the
rot check, the skill posts a marker comment, such as `Review round 1 done: substantial.`
The caller reads the markers back, and passes the three facts the command cannot read as
flags.

It is `user-invocable: false`. `/workstreams:start` invokes it, one step for each call.

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

Each call takes one step, and returns. It writes the next layer's brief and dispatches its
agent, or it reads a layer's return. It never waits.

It is `user-invocable: false`. `/workstreams:start` invokes it once a plan is approved.

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

It is `user-invocable: false`. `/workstreams:start` invokes it after a sweep.

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
at all, the two sets. `--milestone` takes one number or a comma-separated list. It is
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
has answered nothing for a head whose runs existed. Only an unresolved thread from a
PERSON holds the loop. A bot's own thread, review bots included, is counted apart under
`botThreads` and does not hold it (#219). A plain comment is never counted at all: the
enterprise coverage bot posts a comment on every pull request, and a loop that counted it
would never reach `done`.

`--round`, `--substantial`, and `--rot-checked` are the three facts the command cannot
read. `/workstreams:start` reads them from the marker comments that `/workstreams:review`
posts.

Exit code 2 means a usage error. Exit code 1 means nothing at all could be read.

### `intersect`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" intersect [--json]
```

Reads the head of every open pull request with local git. That includes each pull request
that no round opened. The orchestrator runs it on each tick. It finds a real collision between two streams, and the
facts of the check on each head.

Each head is fetched as `git fetch --no-write-fetch-head origin <sha>`. That fetch writes no
ref, and the flag stops the `FETCH_HEAD` write. So the command leaves no named ref behind. The
default branch is fetched first, by name. That fetch moves `origin/<default>`, the ref that a
clone already keeps. For each head, the command reports these facts:

| Fact | Where it comes from |
| --- | --- |
| merge base, and the commits the default branch has gained since | `git merge-base` and `git rev-list --count`: the rebase debt of a branch |
| changed files | `git diff --no-renames --name-only` against the merge base |
| stack layer, and own files | the open pull request whose head is the base, never a fork's, and `git diff --no-renames --name-only <lower head>...<head>`, as `gh pr diff` shows it |
| against the default branch | `git merge-tree --write-tree`: clean, or the paths that conflict |
| `pull_request` run | `actions/runs?branch=<head ref>` for the exact head sha, never `?head_sha=` |
| worktree | the local worktree on the head branch, never for a fork's head, and whether `git status` is empty |

`--no-renames` keeps the old path of a renamed file in the list, next to the new path.

Each pair of heads that change a common file gets its own `git merge-tree --write-tree`.
A pair compares the own files of each head. Against the default branch, a stack layer
changes every file of the layers below it. So two layers of one stack would always share
files, and that is no collision. A pull request on the default branch is never a stack
layer.
The command also reports whether the root checkout is clean.

A fact that could not be read is null, or `unread`. A merge-tree that failed is never
`clean`. git exits 1 for a conflict, and also for a commit it cannot read. So the command
trusts a conflict only when git printed the tree it wrote. Each reason is listed under
`unavailable`. Exit code 2 means a usage error. Exit code 1 means the command runs
outside a git checkout, or read no pull request at all.

### `watch`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" watch [--interval 60] [--ticks 0] [--since-head <n>=<sha>,...] [--concluded <n>=<sha>,...]
```

A long poll of every open pull request. It writes one line to stdout for each event
below, so that a Monitor wakes on each line:

- a new pull request
- a new head, compared by the full sha
- each required context as it reports
- one `CONCLUDED` line for each head
- a pull request that merged or closed
- a heartbeat, after ten minutes with no other line

The watch keeps what it has seen in memory, and writes no file.

A head this watch has already seen is not a new head, even after a later one. For a
short time after a push, the API can answer the old head and the new head in turn. The
watch keeps every head it has seen for each pull request, not the current one alone
(#264). One known limit: a force push back to an earlier head silences that pull
request. No later line, not even `CONCLUDED`, is written again for it, until the watch
restarts. `--since-head` and `--concluded` seed this memory with their own head.

A head is `CONCLUDED` only when every required context has reported. The list comes
from the rules of the base branch. When no ruleset covers the base, the list comes from
the default branch (ruling P9). Each stack layer above the first is such a case. In round
5, a watch concluded on the checks that had reported on the head. Those were seven
CodeQL checks, and none of the required ones.

`pr-state` and `watch` share one derivation of the list, `src/required-contexts.ts`.

Each base reads its required contexts on its own. A base whose read fails leaves unread
only the pull requests that need its list, not the whole poll (#265). A failed default
branch leaves unread every pull request that falls back to it. Each failure writes one
line for each new reason, and a line when that base reads again.

A poll that read no pull request writes a `poll failed` line and changes nothing. The
line comes once for each new reason, and not on each poll. The first poll that reads
again writes `poll read again`. While polls fail, the heartbeat names the failure. While
a base stays unread, it names that instead. Neither says "no change". A list that fell
short still gives the rows that arrived, and the watch keeps them. It writes one `poll
incomplete` line for each new reason. One reason is a pull request with more checks
than one page holds. A pull request that is absent from a short list is not reported as
closed: only its own state names that. The watch then polls again at the next interval.
Each event is one line, also when gh gives its reason on more than one line.

`--since-head` and `--concluded` tell a new watch what the caller already knows. The
watch then stays silent about it. Each takes a comma-separated list of a number and a
full head sha. A short sha is refused.

Outside a git checkout, or with no `gh` to run, the watch writes one line and exits 0.
A SIGTERM, or a reader that closed the pipe, ends it with exit 0. `--ticks` stops it
after that many polls. Give it a bound when you run it by hand.

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
