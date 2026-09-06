# gh

GitHub and git workflow skills for the `bje` enterprise.

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
4. Dependency install, but only if the pull actually changed a lock file. Detected from
   `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`, and run with pnpm, Yarn Berry, or
   npm respectively. Yarn 1 and bun are deliberately out of scope: a repo on either gets the
   lock-file notice and installs by hand.
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
| Conflicts, Dependabot branch | Comment `@dependabot recreate`, wait for the head to move, then wait for CI. If the target was superseded by another pull request that already shipped the same or a newer version, Dependabot closes it instead of moving the head; `recreate` returns early and it is reported as closed, not blocked. |
| Conflicts, human branch | Reported as needing escalation. Never resolved by the skill. |
| Checks running | Wait one CI cycle: `gh pr checks --watch --fail-fast`, bounded by twice the repo's median run time, at most nine minutes per call. |
| Checks green, auto-merge fired | Recorded with the merge commit. Next. |
| Checks green, still open | Reported as blocked with the merge state (a review requirement, for instance). Never merged by hand. |
| Checks failed, mechanical | Fixed once in a throwaway worktree and pushed: a lockfile to regenerate, a formatter, a pin that must move in step, a snapshot whose diff is only the dependency's own output. A second failure is a skip. |
| Checks failed, not mechanical | Skipped with a comment saying why: anything touching program logic, tests' expectations of behaviour, configuration semantics, or a CI workflow. |
| Checks failed, unclear | Reported as needing escalation. |

`@dependabot recreate` re-resolves the version instead of reusing the original bump, so a pull
request opened as `x.y.z → x.y.z+1` can merge as `x.y.z → x.y.z+2` if a newer release landed
while it waited; expected Dependabot behaviour, and the report says so when it happens.

The report ends with an offer to rerun the escalated pull requests with a larger model. The
default worker is Sonnet at medium effort, since rebasing, reading a check, and classifying a
failure are small-model work; cost scales with the rare hard case rather than the common easy one.

### Waiting

The wait is a blocking `gh pr checks --watch`, run inside the per-repo subagent, once per CI
cycle. It is deliberately not a Monitor or a scheduled wake: those idle the worker and leave the
orchestrator seeing only "waiting". The bound comes from the median duration of the last twenty
completed runs on the default branch, doubled, clamped to two to nine minutes; a wait that hits
its bound returns `pending` and the agent calls it again. A rollup that is already terminal is
answered from the pull request without watching at all.

### What it never does

Merge by hand, enable or disable auto-merge, bypass or re-run a required check, edit labels,
resolve conflicts on a human's branch, force-push, or commit with `--no-verify`.

### Scripts

The deterministic parts are two scripts; the agent only decides between their results.

```bash
plugins/gh/scripts/gh-shepherd-status.sh <path>                       # the work list, as JSON
plugins/gh/scripts/gh-shepherd-pr.sh <path> <n> state|rebase|recreate|wait|merged
plugins/gh/scripts/gh-shepherd-pr.sh <path> <n> skip <reason-file>
```

`status` changes nothing. `gh-shepherd-pr.sh` writes only through `rebase` (the branch update),
`recreate` and `skip` (one comment each), and refuses each of those when its precondition does
not hold: a pull request that is not open, a `recreate` on a branch Dependabot did not author, a
`skip` with an empty reason. Every action prints one JSON object with `ok` and `detail`, and
exits 0 whether or not it acted, so a refusal is data for the agent rather than a crash.
`recreate` also re-reads the pull request's state on every poll: if Dependabot closes or merges
it instead of moving the head, it returns early with `ok: true` and `result: "closed"` or
`"merged"`, rather than waiting out the rest of the bound.
Environment knobs (`SHEPHERD_CI_SECONDS`, `SHEPHERD_WAIT_BOUND`, `SHEPHERD_POLL_SECONDS`,
`SHEPHERD_LOG_LINES`) are documented at the top of the script.

Repository discovery is shared with `/gh:sync` through `scripts/lib/discover.sh`.

## Session start hook

On session start only (not on resume, `/clear`, or compaction) the plugin runs a **report-only**
check and, if there is anything worth acting on, asks whether to run `/gh:sync`.

- Outside a git repository it runs the fan-out check in `--dry-run` and reports the findings.
- Inside a git repository, if HEAD is not on the default branch, it says so. This branch is
  purely local and does not hit the network.
- Otherwise it stays silent.

JSON on both ends (reading the payload, writing the response) is handled by `hooks/hook-io.py`,
which also holds the message text. Doing that inline with `python3 -c` buried it in quoted
heredocs inside the shell, where it could not be linted or tested.

The hook never changes a branch, worktree, or working tree, and always exits 0, so it cannot
block a session from starting or surprise you with a change you did not ask for. In fan-out mode
it does fetch, which updates remote-tracking refs, and that is one network round trip per
repository against the hook's 60 second budget.

## Credentials

`direnv` sets `GH_CONFIG_DIR` per directory, and these scripts inherit the environment of the
directory they were invoked from. Run the command from inside the org tree you are targeting so
the correct GitHub account is active. This is also why `~/Code/@bje/` itself is a no-op: its
immediate children are org directories rather than repositories, and an enterprise-wide sync
would need different credentials per org anyway.

## Running outside Claude Code

The scripts are plain bash with no dependency on the plugin runtime:

```bash
plugins/gh/scripts/gh-sync.sh --dry-run ~/Code/@bje/@bje-settings
plugins/gh/scripts/gh-sync-repo.sh --dry-run ~/Code/@bje/@bje-settings/terraform
plugins/gh/scripts/gh-shepherd-status.sh ~/Code/@bje/@bje-settings/terraform
plugins/gh/scripts/gh-shepherd-pr.sh ~/Code/@bje/@bje-settings/terraform 12 state
```

They are written for bash 3.2, the version macOS ships at `/bin/bash`.

## Tests

Because this skill deletes branches and removes worktrees, its behaviour is asserted against
real git repositories rather than mocks. Specs live in `spec/gh/`, fixtures in `fixtures/gh/`.

```bash
spec/run.sh              # lint, then the suite under bash 5 and bash 3.2
spec/run.sh --quick      # the suite once, under the default shell
```

The suite runs under both shells deliberately: bash 5 is what most contributors have on `PATH`,
but `/bin/bash` is 3.2 on macOS and is what actually executes these scripts.

CI adds a coverage job (`kcov`, measured over `plugins/gh` only) which fails below 95%, enforced
by `spec/coverage-check.py`. Run it locally with `spec/run.sh --coverage`, which needs kcov.
All three supported package managers have an install spec. The uncovered remainder is defensive branches
guarding states that cannot be provoked, such as a ref that resolves during enumeration and fails
immediately after.

Covered in particular: every path that can delete something (each merge signal, a reused branch
name, a fork's pull request, a pull request merged into another base, worktrees clean and dirty),
every preflight refusal, and the guarantee that `--dry-run` changes nothing it says it would
change. See `fixtures/gh/README.md` for how to build a scenario.
