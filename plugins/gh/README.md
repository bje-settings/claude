# gh

GitHub and git workflow skills: keep checkouts current, and merge dependency
pull requests one at a time.

## `/gh:sync`

Moves a checkout to its default branch, fast-forwards it, and prunes local branches and
worktrees whose work has already landed.

Scope comes from the working directory:

| Working directory | What happens |
| --- | --- |
| A git repository | That repository is synced. |
| Not a git repository | Every **immediate** subdirectory that is a git repository is synced, in parallel. |

Detection is non-recursive and never clones. A directory with no git repositories directly
inside it is a no-op, so running this somewhere unexpected costs nothing.

### Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Fetch and report what would happen. No checkout, merge, install, or delete. The fetch itself still updates remote-tracking refs. |
| `--no-install` | Skip dependency installation even when a lock file changed. |
| `-j N` | Parallel jobs in fan-out mode (default 4). |

### What one repository gets

1. Skipped outright, before anything is modified, if it is not a git repo, has no `origin`,
   has a git operation in progress in any of its worktrees, has uncommitted changes, or has a
   working tree that cannot be read at all. Untracked files do not block it: the checkout,
   fast-forward, and branch deletion cannot touch them. A dependency install can.
   A repo is also skipped, after the fetch, if its default branch cannot be resolved or
   `origin/<default>` does not exist locally.
2. `git fetch --prune origin`.
3. Checkout of the default branch, then `git merge --ff-only`. Fast-forward only, so a
   diverged branch is reported for manual handling rather than merged automatically.
4. Dependency install, but only if the pull actually changed a lock file. **pnpm only**: the
   one lock file watched is `pnpm-lock.yaml`, and the one command run is
   `pnpm install --frozen-lockfile`. A checkout on any other package manager is synced as a
   repository with no dependencies to install, and is installed by hand.
5. Branch and worktree pruning.

### How a branch is proven merged

A branch is deleted only with positive proof, from either of two independent signals:

- **A merged pull request.** It must have merged into the default branch, must have come from
  this repository rather than a fork, and its head commit must be exactly where your local
  branch still points. That last condition is what makes it evidence about your commits rather
  than about a branch name: a name that was reused, or a branch you committed to after the merge
  landed, no longer matches and is kept. This signal is what catches squash and rebase merges,
  which leave no ancestry behind. One `gh` call lists the 200 most recently merged pull requests.
  If that window fills up it may be hiding older ones, so any branch it cannot account for gets a
  second call asking about that branch alone, and a busy repository does not quietly stop pruning.
- **Ancestry**, via `git branch --merged origin/<default>`. This is what catches a branch merged
  locally and pushed with no pull request at all.

Either one is sufficient; neither one alone is complete. A branch with no proof is kept, and the
report says what was actually established rather than guessing at a cause:

| Report | What it means |
| --- | --- |
| `no merge proof` | No merged pull request from this repository used this name, and it is not an ancestor of the default branch. |
| `merged PRs used this name; none at this commit` | Something merged under this name, but not this commit. Either the branch was rebased before merging, or the name was reused for unrelated work. The two are indistinguishable here, so the branch is kept. |
| `too many merged PRs used this name to tell` | The per-branch lookup filled up, so "none at this commit" could not be established. |
| `could not ask about this branch` | The lookup did not complete. Nothing was established either way. |

After the first failed lookup the command stops asking, since the cause is rarely branch-specific
and a rate limit only worsens if you keep going. Remaining branches are reported the same way, and
the run closes with a count of how many were never checked, so a partial run is not mistaken for a
complete one.

The last three are all reasons to keep a branch, but they are different statements, and a report
that collapsed them would be asserting things it had not checked. A `gone` upstream is never
treated as proof on its own, since a pruned remote branch can equally mean the work was abandoned.

If **both** signals are unavailable (no `gh`, or the branch listing failed), the repo is
reported and pruning is skipped entirely rather than run on the surviving signal.

Two further branches are excluded even when they do have proof: the default branch itself, and
any branch whose tip is the same commit as `origin/<default>`, which has nothing to prune and is
typically a branch just created and not yet committed to.

Deletion uses `git branch -D`, which is required because a squash-merged branch is not an
ancestor of anything. Every deleted branch is reported with its SHA, so a mistake is undone with
`git branch <name> <sha>`. If the branch also had a worktree, that directory was removed too, and
restoring it needs `git worktree add` plus a fresh dependency install.

A worktree holding uncommitted changes outranks the merge proof: both the worktree and its
branch are left alone and reported.

## `/gh:shepherd`

