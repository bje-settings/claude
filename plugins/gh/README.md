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

- **A merged pull request.** It must meet three conditions. It merged into the default branch.
  It came from this repository, not a fork. Its head commit is exactly where your local branch
  still points.

  That last condition is what makes it evidence about your commits, not about a branch name. A
  name someone reused, or a branch you committed to after the merge landed, no longer matches.
  The command keeps that branch. This signal is what catches squash and rebase merges, which
  leave no ancestry behind.

  One `gh` call lists the 200 most recently merged pull requests. If that window fills up, it may
  hide older ones. So, for any branch the first call could not account for, the command makes a
  second call. That second call asks about that branch alone. The fallback call means pruning
  does not quietly stop for a busy repository.
- **Ancestry**, via `git branch --merged origin/<default>`. This is what catches a branch merged
  locally and pushed with no pull request at all.

Either one is sufficient. Neither one alone is complete. The command keeps a branch with no
proof. The report says what it actually established, rather than a guess at a cause:

| Report | What it means |
| --- | --- |
| `no merge proof` | No merged pull request from this repository used this name, and it is not an ancestor of the default branch. |
| `merged PRs used this name; none at this commit` | Something merged under this name, but not this commit. Either someone rebased the branch before it merged, or the name got reused for unrelated work. The two are indistinguishable here. The command keeps the branch. |
| `too many merged PRs used this name to tell` | The per-branch lookup filled up, so the command could not establish "none at this commit". |
| `could not ask about this branch` | The lookup did not complete. The command established nothing either way. |

After the first failed lookup, the command asks no more. The cause is rarely branch-specific, and
a rate limit only gets worse if the command continues. The report lists remaining branches the
same way. The run closes with a count of how many it never checked, so nobody mistakes a partial
run for a complete one.

The last three are all reasons to keep a branch, but they are different statements. A report that
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
cycle. It fixes mechanical failures, on any pull request whether a human or a bot authored it. It
skips anything that needs a logic change. Auto-merge does the actual merge. The skill only gets
each pull request to green, and confirms it landed before it starts the next one.

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

Order is gh-security's `merge-risk:<band>` label first (low, then unlabelled, then medium, then
high), oldest first within a band.

### Flags

| Flag | Effect |
| --- | --- |
| `<label>` | Shepherd only pull requests that carry this one label. |
| `--dry-run` | Print each repository's target list, in order, and stop. Nothing is rebased or waited for. |

### The loop, per pull request

| State | Action |
| --- | --- |
| Behind its base | `gh pr update-branch --rebase`, no checkout, then wait. |
| Conflicts, Dependabot branch | Comment `@dependabot recreate`, wait for the head to move, then wait for CI. Dependabot sometimes closes the pull request while the skill waits, when another pull request already shipped the same or a newer version. When that happens, `recreate` returns early, and the report marks it closed, not skipped. |
| Conflicts, human branch | Skipped: a human or a larger model decides. The skill never resolves it. |
| Checks in progress | Wait one CI cycle: `gh pr checks --watch --fail-fast`, bounded by twice the repo's median run time, at most nine minutes per call. |
| Checks green, auto-merge fired | Record it with the merge commit. Continue. |
| Checks green, still open | `settle`: read the pull request until GitHub decides. Record `merged` as merged, and `closed` as closed. A `BLOCKED` merge state seen twice, or a `REVIEW_REQUIRED`/`CHANGES_REQUESTED` review decision seen once, is skipped. The reason names that field. `BEHIND` or `DIRTY` sends the loop back to decide again. If the bound passes with nothing reported, that itself is the reason. Never merge it by hand. |
| Checks failed, mechanical | Fix it once, in a throwaway worktree, and push. Examples: a lockfile to regenerate, a formatter, a pin that must move in step, or a snapshot whose diff is only the dependency's own output. A second failure is a skip. |
| Checks failed, not mechanical | Skipped: this covers anything that touches program logic, a test's expected behaviour, configuration meaning, or a CI workflow. |
| Checks failed, unclear | Skipped, with a `hypothesis` when the worker has one. |
| Checks failed, mechanical but unverifiable locally | For example, a failure that reproduces only with CI-only secrets. Skipped, with the hypothesis. Never push on a guess: a push would stop Dependabot's maintenance of the branch, and the one-fix cap would turn a wrong guess into a skip. |

