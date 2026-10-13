# workstreams

The round primitives: the parts that make up a round of issue-tracker work. Each part
works on its own. The issue tracker is the source of truth. Blockers are issue dependency
relationships, not prose. A round is an issue set: the unblocked issues of one milestone or
of every milestone, or the issues the caller names.

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
| `pgrep` on `PATH` | The guard lists the `vitest` processes that run with it. |
| `lsof` on `PATH`, only when the machine has no `/proc` | The guard reads each process cwd from `/proc`. Without `/proc` (macOS), it asks `lsof`. |
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
`/plugin install workstreams@bje`. For local work, `claude --plugin-dir` also works. The plugin
holds no symlink, so each install method gets the same files.

## `/workstreams:start`

Runs a round, or continues one, to reviewed draft pull requests. Nothing merges.

| Call | What it does |
| --- | --- |
| `/workstreams:start milestone 4` (an example milestone; a bare `4` works too) | The sweep and the question phase, if the round has no plan yet. Then a layer at a time, each reviewed to `done`, then the round end. |
| `/workstreams:start issues 12 13` (example issues) | The same, for those issues alone. |
| `/workstreams:start any LSP related issue` (an example focus) | `start` resolves the words to an issue list with `gh issue list`. It filters with key words, `--label` or `--type`, and shows the set. Then it runs the `issues` scope on that set. An empty set is a stop. |
| `/workstreams:start` | The same, over every milestone with open issues. With a round in flight, it asks first: continue that round, or start a new one. |
| `/workstreams:start pr 260` (an example number) | The review loop on that one pull request, to `done`. No sweep and no plan. |

Each call derives where the round stands from the tracker, and writes no file. The plan
is the comment whose first line reads `<round> plan, approved <time>.`, with the approval
time to the minute in UTC. The pull requests
are the ones that close the round's issues, in the order `gh stack view` gives. Each pull
request has three review facts. They are the rounds done, whether round 1 was substantial,
and whether the rot check is done. `/workstreams:review` records each one as a
`workstreams/<name>` commit status with `mark`, and `pr-state` reads the statuses back. So a
new conversation needs no question. A merged pull request is final for its layer, with no
statuses.

The `argument-hint` of `start` invites an optional focus in free words, as `/compact` does.
Other words, and a bare number that names no milestone, are judged. `start` checks each
number against the issues, the pull requests and the milestones. It asks when two readings
stay possible.