Merges a repository's open `dependencies` pull requests one at a time. Each one is rebased if it
is behind, CI is waited on once per cycle, mechanical failures are fixed, and anything that would
need a logic change is skipped with a comment saying why. Auto-merge does the merging; the skill
only gets each pull request to green and confirms it landed before starting the next.

Serial is the point. Under a strict up-to-date rule every merge puts every other open pull
request behind, so shepherding them in parallel costs a CI run per pull request per merge. One
at a time costs exactly one rebase each, which is what a by-hand run of six Dependabot pull
requests measured.

Scope comes from the working directory, as with `/gh:sync`:

| Working directory | What happens |
| --- | --- |
| A git repository | That repository's pull requests are shepherded, serially. |
| Not a git repository | Every **immediate** subdirectory that is a git repository gets its own subagent; repos run in parallel, each one serial inside. |

### What counts as a target

An open, non-draft pull request that carries the `dependencies` label **and** already has
auto-merge enabled. Auto-merge is the human's signal that the pull request is wanted; the skill
never enables it. `dependencies` pull requests without auto-merge are listed in the report so
you can enable it and rerun.

Order is gh-security's `merge-risk:<band>` label first (low, then unlabelled, then medium, then
high), oldest first within a band.

### Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print each repository's target list, in order, and stop. Nothing is rebased, commented on, or waited for. |
| `--repo <path>` | Shepherd only that repository. |

### The loop, per pull request

| State | Action |
| --- | --- |
| Behind its base | `gh pr update-branch --rebase`, no checkout, then wait. |
| Conflicts, Dependabot branch | Comment `@dependabot recreate`, wait for the head to move, then wait for CI. If the pull request is closed while waiting, which is what Dependabot does when another pull request already shipped the same or a newer version, `recreate` returns early and it is reported as closed, not blocked. |
| Conflicts, human branch | Reported as needing escalation. Never resolved by the skill. |
| Checks running | Wait one CI cycle: `gh pr checks --watch --fail-fast`, bounded by twice the repo's median run time, at most nine minutes per call. |
| Checks green, auto-merge fired | Recorded with the merge commit. Next. |
| Checks green, still open | `settle`: read the pull request until GitHub decides. Merged is recorded as merged, and closed as closed; a `BLOCKED` merge state seen twice, or a `REVIEW_REQUIRED`/`CHANGES_REQUESTED` review decision seen once, is a block whose reason names that field; `BEHIND` or `DIRTY` sends the loop back to decide again; the bound passing with nothing reported is a block whose reason is exactly that. Never merged by hand. |
| Checks failed, mechanical | Fixed once in a throwaway worktree and pushed: a lockfile to regenerate, a formatter, a pin that must move in step, a snapshot whose diff is only the dependency's own output. A second failure is a skip. |
| Checks failed, not mechanical | Skipped with a comment saying why: anything touching program logic, tests' expectations of behaviour, configuration semantics, or a CI workflow. |
| Checks failed, unclear | Reported as needing escalation, with a `hypothesis` when the worker has one, so the escalation rerun does not start from zero. |
| Checks failed, mechanical but unverifiable locally | For example a failure that only reproduces with CI-only secrets. Escalated with the hypothesis, never pushed on spec: a push would stop Dependabot maintaining the branch, and the one-fix cap would turn a wrong guess into a skip. |

`@dependabot recreate` re-resolves the version instead of reusing the original bump, so a pull
request opened as `x.y.z → x.y.z+1` can merge as `x.y.z → x.y.z+2` if a newer release landed
while it waited; expected Dependabot behaviour, and the report's `merged_as` column says so
when it happens.

The report ends with an offer to rerun the escalated pull requests with a larger model. The
default worker is Sonnet at medium effort, since rebasing, reading a check, and classifying a
failure are small-model work; cost scales with the rare hard case rather than the common easy one.

### Waiting

There are two waits, and they wait on different things. The CI wait is a blocking
`gh pr checks --watch`, run inside the per-repo subagent, once per CI cycle. It is deliberately
not a Monitor or a scheduled wake: those idle the worker and leave the orchestrator seeing only
"waiting". The bound comes from the median duration of the last twenty
completed runs on the default branch, doubled, clamped to two to nine minutes; a wait that hits
its bound returns `pending` and the agent calls it again. A rollup that is already terminal is
answered from the pull request without watching at all.

The second is `settle`, the grace between "checks passed" and "auto-merge did not fire". It
exists because that grace used to be one `gh` round trip: the agent was told to spend it on a
second `wait`, and `wait` returns at once on a terminal rollup. A pull request that merged one
second later was reported blocked.

