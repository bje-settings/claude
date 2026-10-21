# gh

GitHub and git workflow skills: keep checkouts current, and file, link and
triage issues.

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