A round is its issue set. Each issue is in the round of its newest plan comment, and in
no other. `start` runs `rounds` with its scope to find the round in flight. A round is in
flight while one of its issues is open, until a `<round> end,` record follows its plan.
The older `## Round end: <round>` heading ends a round too (#405).
A scope that is part in a round and part in none is a stop. `question` checks the issues
once more before it posts a plan. So two rounds in one repository, on two issue sets,
never act or comment on each other's issues and pull requests. Each round's watch takes
`--heads` with its own branches. A collision with another round's pull request is named
in the ruling, with no comment on the other round's issues (#376).

GitHub is the state of review. `start` writes the next layer only when `pr-state` gives
`done` or `merged` for the layer below. A person's message in chat never marks a layer
done. The person can explicitly ask to skip the review of a layer in `review-1`. Then
`start` posts a ruling comment that quotes the request. It also records the round 1 and rot
check statuses with `mark`, each with a link to that comment as the description.

A layer that closed with no merge is a question, asked once: drop it and the layers above
it, reopen it, or replan. `start` records the answer on the layer's issues. A dropped layer
lets the round end, and the round end lists it as an open item.

It runs in the main conversation. The human gates need it there. They are the plan
approval in plan mode, one `AskUserQuestion` for a hard decision, such as a collision, and
the question at the round end. A subagent has neither tool.

A mid-round decision with a recommended option that is cheap to reverse can be a ruling
instead. The rubric is in `skills/start/tick.md`. `start` applies a ruling, records it on
each issue it touches, names it in its next report, and goes on.

On each wake it runs a tick, in `skills/start/tick.md`. The tick reads each pull
request's state and runs one `intersect`. It checks each new head, and looks for a
collision. Then it takes the next action for each state. `review` and `stream` each take
one step for each call and never wait. Only `start` waits.

The round end starts when every layer is `done`, merged or dropped, and no layer is left.
It is in `skills/start/round-end.md`. The report comes before any question. It has six
parts, from the state and the merge sequence to the cost. Each item in parts 2 to 5 has
one recommended action and its owner. A plan issue still open after its pull request
merged is an open item.

After the report, `start` asks one question, with one option for each part that has
items. It does the accepted actions that Claude owns. Then it posts the same parts,
and what it did, on each issue of the round. The first line is `<round> end, <date>.`

The cost comes from each agent's completion notification and from `gh pr view --json
additions,deletions`. Idle time is in no notification, so the report gives agent minutes
instead. An agent with no notification in the conversation gets the lines changed, and
`not recorded` in each other cell.

### The monitor

`/workstreams:start` arms `watch` with the Monitor tool itself. It does this each time its
wait loop starts, at the longest timeout the tool allows: 30 minutes at most. Each line the
watch writes wakes the session. The other wake is an agent's completion notification.
Nothing polls an agent, and nothing sleeps in the foreground.

On expiry, the skill arms the watch again. It gives `--since-head` and `--concluded`, and
builds both from the full heads it knows, as `<number>=<full sha>` pairs in one
comma-separated list per flag. The new watch then stays silent about what it
already said.

When a watch exits before expiry, the skill reads its last line. If the cause can clear,
the skill corrects it and arms the watch again, once. Where the watch cannot run, an
agent's completion notification is the only wake. With no agent at work, the skill reports
and stops.

This plugin has no `monitors/monitors.json`. A plugin monitor with
`"when": "on-skill-invoke:start"` would start `watch` the first time the skill runs in a
session. The #274 spike found that this trigger never fires on Claude Code 2.1.283.

To restore it, wait for a later Claude Code version that fires `on-skill-invoke`. Add a
`monitors/` directory with this entry. Then remove the step where the skill arms the watch
itself, in the Wakes section of `skills/start/SKILL.md`. Two watches must never run at once.

```json
[
  {
    "name": "watch",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts\" watch",
    "description": "Pull request heads, required checks and merges for /workstreams:start",
    "when": "on-skill-invoke:start"
  }
]
```

Plugin monitors are experimental. They run only in interactive sessions, and not on
Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry
([plugins reference](https://code.claude.com/docs/en/plugins/manifest-reference#monitors)).

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
issue. It chooses between parallel streams, a stack, and one pull request. A shared
version line, or separate sections of one README, is not a collision. Small issues of one
plugin and one kind fold into one stream, because each pull request costs a review loop.
It posts the sequencing comment on every issue in the round. `skills/sweep/` carries the
rules. `file-map.md` holds the mapping rules a file map must apply.

It is `user-invocable: false`. `/workstreams:start` invokes it when a round has no plan
yet, with a milestone, issue numbers, or no scope. With no scope, `start` also names the
issues of each round in flight. The sweep defers them, and does not map or size them. It
ends at its report.

## `/workstreams:review`

Takes one draft pull request from its first workflow run to `done`, whoever opened it.

The command answers where the loop is. The skill takes the one step that the state calls
for, and returns. It dispatches a round, reopens for an absent run, does the rot check, or
reports. It never waits. The loop runs at most two review rounds, one subagent
each, in the pull request's own worktree. Round 2 runs in two cases only: round 1's own
commits changed code logic, or logic landed after the head that round 1 reviewed (#356).

| State | What it means |
| --- | --- |
| `awaiting-pr` | GitHub said this pull request number does not exist. A failed read gives `state: null` instead. |
| `merged`, `closed` | The pull request already finished. Report it, and dispatch no round. |
| `no-run` | No workflow run with event `pull_request` for the head: close and reopen, once. |
| `review-1`, `review-2` | Dispatch a round. Round 1 does not wait for CI (#384). It reads CI when its reviewers return, and fixes a failed check in the same pass. |
| `fixing` | CI is not green after a round, or a review thread is unresolved, from a person or a bot (#383). The round settles each bot thread as a finding, and the skill replies on it and resolves it. A mermaid preview thread is rejected as informational. Another bot thread that no round settled goes to the person. |
| `rot-check` | Check the title and body against the final diff. |
| `done` | Two rounds at most, CI green, no unresolved thread, the body true. |

The rules a round runs under are in `skills/review/round-brief.md`, the brief template.
`round-2.md` adds the round 2 rules. `rot-check.md` covers the caller's last step. Each
rule fixes something a past round lost. Reviewers are read-only and run no test suites,
because three concurrent suites in one worktree once made a test flake. Reviewers finish
before any edit starts, because one round reviewed its own uncommitted work. The round
agent does not return while a reviewer runs, because one that did cost a resume. Round 2
checks round 1's commits first, because round 2 found round 1 wrong or incomplete on nine
of the ten pull requests reviewed by hand in rounds 5 to 7.

A round puts its findings in its return, in the prose before the JSON line. A file is
optional, because a write outside an isolated worktree can be refused. The caller passes
round 1's return to round 2.

The plan names a review model for each layer. When it names none, the skill chooses one,
and says which and why. It never asks. `opus` reviews round 2. In round 1, `opus` reviews
logic under `src/`, `lib/`, `scripts/` or `hooks/`, and new behaviour at the top of a
stream. `sonnet` reviews any other round 1.

There is no state file. Everything is read again each tick. After each round and after the
rot check, the skill runs [`mark`](#mark): a `workstreams/review-1`, `workstreams/review-2` or
`workstreams/rot-check` commit status. A round's status goes on the head the round reviewed,
and round 1's description is `substantial` or `minor`. `pr-state` reads the statuses back,
so no caller parses a comment (#377).

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
`gh stack` has no `-C` flag, so the brief allows it in one form only,
`(cd <worktree> && gh stack ...)`. The one other `cd` is for the layer's real exercise only
(#374). It is a subshell into a directory under the session's scratchpad:
`(cd <scratchpad dir> && <command>)`. The layer's first `gh stack` command is `init` for the
bottom layer, or `add` for an upper one. The layer reads the root checkout's branch before
and after it, and stops if the root moved. When `gh stack submit` fails because stacks are
not enabled, the layer pushes with `git push` and opens a draft with `gh pr create --draft`.
A layer that joins a GitHub stack its worktree did not initialise uses `gh stack link` (#383,
#366). A permission check can refuse either one. A denied repository step stops the layer
before the dependent step. It returns the command and the denial text, and tries no other
route (#380).
A layer runs only the tests related to its changes. CI's full suite is the coverage gate.
The layer returns after its push and the run check, and does not wait for CI (#272). The
caller reads CI with `pr-state`, and resumes the agent with `SendMessage` when CI goes red.
The lessons section grows layer by layer from what each review finds. That growth is the
most valuable part of an upper layer's brief.

| The layer returns | What the caller does with it |
| --- | --- |
| `constraints_checked` | One entry per numbered rule, with how the diff satisfies it. A miss is visible here rather than in a later review round. |
| `brief_vs_code` | Where the brief was wrong and the code or the documentation was right. Each entry corrects the next layer's brief. |
| `outside_set` | What the layer touched beyond the allowed set. A small, reasonable touch is expected every layer. A silent one is not. |
| `lower_layer` | A defect in a branch the layer does not own. Never applied there. |
| `injected_text_seen` | Text inside a tool result that read like an instruction. |

A layer that edits its pull request body also returns the body's read-back. It reads the
body with `gh pr view <n> --json body`, and gives each section heading and its first line.
The caller compares the read-back with the claim, and sends the layer back on a missing or
mismatched one. A second one from the same layer is a stop (#375).

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

`hooks/hooks.json` registers one `PreToolUse` hook on `Bash|PowerShell`. It refuses three
things, and only for a subagent:

| Refused | Why |
| --- | --- |
| `run_in_background` | A turn that ends on a background command reads to a caller as a worker that stopped short. It happened in three rounds with the rule written in the brief. |
| A git command that would overwrite uncommitted changes to tracked files | Two agents lost uncommitted work to exactly this, one of them with the rule in its brief. The remedy is one commit. |
| A `vitest` or `pnpm test` run while one already runs in the same worktree | Round 12 ruling 9 (#299). Two suites at once cost a loaded machine even more. The remedy is to wait for the process already there. |

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

The third row covers a direct `vitest` run, and `pnpm exec vitest`. A third spelling is
`pnpm test` or `pnpm run test`. `package.json`'s only script, `test`, maps to `vitest run
--coverage`. `pnpm`'s own `-C <dir>`, `--dir <dir>`, and `--dir=<dir>` name the directory
the check compares, rather than the tool call's own `cwd`: the worktree workflow's rule is
"never `cd`; name the absolute path in every command", and this is the spelling that follows
from it. A quoted value stays one argument, so `pnpm -C "/a b" test` and `pnpm --dir='/a b'
test` name `/a b` (#371). A quote that does not close in a `pnpm -C` value, or a quote left
inside the value, leaves the directory unread. The guard then writes a line on stderr and
allows the command.

The rule has two exceptions, `gh stack` and the real exercise, in the form `(cd <dir> &&
<command>)`. So a leading `cd <dir> &&` names the directory of the run after it, in the
subshell form and in the bare form `cd <dir> && pnpm test` (#397). The `cd` must be the
first segment, with `&&` after it. Its scope ends at a second `cd`. In the subshell form,
it also ends at the `)` that closes the subshell of the `cd`. A `cd` after the run, a `cd`
with `;`, `||`, `|` or a new line after it, and a `cd` to `-`, `~`, an option or a variable
are not read. The run then keeps the payload `cwd`, as before. A `pnpm -C` of the run's own
wins over the `cd`. A quote left inside the `cd` directory gets the stderr line and an allow.

The guard lists the `vitest` processes on the machine, through `pgrep`, and reads
each one's cwd, through `/proc` or `lsof`. The guard resolves symbolic links in the payload
`cwd` and in each process cwd first. On macOS, `/tmp` and `/var` are links, so both forms of
one directory still match. A match on that directory is a denial. It names the pid, and asks
the subagent to wait rather than start a second suite.

The guard joins a relative `cd` directory to the payload `cwd`, and a relative `-C` or
`--dir` directory to the `cd` directory, or to the payload `cwd` when there is no `cd`. It
resolves the links in that directory the same way. If it cannot resolve a directory, it
compares the joined path. It does not expand `~` or `$VAR`. With no payload `cwd`, it
cannot check a relative directory. It allows the command and writes a line on stderr.

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

Three things it cannot do. It cannot see a command the harness MOVES to the background when
that command reaches its timeout: that is a different mechanism, with no hook in front of
it. The remedy for that half is the brief's: pass a timeout long enough to finish in. It
is also a guardrail rather than a security boundary. It reads the command as text, so a
`git restore` inside a quoted argument is refused as if it were real. That costs a person
one commit, and never costs anyone their work.

A third thing it cannot see is whether a reviewer agent still runs. So the rule that a
subagent must not edit while one reads stays a brief line here. #263 gives each reviewer
its own worktree, and that is what can enforce it.

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
answers what that template needs. Each layer in the plan fits one agent's budget. The
plan splits a layer that does not fit into more layers, never into slices by hand. The stream
has one worktree until #263 (#380). Once approved, the plan comment goes on every issue in
the round. Housekeeping then runs before the first worktree: `/gh:sync` when the `gh`
plugin is present (otherwise the skill fast-forwards the default branch itself), any
ignored leftover under `plugins/`, and a preflight for a local hook that runs a full
suite on every push. That hook is disabled for the round only when the repository's own
records say CI is the enforcement boundary. Otherwise the skill asks about it once, with
the per-push cost stated. It also reads each workflow's `pull_request` branch filter. When
an upper layer's base gets no CI, it says so on the round's issues, with the order: merge
the layer below, retarget, then CI runs (#383).

It is `user-invocable: false`. `/workstreams:start` invokes it after a sweep.

## Commands

The skills run these; they also run by hand, from any repository, on any machine.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" --help
```

