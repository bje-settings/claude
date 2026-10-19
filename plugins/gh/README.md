# gh

GitHub and git workflow skills: keep checkouts current, merge dependency pull
requests one at a time, and file, link and triage issues.

## `/gh:sync`

Moves a checkout to its default branch, fast-forwards it, and prunes local branches and
worktrees whose work has already landed.

Scope comes from the working directory:

| Working directory | What happens |
| --- | --- |
| A git repository | That repository is synced. |
| Not a git repository | Every **immediate** subdirectory that is a git repository is synced, in parallel. |

Detection is non-recursive and never clones. A directory with no git repositories directly
inside it is a no-op. If you run this somewhere unexpected, it costs nothing.

### Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Fetch and report what would happen. No checkout, merge, install, or delete. The fetch itself still updates remote-tracking refs. |
| `--no-install` | Skip dependency installation even when a lock file changed. |
| `-j N` | Parallel jobs in fan-out mode (default 4). |

### Exit status

Exit 0 when every repository synced, or was skipped for a normal reason. Normal reasons include
uncommitted changes and no `origin`. Those are not failures. Exit 1 means a repository's own sync
failed outright. This applies on the single-repository path and the fan-out alike, once the whole
report is already on stdout. Stderr then names which repository, or how many of how many, failed.
Exit 2 means the command refused the arguments, as with any command here.

### What one repository gets

1. The command skips a repo outright, before it changes anything, when any of these is true:
   - it is not a git repo
   - it has no `origin`
   - it has a git operation in progress in any of its worktrees
   - it has uncommitted changes
   - its working tree cannot be read at all

   Untracked files do not block it. The checkout, fast-forward, and branch deletion cannot touch
   them, though a dependency install can. The command also skips a repo after the fetch, if its
   default branch cannot be resolved, or if `origin/<default>` does not exist locally.
2. `git fetch --prune origin`.
3. Checkout of the default branch, then `git merge --ff-only`. This is fast-forward only. If a
   branch has diverged, the command reports it for the user to handle, and does not merge it
   automatically.
4. Dependency install, but only if the pull actually changed a lock file. **pnpm only**: the
   one lock file watched is `pnpm-lock.yaml`, and the one command run is
   `pnpm install --frozen-lockfile`. The command syncs a checkout on any other package manager as
   a repository with no dependencies to install. Install those by hand.
5. Branch and worktree pruning.

### How the command proves a branch is merged

The command deletes a branch only with positive proof, from either of two independent signals:

- **A merged pull request.** It must meet three conditions. Its merge commit is on the default
  branch, whatever its base, so a stacked pull request counts. It came from this repository, not
  a fork. Each commit of your local branch is in its head: the same commit, or a patch-equal one
  after a rebase on GitHub. A merge of your tip into its head must also change nothing.

  That last condition is what makes it evidence about your commits, not about a branch name. A
  name someone reused, or a branch you committed to after the merge landed, no longer matches.
  The command keeps that branch. This signal is what catches squash and rebase merges, which
  leave no ancestry behind.

  One `gh` call lists the 200 most recently merged pull requests. If that window fills up, it may
  hide older ones. So, for any branch the first call could not account for, the command makes a
  second call. That second call asks about that branch alone. The fallback call means pruning
  does not quietly stop for a busy repository.
- **Ancestry**, via `git merge-base --is-ancestor` on the tip that the prune step read. This is
  what catches a branch merged locally and pushed with no pull request at all.

Either one is sufficient. Neither one alone is complete. The command keeps a branch with no
proof. The report says what it actually established, rather than a guess at a cause:

| Report | What it means |
| --- | --- |
| `no merge proof` | No merged pull request from this repository used this name with its merge commit on the default branch, and the tip is not an ancestor of the default branch. |
| `merged PRs used this name; none at this commit` | Something merged under this name, but your branch holds a commit or a change that its head does not. The name got reused, or you committed after the merge. The command keeps the branch. |
| `too many merged PRs used this name to tell` | The per-branch lookup filled up, so the command could not establish "none at this commit". |
| `could not ask about this branch` | The lookup did not complete. The command established nothing either way. |
| `could not fetch a merged PR's commits; unproven, not disproven` | The head of a merged pull request is not here, and one fetch did not bring it. |
| `git could not compare its commits; unproven, not disproven` | A git probe of the proof failed. The command established nothing either way. |