`@dependabot recreate` re-resolves the version. It does not reuse the original bump. So a pull
request opened as `x.y.z → x.y.z+1` can merge as `x.y.z → x.y.z+2`, if a newer release landed
while it waited. This is expected Dependabot behaviour. The report's `merged_as` column says so
when it happens.

The default worker is Sonnet, at medium effort. A rebase, a check read, and a failure
classification are all small-model work.

### Waiting

There are two waits, and they wait on different things. The CI wait is a blocking
`gh pr checks --watch`. It runs inside the per-repo subagent, once per CI cycle. It is
deliberately not a Monitor or a scheduled wake: those idle the worker, and the orchestrator then
sees only "waiting". The bound comes from the median duration of the last twenty completed runs
on the default branch. It is doubled, then clamped to two to nine minutes. A wait that hits its
bound returns `pending`, and the agent calls it again. When a rollup is already terminal, the
skill answers from the pull request alone, with no watch at all.

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
- resolve conflicts on a human's branch
- force-push
- commit with `--no-verify`

### Commands

The deterministic parts are two commands. The agent only decides between their results.

```bash
node <plugin>/scripts/gh.ts shepherd-status <path> [label]        # the work list, as JSON
node <plugin>/scripts/gh.ts shepherd-pr <path> <n> state|rebase|recreate|wait|settle|merged
```

`shepherd-status` changes nothing. `shepherd-pr` writes only through two actions: `rebase` (the
branch update), and `recreate` (one comment). It refuses each of those when its precondition does
not hold:
- a pull request that is not open
- a `recreate` on a branch Dependabot did not author

Every action prints one JSON object, with `ok` and `detail`, and exits 0 whether or not it acted.
So a refusal is data for the agent, not a crash.

`recreate` also re-reads the pull request on every poll. A moved head is `recreated`. A pull
request closed or merged with its head unmoved returns early, with `ok: true` and
`result: "closed"` or `"merged"`. It does not wait out the bound. A poll that cannot read the pull
request is counted as such, never mistaken for "the head did not move". If no poll succeeded, the
detail says so, and carries gh's last error. `recreate` is for Dependabot's own pull requests. The
summary's `is_bot` says whether any bot opened it. `is_dependabot` is what the refusal turns on,
because `@dependabot recreate` on a renovate branch is a comment nothing will answer.

Nothing here reports a silence as a fact. When gh could not answer a read, the report carries
gh's own words. When an answer lacks a field the loop decides from, the command refuses it. It
does not shape that answer into a pull request with no checks. A `wait` whose watcher failed for
a reason of its own reports `ok: false`, not `pending`. If it reported `pending` instead, an
expired token would wait out one CI cycle at a time, forever. `rebase` reports gh's output, and
says when the head has not moved. This is because `gh pr update-branch` returns as soon as GitHub
accepts the request, and prints the same line when the branch was already current. A failed
`wait` carries `log_tail`, and `log_error` beside it when gh would not hand over the log. This
way, an empty tail is not mistaken for a job that printed nothing.

`settle` writes nothing at all: it only reads, and sleeps. It refuses a pull request that is
closed, one without auto-merge, or one whose checks are neither `passed` nor absent. It does not
wait out a bound on a question nobody asked. A pull request that has already merged gets an
answer instead of a refusal, because that answer is exactly what `settle` is asked for.

`node <plugin>/scripts/gh.ts shepherd-pr --help` lists the environment knobs
(`SHEPHERD_CI_SECONDS`, `SHEPHERD_WAIT_BOUND`, `SHEPHERD_POLL_SECONDS`, `SHEPHERD_LOG_LINES`,
`SHEPHERD_SETTLE_BOUND`, `SHEPHERD_SETTLE_POLL`).