### `sweep`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" sweep [--milestone 4,5 | --issues 12,13] [--json]
```

Reports the open milestones with their issue counts, every open pull request, including
ones no round opened, and, for each milestone asked for plus the issues on no milestone
at all, the two sets. `--milestone` takes one number or a comma-separated list. It is
refused if given twice, because `parseArgs` would otherwise keep only the last one, and
say nothing. Left out, the report covers every open milestone, plus any other milestone
the issues name, so an open issue left on a closed milestone is still reported.
`--issues` scopes the report to those issues, under the milestones they are on. What an
issue unlocks is still read against every open issue. `--issues` and `--milestone` are
not given together. `--json` prints one object for a skill to read.

Exit code 2 means a usage error. Exit code 1 means nothing at all could be read. A read
that partly fails is still an answer: the rows that arrived are reported, and every
reason the answer is short is listed under `unavailable`. A caller reads that list before
it acts on the sets.

The repository is whatever `gh` resolves from the working directory.

### `rounds`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" rounds [--issues 12,13 | --milestone 4,5] [--json]
```

Names the rounds in flight, each with its name, its plan line, when it was planned, and
its open issues. It searches the open issues with a `plan, approved` comment, newest
update first. Each open issue is in the round of its newest plan comment. A round with a
`<round> end,` comment after its plan, on any of its open issues, has ended, and is left
out. A round with the older `## Round end: <round>` heading after its plan has ended too.
The name in that heading can differ in case (#405). A round with no open issue is left out
too, so the rounds that ended before #368 added the end record do not stay in flight.
Issues group by the whole plan line, which carries the approval time, so two rounds of one
name stay apart (#379). A plan line starts with a letter or a digit.

The cost of the open-issue rule: a round whose issues all closed before its round end ran
is not in flight. `start` with that round's issues finds it under `unended`, and runs its
round end.

`--issues` keeps the rounds that hold one of those issues, and reads those issues
directly, so a plan made a moment ago is seen. `outside` names each open issue asked for
that no round in flight holds. `unended` names each closed issue asked for whose newest
plan has no end record. Both are null without `--issues`. `--milestone` keeps the rounds
with an open issue on one of those milestones. The two are not given together. The
GitHub search can take a minute to see a new comment.

`unavailable` also names each open issue in the scope, or in a round in the scope, with a
`plan, approved` line newer than its newest plan line that is not a plan line. It also
names each such issue that the search found with no plan in its 100 newest comments. The
exit codes are those of `sweep`.

### `pr-state`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" pr-state <number> [--round 0|1|2] [--substantial] [--round-1-head <sha>] [--rot-checked] [--json]
```

Reports one pull request's head, draft flag, base, and mergeability. It also reports the
status-check contexts its STACK BOTTOM's base requires, what has reported against each of them,
whether a workflow run with event `pull_request` exists for the head, its unresolved
review threads and its comments, the review facts, a wait hint, and the state the review loop
is in.

The required contexts come from the rules of the base of the pull request's stack bottom
(#398), never hard-coded. GitHub takes the merge requirements of every pull request in a
stack from the bottom pull request's base. From the base of the pull request, the command
follows the chain: a base that is the head of an open pull request moves on to that pull
request's base, and the first base that is the head of no open pull request is the one it
reads. A pull request in no stack reads its own base. A pull request from a fork is not a
link. `rulesBranch` names the branch that it read. A chain that loops, that is longer than
50 pull requests, or that has two open pull requests with one head has no bottom. A list of
open pull requests that could not be read hides the chain too. Each of these makes the
verdict `unavailable`.

A branch no ruleset covers requires nothing. A verdict over an empty list would be green
before a single check had run. Where the bottom's base has no ruleset, the command takes
the verdict over the contexts that have actually reported on the head, and `contextsFrom`
says `head`. That is a design fact, not
a read that fell short, so it is a field of its own. A caller keys on `unavailable` to
decide whether the report is an answer at all.

A check from a cancelled workflow run does not count when a newer run of the same workflow has a
check on the head (#364). Workflow concurrency cancels a run that way. `pr-state` also reads the
runs for the head, so a newer run that has made no check yet supersedes it too (#370). A name the
newer run has not reported yet is pending, not failed. A newer run that completed with no check does not
supersede, since it will make none. The list from the head also leaves out a name that contains
`${{`, a matrix job that did not expand. A commit status has no run, so no newer run supersedes it.

With no ruleset, the list from the head also leaves out a pending check with no workflow run
behind it (#383): a commit status at `PENDING` or `EXPECTED`, or a check run that no workflow
made, with no conclusion. Nothing on the head waits for it, so it could hold the verdict at
`pending` with no end. Once it concludes, it counts. A check with a run, and each name a ruleset
requires, still counts while it is pending. When a check with a run reports the same name, that
check answers for it. When only checks with no run report it, a newer pending one still answers,
such as a re-run of an app's check.

A workflow can skip a job on a draft, and run it after the pull request is ready for review
(#365). GitHub skips a matrix job before the matrix expands, so its check keeps the
expression, such as `Analyze (${{ matrix.language }})`. On a draft, a required context that
no check on the head names is in `draftSkipped` when a check on the head, from a check
suite that concluded `SKIPPED`, has a `${{ ... }}` name that matches it. Each `${{ ... }}`
matches one or more characters that are not `(` or `)`. The verdict leaves these contexts
out, and the text says each one "runs after ready for review". So a draft whose only
missing contexts skip drafts is `green`. When the pull request is not a draft,
`draftSkipped` is empty and each context counts. No workflow file is read. This is a
heuristic: a skipped check with a broad name, such as `${{ matrix.os }}`, matches each
required name with no parenthesis.

The run check reads `actions/runs?branch=<head ref>`, and never `?head_sha=`: that query
has answered nothing for a head whose runs existed. After a round, an unresolved thread holds
the loop at `fixing`, from a person or from a bot. A bot's own thread, review bots included, is
counted apart under `botThreads` (#383, round 15 ruling 7). This reverses part of #219, which
left bot threads out. #219 still holds by its second option: the report names each bot thread.
`/workstreams:review` replies on and resolves each one that a round settled, and each mermaid
preview thread. It names each other bot thread for the person. A plain comment is never counted at
all: the enterprise coverage bot posts a comment on every pull request, and nobody resolves a
comment.

The four review facts come from the `workstreams/<name>` commit statuses that
[`mark`](#mark) writes, on the first 100 commits of the pull request and on each head that a
force-push replaced (#377):

| Fact | Status | Flag |
| --- | --- | --- |
| `round` | 2 with a `review-2` status on any commit, 1 with a `review-1` status, else 0 | `--round` |
| `substantial` | the first `review-1` status has the description `substantial` | `--substantial` |
| `round1Head` | the commit of the first `review-1` status, by its time | `--round-1-head` |
| `rotChecked` | a `rot-check` status on any commit | `--rot-checked` |

Only a status with state `success` counts. `mark` writes no other state.

The FIRST `review-1` status gives the round 1 head (#395). A round agent resumed after its
return gets a second one on its fix head. The first one keeps the head that round 1 reviewed, so
logic in the fix still gives `review-2`. GitHub gives only the newest status of one context on
one commit.

A flag that is given wins over its status (mid-round ruling 14). A pull request whose rounds ran
before the statuses has marker comments and no statuses, so its caller gives the flags. A status
read that fell short is listed under `unavailable`, as on a pull request with more than 100
commits. Then the state and `round` are null, unless `--round` is given: then the flags alone
are the facts.

A force-push, as in a restack, takes its commits out of the pull request. The read still reads
the head that the force-push replaced, but not a commit below that head. A round 1 status with a
fix pushed on top of it is such a commit. Then the round can read lower than it was, and the
loop reviews again.

A `workstreams/` status is never a required context. It is not in the head list, and not in the
verdict, also when a ruleset names it. `watch` leaves it out of `CONCLUDED` the same way.

As a flag, `--round-1-head` holds only with `--round 1` (#380). At round 1 that was not
substantial, the command reads the compare of the round 1 head to the current head (#356). It compares commits, not times, because a
rebase moves commit dates. These give `review-2`:

- The round 1 head is not an ancestor of the head.
- The file list is at GitHub's limit of 300.
- A changed file is logic: a file under `src/`, `lib/`, `scripts/` or `hooks/` at any
  depth. A test file, a file under a test directory and a Markdown file are not logic.

`sinceRound1` gives the reason. A compare that could not be read gives no state at that step.

A merged or closed pull request gives state `merged` or `closed`. This check runs right
after `awaiting-pr`, before every other rule. No CI result, thread, or review status changes it
(#277).

Exit code 2 means a usage error. Exit code 1 means nothing at all could be read.

### `mark`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" mark <number> <name> [--description <text>] [--head <sha>]
```

Writes the commit status `workstreams/<name>`, with state `success`, on the head of the pull
request, or on `--head` (#377, mid-round ruling 14). `<name>` is `review-1`, `review-2`,
`rot-check` or `layer`. [`pr-state`](#pr-state) reads the first three. Nothing reads `layer`
yet (#396). The write goes through the dispatcher, because each skill that writes a status
already may run it.

`--description` is 140 characters at most. For `review-1`, `substantial` says that round 1
changed logic, and any other description is minor. `--head` takes a full 40-character sha. With
`--head`, the pull request is not read.

A status cannot be deleted. A later push leaves it on an older commit of the pull request,
where `pr-state` still reads it.

Exit code 2 means a usage error, or a pull request that GitHub says does not exist. Exit code 1
means the pull request could not be read, or the write failed. The reason is gh's own words.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/workstreams.ts" watch [--interval 60] [--ticks 0] [--heads <branch>,...] [--since-head <n>=<sha>,...] [--concluded <n>=<sha>,...]
```

A long poll of every open pull request, or with `--heads`, of each one whose head branch
it names. A round passes its own branches, so another round's pull requests do not wake
it. It writes one line to stdout for each event
below, so that a Monitor wakes on each line:

- a new pull request
- a new head, compared by the full sha
- each required context as it reports
- one `CONCLUDED` line for each head
- a pull request that merged or closed
- a heartbeat, after ten minutes with no other line

The watch keeps what it has seen in memory, and writes no file.

A head this watch has seen is not new by itself. For a short time after a push, the API
answers the old head, then the new one. The watch keeps every head it has seen for each
pull request, not the current one alone (#264). `--since-head` and `--concluded` seed
this memory with their own head.

A seen head becomes current only on its second answer in a row (ruling 5, #296). A push
back to an earlier, already-seen head writes no line on its first poll. The same head
must answer again on the very next poll, or the watch drops it with no line. Only a
second answer in a row moves the current head, and writes that line.

A head is `CONCLUDED` only when every required context has reported. The list comes
from the rules of the base of the pull request's stack bottom (#398). A base that is the
head of an open pull request moves the read down to that pull request's base, until a base
is the head of none. A pull request in no stack reads its own base. When no ruleset covers
that branch, the list comes from the default branch (ruling P9). The chain uses every open
pull request of the repository, also those that `--heads` leaves out. A base whose chain
loops, or is longer than 50 pull requests, is unread like a base whose read failed (#265).
A `workstreams/<name>` status from [`mark`](#mark) is never a required context, also when a
ruleset names it (#377).
In round 5, a watch concluded on the checks that had reported on the head. Those were seven
CodeQL checks, and none of the required ones.

On a draft head, `CONCLUDED` does not wait for a context in `pr-state`'s `draftSkipped`
(#365). The line names each one after `runs after ready for review:`. When the person marks
the draft ready, the same head concludes again, after those contexts report. A head given to
`--concluded` does so only when the first poll finds it a draft.

`pr-state` and `watch` share one derivation of the list, `src/required-contexts.ts`.
So a cancelled run's check does not count in `watch` either, once a newer run of the same
workflow exists on the head. The watch then writes no failure line for it, and no
`CONCLUDED` until the newer run reports each required context. A newer run with no check yet
shows only in the head's workflow runs, and only while it has not completed. The watch reads them for a pull request only on a poll
where a cancelled check has no newer check, under the same per-call bound (round 15 ruling 6,
#370). An ordinary poll makes no extra call. A failed read gives one line for each new reason,
and leaves that pull request unread for the poll.

Each base reads its required contexts on its own. A base whose read fails leaves unread
only the pull requests that need its list, not the whole poll (#265). A failed default
branch leaves unread every pull request that falls back to it. Each failure writes one
line for each new reason, and a line when that base reads again.

A base with no ruleset of its own is unread too, when its fallback, the default branch,
cannot be read. An empty list is not the same fact as a list nobody could read
(ruling 6, #298).

Every gh call this watch makes carries a bound: the poll interval, in milliseconds
(ruling 4, #295). A hung call cannot outlast one whole poll cycle. It is reported as a
failed read, the same way as any other. `lib/gh.ts` keeps no such bound by default; only
this command sets one.

A poll that read no pull request writes a `poll failed` line and changes nothing. The
line comes once for each new reason, and not on each poll. The first poll that reads
again writes `poll read again`. While polls fail, the heartbeat names the failure. While
a base stays unread, or the runs of a pull request, it names that instead. Neither says "no
change". A list that fell
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

The whole check has 2.5 seconds, well under the hook's own 3 second ceiling
(`.claude/rules/_design-principles.md`). Every read of the filesystem is async, and each step
gets only the time that is left (#267). A check that does not finish in that time is reported
as itself, never as an absent item:

```
workstreams: ⚠️ the GitHub CLI (gh) could not be checked
workstreams: ⚠️ a gh login could not be checked
workstreams: ⚠️ the gh stack extension could not be checked
workstreams: ⚠️ the installed plugins file could not be read
workstreams: ⚠️ no installed copy of pr-review-toolkit could be checked for its reviewer agents
```

A `gh` child that does not exit is killed at the deadline, with its process group. A read that hangs
holds a worker thread, and node waits for that thread before the process can exit. So when a read
still holds the process 20 ms after the output has left, the hook ends itself with `SIGKILL`.
`hooks.json`'s `; exit 0` makes that exit 0. In `claude --debug`, the shell may add a `Killed` line.

The hook does not run `gh --version`. The two `gh` runs above already show a `gh` that cannot
start, as "could not be checked". One more run measured 38 ms (median of 22, node 24, gh
2.102.0).

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