After the first failed lookup, the command asks no more. The cause is rarely branch-specific, and
a rate limit only gets worse if the command continues. The report lists remaining branches the
same way. The run closes with a count of how many it never checked, so nobody mistakes a partial
run for a complete one.

The last five are all reasons to keep a branch, but they are different statements. A report that
collapsed them would assert things it had not checked. The command never treats a `gone` upstream
as proof on its own. A pruned remote branch can equally mean someone abandoned the work.

If **both** signals are unavailable (no `gh`, or the branch listing failed), the command reports
the repo and skips pruning entirely. It does not fall back to the surviving signal.

The command excludes two further branches, even when they do have proof: the default branch
itself, and any branch whose tip is the same commit as `origin/<default>`. That second kind has
nothing to prune, and is typically a branch just created, with no commits of its own yet.

Deletion uses `git branch -D`. This is necessary because a squash-merged branch is not an
ancestor of anything. The report gives every deleted branch's SHA, so you can undo a mistake with
`git branch <name> <sha>`. If the branch also had a worktree, the command removed that directory
too. Restoring it needs `git worktree add`, plus a fresh dependency install.

A worktree that holds uncommitted changes outranks the merge proof. The command leaves both the
worktree and its branch alone, and reports them.

## `/gh:shepherd`

Merges every open, non-draft pull request that has auto-merge set, one at a time. An optional
argument narrows this to one label. It rebases each one if it is behind. It waits on CI once per
cycle. It resolves conflicts by merging the base branch into the pull request, and fixes the
failures that the base caused, on any pull request whether a human or a bot authored it.
Auto-merge does the actual merge. The skill only gets each pull request to green, and confirms
it landed before it starts the next one.

Serial is the point. A strict up-to-date rule puts every other open pull request behind after
each merge. If you shepherd them in parallel, each merge costs a CI run per pull request. One at
a time costs exactly one rebase each. A by-hand run of six Dependabot pull requests measured
exactly that.

Scope comes from the working directory, as with `/gh:sync`:

| Working directory | What happens |
| --- | --- |
| A git repository | The skill shepherds that repository's pull requests, serially. |
| Not a git repository | Every **immediate** subdirectory that is a git repository gets its own subagent. Repos run in parallel. Each one is serial inside. |

### What counts as a target

An open, non-draft pull request that already has auto-merge enabled, whoever authored it.
Auto-merge is the human's signal that they want the pull request. The skill never enables it
itself. A run named with a label targets only pull requests that carry it. A second label in the
same run is refused.

The review rules of the base can leave a pull request out too (#465). `shepherd-status` reads the
`pull_request` rules of each base once. A pull request is not ready when its base requires an
approval that it does not have. It is also not ready when its base requires resolved review
threads and a thread is open. A rule requires an approval by a count above 0, a code owner
review, or the last push. A `reviewDecision` can require one too. Such a pull request goes to
`not_ready`, with its reasons: "needs an approval", "has unresolved review threads". The report
names it, so the person knows it needs a review. A repository whose rules require no review is
shepherded as before. A read of the rules or the threads that fails leaves nothing out, and
stderr says why. When the rules fail, the approval rests on `reviewDecision`. `--all` makes every
auto-merge pull request a target again.

Order is gh-security's `merge-risk:<band>` label first (low, then unlabelled, then medium, then
high), oldest first within a band.

### Flags

| Flag | Effect |
| --- | --- |
| `<label>` | Shepherd only pull requests that carry this one label. |
| `--all` | Shepherd every auto-merge pull request, also one that the review rules of its base leave out. |
| `--dry-run` | Print each repository's target list, in order, then its `not_ready` list, and stop. Nothing is rebased or waited for. |

### The loop, per pull request