`settle` ends on evidence rather than on a clock. Any state GitHub reports that decides the
question ends it -- merged, closed, a blocking review decision, or a base that moved to `BEHIND`
or `DIRTY`, each on sight; a `BLOCKED` merge state once a second read confirms it, since GitHub
reports `BLOCKED` while it is still reconciling a check that has only just gone green. Only a
pull request GitHub has said nothing decisive about -- still `OPEN`, not merged, in a merge
state that neither proves nor reopens the question (`CLEAN` usually, `UNKNOWN` and the rest the
same way) -- reaches the bound, and the reason it records then says exactly that rather than
guessing at a cause.

It reports the reading as well as the result. `waited` is measured rather than accumulated from
its own sleeps, and `reads_ok`, `read_failures` and `read_error` travel beside it. If every read
after the first fails, `settle` refuses with gh's own words instead of answering `open`: "nothing
was reported against it" would be a statement about a silence, which is the one thing nothing in
this plugin does.

That bound is 90 seconds, and it is the one guess in the script that decides an outcome rather
than sizing a bound. It is deliberately not scaled
from `SHEPHERD_CI_SECONDS`: that number is the measured median of the repository's own workflow
runs, and what `settle` waits on is GitHub's auto-merge latency after the checks are already
green. Measuring that latency properly is future work; the constant is what stands in until
field tests say whether it ever decides an outcome.

The orchestrator makes one more read before printing. A `blocked` entry with a `CLEAN` or
`UNKNOWN` merge state and auto-merge on is the signature of the same race, so it runs `merged`
once and reclassifies. A `blocked` entry that names a cause is left alone: GitHub decided it,
not the clock.

### What it never does

Merge by hand, enable or disable auto-merge, bypass or re-run a required check, edit labels,
resolve conflicts on a human's branch, force-push, or commit with `--no-verify`.

### Commands

The deterministic parts are two commands; the agent only decides between their results.

```bash
node <plugin>/bin/gh.ts shepherd-status <path>               # the work list, as JSON
node <plugin>/bin/gh.ts shepherd-pr <path> <n> state|rebase|recreate|wait|settle|merged
node <plugin>/bin/gh.ts shepherd-pr <path> <n> skip <reason-file>
```

`shepherd-status` changes nothing. `shepherd-pr` writes only through `rebase` (the branch update),
`recreate` and `skip` (one comment each), and refuses each of those when its precondition does
not hold: a pull request that is not open, a `recreate` on a branch Dependabot did not author, a
`skip` with an empty reason. Every action prints one JSON object with `ok` and `detail`, and
exits 0 whether or not it acted, so a refusal is data for the agent rather than a crash.
`recreate` also re-reads the pull request on every poll: a moved head is `recreated`; a pull
request closed or merged with its head unmoved returns early with `ok: true` and
`result: "closed"` or `"merged"` rather than waiting out the bound; and a poll that cannot read
the pull request is counted, not mistaken for "the head did not move". If no poll succeeded the
detail says so and carries gh's last error. `recreate` is for Dependabot's own pull requests:
the summary's `is_bot` says whether any bot opened it, and `is_dependabot` is what the refusal
turns on, because `@dependabot recreate` on a renovate branch is a comment nothing will answer.

Nothing here reports a silence as a fact. A read gh could not answer carries gh's own words, an
answer missing a field the loop decides from is refused rather than shaped into a pull request
with no checks, and a `wait` whose watcher failed for a reason of its own is `ok: false` rather
than `pending` -- reported as pending, an expired token is waited out one CI cycle at a time
forever. `rebase` reports gh's output and says when the head has not moved, since
`gh pr update-branch` returns as soon as GitHub accepts the request and prints the same line
when the branch was already current. A failed `wait` carries `log_tail`, and `log_error` beside
it when gh would not hand the log over, so an empty tail is not mistaken for a job that printed
nothing.

`settle` writes nothing at all: it is reads and a sleep. It refuses a pull request that is
closed, one without auto-merge, or one whose checks are neither `passed` nor absent, rather than
waiting out a bound on a question nobody asked; a pull request that has already merged is
answered rather than refused, since that is the answer `settle` is asked for.

Environment knobs (`SHEPHERD_CI_SECONDS`, `SHEPHERD_WAIT_BOUND`, `SHEPHERD_POLL_SECONDS`,
`SHEPHERD_LOG_LINES`, `SHEPHERD_SETTLE_BOUND`, `SHEPHERD_SETTLE_POLL`) are listed by
`node <plugin>/bin/gh.ts shepherd-pr --help`.