Repository discovery is shared with `/gh:sync`. Both skills resolve their scope by the same rule.
`node <plugin>/scripts/gh.ts discover <path>` is that rule on its own, one checkout root per
line. A directory with no checkouts in it prints nothing, and exits **0**. That is an answer, not
a failure. Exit **1** means the command could not read the target at all, with the reason on
stderr. Exit **2** means the command refused the arguments. `sync` answers 2 where `discover`
answers 1 on the same two states. So a skill that runs both must read each status against its own
command.

## `gh:issues`

Files, links and triages issues. Claude starts this skill when you ask for an issue, a link
or a triage. Other skills can also start it. It has no slash command
(`user-invocable: false`). It needs gh 2.94 or later.

| Operation | What it does |
| --- | --- |
| Create one issue | Looks for a duplicate first. Then proposes the title, body, type, labels, relationships, milestone and priority. Creates the issue after you confirm. |
| Create a batch | Proposes one milestone for a shared done condition. Creates the issues in dependency order, parents and blockers first. |
| Link | Adds or removes blocked-by, blocking and parent on issues that exist. |
| Triage | Proposes a value for each empty field. Also replaces a type label with the type, and a dependency in text with its field. Sets them after you confirm. |

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

Before a write, the skill asks you to confirm. In a subagent it cannot ask. There it writes
only when the request sets every value. Otherwise it returns the proposal to its caller.

An issue can go to a repository of a different owner than the work that gave it context.
Then the issue names none of that source's repositories, numbers, paths or URLs. A comment on
a duplicate follows the same rule. The skill compares owner names only, with no API call. Two
orgs in one enterprise are different owners. The proposal gets an `Omitted:` line with the
kinds of detail that it removed. The rule is in
[`skills/issues/cross-org.md`](skills/issues/cross-org.md).

## Session start hook

When a session starts, resumes, or clears, the plugin writes one status line, or nothing:

```
gh: 3 repos [behind 2] [prune 1] [🤖 4] [🛡️ 1] ⚠️
```

| Item | What it counts |
| --- | --- |
| `N repos` | The repositories checked, when there is more than one. |
| `behind` | Commits in `origin/<default>` that the local `<default>` does not have. |
| `prune` | Local branches that `/gh:sync` can remove. See below. |
| 🤖 | Open pull requests with the `dependencies` label. |
| 🛡️ | Open Dependabot alerts. |
| ⚠️ | A check failed or did not finish in time. That item is not in the line. |

The line shows only the items above zero. When every count is zero and nothing failed, the hook
writes nothing.

A local branch counts for `prune` when one of these is true. The default branch and the current
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

The whole check has 5 seconds. A part that fails, or does not finish in that time, gives no
count, and the line ends with ⚠️. The hook writes the reason to stderr, one line for each
failure. `claude --debug` shows it.

The plugin needs git and the GitHub CLI. When one of them is not on PATH, the hook checks
nothing. The line names what is missing, for example `gh: ⚠️ GitHub CLI (gh) not found on PATH`.

The hook never changes a branch, worktree, or working tree. The fetch changes only
remote-tracking refs. `session-start` always exits 0, so the hook cannot stop a session.
`hooks.json` runs it as `command -v node ... ; exit 0`, which gives the same result when node is
not on PATH. Below the node floor, the hook exits 0 and writes nothing.

The hook is `hooks/hook-io.ts`. To see the line by hand, run it with `status`:

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
to use. Every entry point checks the current version before it loads anything else. The
session-start hook does this in silence. A command states which version it found.

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
line, with `systemMessage` and nothing else.

pnpm's install path has a test that runs a real `pnpm install`. What remains uncovered is
defensive branches that guard against states nobody can provoke, such as a ref that resolves
during enumeration, then fails immediately after.