| State | Action |
| --- | --- |
| Not ready, without `--all` | `state` reports `approval` `missing` or `threads` `unresolved`. A review can be dismissed during a run. Skipped, with "needs an approval" or "has unresolved review threads", before any rebase or wait. |
| Behind its base | `gh pr update-branch --rebase`, no checkout. Read the pull request every 5 seconds until the head moves, for at most 60 seconds. Then wait. GitHub's compare of the base and the head decides "behind". `mergeStateStatus` does not, because it reads `BLOCKED` while a check is pending. A head that is behind is rebased before any wait. When the compare cannot be read, `mergeStateStatus` decides. |
| Conflicts | In a throwaway worktree, `git merge origin/<base>` into the head branch, for any author. Regenerate a lockfile with the repository's own package manager. Keep the keys of both sides in a manifest. Keep both intents in code. Verify locally, commit, and run a plain `git push`. Then wait for CI. Never rebase, and never force-push. |
| Checks in progress | Wait one CI cycle: read the pull request and the compare every 30 seconds. The bound is twice the repo's median run time, at most nine minutes per call. A base that moves during the wait ends it at the next poll, and the head is rebased. |
| Checks green, auto-merge fired | Record it with the merge commit. Continue. |
| Checks green, still open | `settle`: read the pull request until GitHub decides. Record `merged` as merged, and `closed` as closed. A `BLOCKED` merge state seen twice, or a `REVIEW_REQUIRED`/`CHANGES_REQUESTED` review decision seen once, is skipped. The reason names that field. `BEHIND` or `DIRTY` sends the loop back to decide again. If the bound passes with nothing reported, that itself is the reason. Never merge it by hand. |
| Checks failed, mechanical or caused by the base | Fix it once, in a throwaway worktree, and push. Examples: a lockfile to regenerate, a formatter, a pin that must move in step, a snapshot refresh, or a configuration move that the new base requires (an override from `package.json` to `pnpm-workspace.yaml` for pnpm 12). A pull request that had conflicts gets one merge push and one fix. A second failure is a skip that names both attempts and the conflicted files. |
| Checks failed, already failing | Skipped: the check failed on the pull request's own head before the skill touched it. The reason names the check, the files, and why. |
| Checks failed, unexplained or unverifiable locally | For example, a failure that reproduces only with CI-only secrets. Skipped, with a `hypothesis` when the worker has one. Never push on a guess: the one-fix cap would turn a wrong guess into a skip. |

The report lists each conflicted file of a pull request that had conflicts, and how the skill
resolved it.

The default worker is Sonnet, at medium effort. A rebase, a check read, and a failure
classification are all small-model work.

### Waiting

There are two waits, and they wait on different things. The CI wait, `wait`, is a blocking poll.
It runs inside the per-repo subagent, once per CI cycle. It is deliberately not a Monitor or a
scheduled wake: those idle the worker, and the orchestrator then sees only "waiting". The bound
comes from the median duration of the last twenty completed runs on the default branch. It is
doubled, then clamped to two to nine minutes. A wait that hits its bound returns `pending`, and
the agent calls it again. When a rollup is already terminal, the skill answers from the first
read, with no poll at all.

Each poll reads the pull request and GitHub's compare of its base and its head. A head that does
not contain the tip of its base returns `behind`. This occurs before the first poll, or at the
poll that sees the base move. Under a strict up-to-date rule, a green run on such a head cannot
let auto-merge fire. Its CI time would then be spent for nothing. The first failed check returns
`failed` without the rest of the run. A compare that cannot be read gives `behind: null`, and the
poll goes on.

The second is `settle`, the grace between "checks passed" and "auto-merge did not fire". It
exists because that grace used to be one `gh` round trip. The brief told the agent to spend it on
a second `wait`, but `wait` returns at once on a terminal rollup. So the old check reported a pull
request as blocked even when it merged a second later.

`settle` ends on evidence, not on a clock. Any state GitHub reports that decides the question
ends it at once. That includes merged, closed, a blocking review decision, or a base that moved
to `BEHIND` or `DIRTY`. A `BLOCKED` merge state ends it too, once a second read confirms it.
GitHub reports `BLOCKED` while it still reconciles a check that has only just gone green. Only a
pull request GitHub has said nothing decisive about reaches the bound. That means still `OPEN`,
not merged, and in a merge state that neither proves nor reopens the question. `CLEAN` is the
usual case. `UNKNOWN` and the rest work the same way. The reason it records then says exactly
that, rather than a guess at a cause.

It reports the reading as well as the result. The skill measures `waited` directly; it does not
accumulate it from its own sleeps. `reads_ok`, `read_failures`, and `read_error` travel beside it.
If every read after the first fails, `settle` refuses, in gh's own words, instead of answering
`open`: "nothing was reported against it" would be a statement about a silence, which is the one
thing nothing in this plugin does.

That bound is 90 seconds. It is the one guess in the script that decides an outcome, rather than
one that sizes a bound. The script deliberately does not scale it from `SHEPHERD_CI_SECONDS`.
That number is the measured median of the repository's own workflow runs. What `settle` waits on
is GitHub's auto-merge latency, after the checks are already green. A proper measurement of that
latency is future work. The constant stands in until field tests say whether it ever decides an
outcome.