Repository discovery is shared with `/gh:sync`: both skills resolve their scope by the same
rule, and `node <plugin>/bin/gh.ts discover <path>` is that rule on its own, one checkout root
per line.

## Session start hook

On session start only (not on resume, `/clear`, or compaction) the plugin runs a **report-only**
check and, if there is anything worth acting on, asks whether to run `/gh:sync`.

- Outside a git repository it runs the fan-out check in `--dry-run` and reports the findings.
- Inside a git repository, if HEAD is not on the default branch, it says so. This branch is
  purely local and does not hit the network.
- Otherwise it stays silent.

The whole hook is `hooks/hook-io.ts`, run as `hook-io.ts session-start`: it reads the payload,
picks the branch the payload's directory calls for, and writes the response. Its `cwd`, `branch`
and `report` subcommands are the pieces that decision is built from, kept as seams for the tests
and for debugging the hook by hand.

The hook never changes a branch, worktree, or working tree, and every path through
`session-start` exits 0, so it cannot block a session from starting or surprise you with a change
you did not ask for. `hooks.json` wraps it in `command -v node ... ; exit 0`, which holds that
guarantee even for the cases the file is never reached in at all: no node on PATH, or a hooks
directory this file was never installed into. A node below the floor is the same silence: the
hook checks the running version first and exits 0 without writing anything, because a hook that
explains itself on stderr writes into the session. In fan-out mode it does fetch, which updates
remote-tracking refs, and that is one network round trip per repository against the hook's 60
second budget; the fan-out is stopped at 50 seconds so there is time left to report that it ran
out. A degraded run (a missing `bin/gh.ts`, no git on PATH, a fan-out that failed or timed out)
leaves a line on stderr for `claude --debug`, and says so in the session only when there is
something to act on.

## Credentials

These commands shell out to `gh` and `git` and inherit the environment of the directory they
were invoked from. If you use a per-directory credential switcher such as `direnv` to select a
GitHub account (`GH_CONFIG_DIR`), run the command from inside the tree it applies to, so the
right account is active.

One consequence of the non-recursive scope: a directory whose immediate children are themselves
directories *of* repositories, rather than repositories, is a no-op. That is deliberate. Such a
tree usually spans several accounts, and one pass over it would use the wrong credentials for
all but one.

## Running outside Claude Code

The commands have no dependency on the plugin runtime:

From an installed copy of the plugin, `<plugin>` below is the plugin's own directory; inside
Claude Code the skills use `${CLAUDE_PLUGIN_ROOT}` for it.

```bash
node <plugin>/bin/gh.ts sync --dry-run /path/to/a/directory-of-repos
node <plugin>/bin/gh.ts sync-repo --dry-run /path/to/a/repo
node <plugin>/bin/gh.ts discover /path/to/a/directory-of-repos
node <plugin>/bin/gh.ts shepherd-status /path/to/a/repo
node <plugin>/bin/gh.ts shepherd-pr /path/to/a/repo 12 state
```

`node <plugin>/bin/gh.ts` with no command prints the list, and each command prints its own usage
for `--help`.

Everything in this plugin is TypeScript, run directly by node with no build step, and it needs
**node 22.18 or newer**: that is the release whose type stripping runs a `.ts` file as it stands.
The plugin takes no dependency of its own and carries no `package.json`, so nothing is installed
to use it. Every entry point checks the running version before it loads anything else; the
session-start hook does it in silence, and a command says which version it found.

## Tests

The tests for this plugin live beside the code, as `src/**/*.test.ts`, in the repository that
owns it, `bje-settings/claude`. They are not distributed: a read-only copy of this directory
carries the code and not the tests or their fixtures. If you are reading this in such a copy,
`UPSTREAM.json` beside this file names the source repository and the commit the copy was taken
from.

Because these skills delete branches and remove worktrees, their behaviour is asserted against
real git repositories rather than mocks. Covered in particular: every path that can delete
something (each merge signal, a reused branch name, a fork's pull request, a pull request merged
into another base, worktrees clean and dirty), every preflight refusal, and the guarantee that
`--dry-run` changes nothing it says it would change. Every command is asserted against the report
its predecessor printed, captured scenario by scenario before that version was deleted, and the
session-start hook's response is compared byte for byte: it is a JSON document Claude Code
parses, so its shape is a contract and not a rendering.

pnpm's install path has a test that runs a real `pnpm install`. The uncovered remainder is
defensive branches guarding states that cannot be provoked, such as a ref that resolves during
enumeration and fails immediately after.