The orchestrator makes one more read before it prints the report. A `skipped` entry with a
`CLEAN` or `UNKNOWN` merge state, and auto-merge on, is the signature of the same race. So the
orchestrator runs `merged` once, and reclassifies it. It leaves alone a `skipped` entry that names
a cause. GitHub decided that, not the clock.

### What it never does

Never:
- merge by hand
- enable or disable auto-merge
- bypass or re-run a required check
- edit labels
- force-push
- commit with `--no-verify`

### Commands

The deterministic parts are two commands. The agent only decides between their results.

```bash
node <plugin>/scripts/gh.ts shepherd-status <path> [label] [--all]   # the work list, as JSON
node <plugin>/scripts/gh.ts shepherd-pr <path> <n> state|rebase|wait|settle|merged
```

`shepherd-status` changes nothing. It prints `targets` and `not_ready`. Each target carries
`approval` (`met`, `missing`, `not_required`, or `null`) and `threads` (`resolved`, `unresolved`,
`not_required`, or `null`). `shepherd-pr` writes only through one action: `rebase` (the branch
update). It refuses that when its precondition does not hold: the pull request is not open.
`state` reads the review rules of the base, and reports `approval` and `threads` the same way.
The other actions do not read the rules: their `approval` rests on `reviewDecision`, and their
`threads` is `null`.

Every action prints one JSON object, with `ok` and `detail`, and exits 0 whether or not it acted.
So a refusal is data for the agent, not a crash.

Nothing here reports a silence as a fact. When gh could not answer a read, the report carries
gh's own words. When an answer lacks a field the loop decides from, the command refuses it. It
does not shape that answer into a pull request with no checks. A `wait` whose bound arrives on a
failed read reports `ok: false`, not `pending`. If it reported `pending` instead, an expired token
would wait out one CI cycle at a time, forever. `gh pr update-branch` returns as soon as GitHub
accepts the request, before the head moves. So `rebase` reads the pull request until the head
moves, or until its bound. It reports gh's output and a `result`. The `result` is `moved`, or
`unmoved` (still queued at the bound). It is `up_to_date` when gh said the branch already holds
its base: then `rebase` reads once. When the last read fails, the report has no `result`, and
`after` is empty. A failed
`wait` carries `log_tail`, and `log_error` beside it when gh would not hand over the log. This
way, an empty tail is not mistaken for a job that printed nothing.

`settle` writes nothing at all: it only reads, and sleeps. It refuses a pull request that is
closed, one without auto-merge, or one whose checks are neither `passed` nor absent. It does not
wait out a bound on a question nobody asked. A pull request that has already merged gets an
answer instead of a refusal, because that answer is exactly what `settle` is asked for.

`node <plugin>/scripts/gh.ts shepherd-pr --help` lists the environment knobs
(`SHEPHERD_CI_SECONDS`, `SHEPHERD_WAIT_BOUND`, `SHEPHERD_WAIT_POLL`, `SHEPHERD_LOG_LINES`,
`SHEPHERD_SETTLE_BOUND`, `SHEPHERD_SETTLE_POLL`, `SHEPHERD_REBASE_BOUND`, `SHEPHERD_REBASE_POLL`).

Repository discovery is shared with `/gh:sync`. Both skills resolve their scope by the same rule.
`node <plugin>/scripts/gh.ts discover <path>` is that rule on its own, one checkout root per
line. A directory with no checkouts in it prints nothing, and exits **0**. That is an answer, not
a failure. Exit **1** means the command could not read the target at all, or git itself could not
run. Either way, the reason is on stderr. Exit **2** means the command refused the arguments.
`sync` answers 2 where `discover` answers 1 on the same states. So a skill that runs both must
read each status against its own command.

## `gh:issues`

Files, links and triages issues. Claude starts this skill when you ask for an issue, a link
or a triage. Other skills can also start it. It has no slash command
(`user-invocable: false`). It needs gh 2.94 or later.

| Operation | What it does |
| --- | --- |
| Create one issue | Looks for a duplicate first. If it finds one, it reports it with a comment to add, and creates nothing. Otherwise it chooses the title, body, type, labels, relationships, milestone and priority, and creates the issue. |
| Create a batch | Uses an open milestone that fits, or creates one for a shared done condition. Creates the issues in dependency order, parents and blockers first. |
| Link | Adds or removes blocked-by, blocking and parent on issues that exist. |
| Triage | Sets a value for each empty field, or leaves it open and says why. Also replaces a type label with the type, and a dependency in text with its field. |

The skill puts each relationship in its field, never in a body or a comment. It never
creates a label. The issue type comes from the types that the repository defines. The
title type gives the start value: `fix` is Bug, `feat` is Feature, and `docs`, `refactor`,
`test`, `chore` and `ci` are Task. The skill adds no label that says the same thing as a
type (`bug`, `enhancement`). It uses such a label only when the repository has no issue
types.

Priority is an organization issue field (in the bje orgs: Urgent, High, Medium, Low).
`gh issue` has no flag for it, so the skill sets it with GraphQL. A repository that a user
owns has no such field. The skill then gives the level in its report only. The rubric is in
[`skills/issues/priority.md`](skills/issues/priority.md).

The skill never asks for confirmation, in the main session or in a subagent: a caller that
starts it has decided to write. After each write it reports every value from a read-back, so
you can correct one. A caller value that does not exist goes on a `Not set:` line, and a
replaced value on a `Replaced:` line. A failed write stops the skill, and the report says
what is set. Each run ends with an `Issues opened:` list, also in a subagent, so you see each
issue that the model filed on its own. Close an unwanted one as not planned.

An issue can go to a repository of a different owner than the work that gave it context.
Then the issue names none of that source's repositories, numbers, paths or URLs. A comment on
a duplicate follows the same rule. The skill compares owner names only, with no API call. Two
orgs in one enterprise are different owners. The report gets an `Omitted:` line with the
kinds of detail that it removed. The rule is in
[`skills/issues/cross-org.md`](skills/issues/cross-org.md).

## Session start hook

When a session starts, resumes, clears, or compacts, the plugin writes a status line. Then it
writes one line for each kind of problem:

```
gh: [repos: 21] [behind] [✂️ 27] [🤖 4] [🛡️ 1]
gh: ⚠️ fetch failed in 15 repos: Invalid username or token
gh: ⚠️ GitHub request failed: Bad credentials (HTTP 401)
```

| Item | What it shows |
| --- | --- |
| `repos: N` | The repositories checked, when there is more than one. |
| `behind` | At least one local `<default>` is behind its `origin/<default>`. |
| ✂️ | Local branches that `/gh:sync` can remove. See below. |
| 🤖 | Open pull requests that Dependabot opened. A repository with more than 100 open pull requests gets a problem line. |
| 🛡️ | Open Dependabot alerts. |

The CLI shows the output under its own `SessionStart:<source> says:` label, which no hook can
hide. So the output starts on the line after the label. The status line is cyan, each problem
line is yellow, and `gh:` is bold. `hook-io.ts status` (below) writes the same lines with no colour.

The status line shows only the items above zero. When every count is zero and nothing failed,
the hook writes nothing.

A local branch counts for ✂️ when one of these is true. The default branch and the current
branch never count.

- Its upstream is set, and the remote branch is gone.
- It is merged into `origin/<default>`, and it tracks its own remote branch. A new branch that
  tracks `origin/<default>` does not count.
- Its tip is the head of one of the last 100 merged pull requests of the repository. A pull
  request from a fork does not count.

The hook checks the repository that holds the session's directory. Outside a repository, it
checks each repository directly inside that directory, and adds the counts. It skips a repository
whose `origin` is not on github.com. For each repository, it runs `git fetch --prune origin`, then
reads the local refs. One GraphQL query reads the GitHub items for each group of five
repositories. The queries and the fetches run at the same time.

The whole check has 2.5 seconds, well under the hook's own 3 second ceiling
(`.claude/rules/_design-principles.md`). The time starts when the hook starts. So the read of the
session's directory and the `PATH` walk count against it too. A part that fails, or does not finish
in that time, gives no count. It gives a `gh: ⚠️` line instead, one line for each kind of problem,
never one for each repository. Each kind has fixed words, such as `fetch failed` or `timed out`. In
a folder of repositories, the line says how many repositories the kind hit: `in 15 repos`, or `in 1
repo`.

A short cause follows when the failure came with a message. It is the first line of the first
failure's message, up to its first sentence end, at most 80 characters.

The hook writes each failure in full to stderr, one line for each failure, with its repository.
`claude --debug` shows it.

The plugin needs git and the GitHub CLI. When one of them is not on PATH, the hook checks
nothing. Each missing tool gets a line of its own instead, git first:

```
gh: ⚠️ git not found on PATH
gh: ⚠️ GitHub CLI (gh) not found on PATH
```

The reason also goes to stderr, without the `gh: ⚠️` prefix, one line for each missing tool. The
hook also writes `hookSpecificOutput.additionalContext`. It states which tools are absent and
that the plugin cannot run. The model then does not start work that will fail. With every tool
present, there is no `additionalContext` at all.

A `PATH` walk that does not finish in time is not a missing tool. That tool gets
`gh: ⚠️ git could not be checked` or `gh: ⚠️ GitHub CLI (gh) could not be checked`, and the hook
checks nothing else. `additionalContext` names only the tools that are absent. A read of the
session's directory that does not finish in time gives `gh: ⚠️ folder could not be read`. The
hook then does not check its own directory instead, because that directory is most often on the
same slow filesystem.

Every read of the filesystem here is async (#267). A read that hangs then holds a worker thread, not
the hook, and the deadline still fires. node waits for that thread before the process can exit. So
when a read still holds the process 20 ms after the output has left, the hook ends itself with
`SIGKILL`. `hooks.json`'s `; exit 0` makes that exit 0. In `claude --debug`, the shell may add a
`Killed` line.

The hook never changes a branch, worktree, or working tree. The fetch changes only
remote-tracking refs. `session-start` always exits 0, so the hook cannot stop a session.

When node is not on PATH at all, `hooks.json`'s own command string writes the alert. No script
can run to report that:

```
gh: ⚠️ node not found on PATH
```

Below the node floor, the hook writes one line with the floor name, then exits 0:

```
gh: ⚠️ node "v20.19.0" is below the floor: 22.18.0 or newer.
```

The hook is `hooks/hook-io.ts`. To see the lines by hand, run it with `status`:

```bash
node <plugin>/hooks/hook-io.ts status /path/to/a/repo-or-folder
```

## Credentials

These commands shell out to `gh` and `git`. They inherit the environment of the directory you
invoked them from. If you use a per-directory credential switcher, such as `direnv`, to select a
GitHub account (`GH_CONFIG_DIR`), run the command from inside the tree it applies to. This way,
the right account stays active.

This follows from the non-recursive scope. A directory whose immediate children are themselves
directories *of* repositories, rather than repositories, is a no-op. That is deliberate. Such a
tree usually spans several accounts. One pass over it would use the wrong credentials for all but
one.

## Running outside Claude Code

The commands have no dependency on the plugin runtime:

From an installed copy of the plugin, `<plugin>` below is the plugin's own directory. Inside
Claude Code, the skills use `${CLAUDE_PLUGIN_ROOT}` for it.

```bash
node <plugin>/scripts/gh.ts sync --dry-run /path/to/a/directory-of-repos
node <plugin>/scripts/gh.ts sync-repo --dry-run /path/to/a/repo
node <plugin>/scripts/gh.ts discover /path/to/a/directory-of-repos
node <plugin>/scripts/gh.ts shepherd-status /path/to/a/repo
node <plugin>/scripts/gh.ts shepherd-pr /path/to/a/repo 12 state
```

`node <plugin>/scripts/gh.ts` with no command prints the list, and each command prints its own usage
for `--help`.

Everything in this plugin is TypeScript. Node runs it directly, with no build step. It needs
**node 22.18 or newer**: that is the release whose type stripping runs a `.ts` file as it stands.
The plugin takes no dependency of its own, and carries no `package.json`, so it needs no install
to use. Every entry point checks the current version before it loads anything else. A command
states which version it found. The session-start hook writes one line with the floor version
instead. It runs once, and it may say so, unlike a hook on every tool call, which must stay
silent.

## Tests

The tests for this plugin live in `tests/plugins/gh/`, in the repository that owns it,
`bje-settings/claude`. They are outside the plugin directory, so they are not installed with it.

Because these skills delete branches and remove worktrees, the tests check their behaviour
against real git repositories, not mocks. They cover in particular: every path that can delete
something (each merge signal, a reused branch name, a fork's pull request, a pull request merged
into another base, worktrees clean and dirty), every preflight refusal, and the guarantee that
`--dry-run` changes nothing it says it would change. Each command's tests check it against the
report its predecessor printed, captured scenario by scenario before the tests deleted that
version. The session-start hook's tests check that each case writes one JSON document, on one
line, with `systemMessage`, and `hookSpecificOutput.additionalContext` only when a tool is absent.

pnpm's install path has a test that runs a real `pnpm install`. What remains uncovered is
defensive branches that guard against states nobody can provoke, such as a ref that resolves
during enumeration, then fails immediately after.
