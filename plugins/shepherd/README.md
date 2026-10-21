# shepherd

Pull request merges: merge auto-merge pull requests and GitHub stacks one at a time, and wait on
CI between merges.

## `/shepherd:merge`

Merges every open, non-draft pull request that has auto-merge set, one at a time. An optional
argument narrows this to one label. It rebases each one if it is behind. It waits on CI once per
cycle. It resolves conflicts by merging the base branch into the pull request, and fixes the
failures that the base caused, on any pull request whether a human or a bot authored it.
Auto-merge does the actual merge. The skill only gets each pull request to green, and confirms
it landed before it starts the next one.

It also merges each GitHub stack once every layer is ready (#469). GitHub refuses auto-merge on a
stacked pull request, so a stack merges with `gh stack merge` instead. That is the skill's one
merge. GitHub applies the rules of the base to it, all layers or none.

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

A stack is one target, after the pull requests. Its layers are its open pull requests, bottom
first. A merged entry is no layer. A layer of a stack is never a pull request target too. Every
layer is judged by the rules of the stack base, as GitHub merges it, not by the rules of its own
base. A stack is not ready, and goes to `not_ready` with each layer and reason, when a layer "is
a draft", an entry "is closed", a required check of the stack base failed, or a layer "needs an
approval" or "has unresolved review threads". `--all` drops the last two from the targets, but
`shepherd-stack state` and `merge` keep them, because GitHub refuses such a merge. A required
check that is still pending, or has not reported, is no reason: `shepherd-stack wait` waits for
it. With a label, a stack is a target when one of its open layers carries it.

### Flags

| Flag | Effect |
| --- | --- |
| `<label>` | Shepherd only pull requests that carry this one label. |
| `--all` | Shepherd every auto-merge pull request, also one that the review rules of its base leave out. |
| `--dry-run` | Print each repository's target list, in order, stacks included, then its `not_ready` list, and stop. Nothing is rebased or waited for. |

### The loop, per pull request

| State | Action |
| --- | --- |
| Head out of sync with its branch | `state` reports `inSync` false: GitHub still names an older commit than the one the branch points at. A rebase cannot move such a head. Skipped, with both SHAs, before any rebase or wait. |
| Not ready, without `--all` | `state` reports `approval` `missing` or `threads` `unresolved`. A review can be dismissed during a run. Skipped, with "needs an approval" or "has unresolved review threads", before any rebase or wait. |
| Behind its base | `gh pr update-branch --rebase`, no checkout. Read the pull request every 5 seconds until the head moves, for at most 60 seconds. Then wait. GitHub's compare of the base and the head decides "behind". `mergeStateStatus` does not, because it reads `BLOCKED` while a check is pending. A head that is behind is rebased before any wait. When the compare cannot be read, `mergeStateStatus` decides. |
| Conflicts | In a throwaway worktree, `git merge origin/<base>` into the head branch, for any author. Regenerate a lockfile with the repository's own package manager. Keep the keys of both sides in a manifest. Keep both intents in code. Verify locally, commit, and run a plain `git push`. Then wait for CI. Never rebase, and never force-push. |
| Checks in progress | Wait one CI cycle: read the pull request and the compare every 30 seconds. The bound is twice the repo's median run time, at most nine minutes per call. A base that moves during the wait ends it at the next poll, and the head is rebased. While a check starts or finishes, the agent calls `wait` again, however many calls that takes. |
| Checks stalled | `wait` returns `stalled` when no check, job or step started or finished for the stall bound: the largest of 27 minutes, twice the repo's median run time, and the run's own time from its first check stamp to its newest. A poll whose jobs read missed steps gets twice that bound. Skipped ("checks made no progress"), with the progress `wait` read. |
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
comes from `ci_seconds`. `shepherd-status` reads the last 100 completed runs on the default
branch, keeps the longest run of each head commit, and takes the median over the heads (#463).
One push starts several workflows, so a short workflow beside a long CI does not make the median
short. The bound is that median doubled, then clamped to two to nine minutes. A wait that hits
its bound returns `pending`, and the agent calls it again. When a rollup is already terminal,
the skill answers from the first read, with no poll at all.

`wait` decides when the checks stall, not the agent (#466). GitHub puts a `startedAt` and a
`completedAt` on each check, and gh gives a status a `startedAt` too. For each Actions run with a
pending check, `wait` also reads every page of the jobs of the run, up to 20 pages, with the same
two stamps on each job and each step. `wait` compares the newest stamp with the wall clock. When
no check, job or step started or finished for the stall bound, it returns `stalled`. The bound is
the largest of three values: 27 minutes (`SHEPHERD_STALL_FLOOR`, three nine-minute waits), twice
the CI median, and the run's own time from its first stamp to its newest. So a run that made progress for twenty minutes may sit still for twenty. The stamps
of one job do not move until it finishes, but its steps do. So one long job is progress while its
steps finish. A median that is too small cannot make the bound smaller than the other two values. A
poll whose jobs read fails, in full or in part, gets twice the bound (#476). The steps it missed
may have moved. Its `stall_bound` shows the doubled value, and stderr says why the read
failed. A rollup with no stamp at all is measured from the newer of the head commit's date
and the pull request's last update. So a check that never starts still ends in `stalled`, and a
commit made long before its push does not stall at once. Each call decides from what it reads. The
agent counts no `pending` result. `pending` and `stalled` carry `progress`: the checks finished, the
first and newest stamps, `idle`, `stall_bound`, and `source` (`checks` or `head commit`).

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

### A stack, step by step

`shepherd-stack` runs `state`, `update` and `wait` on each open layer, bottom first. Each layer
is a `shepherd-pr` step. `merge` is one `gh stack merge` for the whole stack.

| Step | What it does |
| --- | --- |
| `state` | Each layer as `shepherd-pr state` reads it, by the rules of the stack base, with its reasons. `ready` is true when no layer has one. |
| `update` | Merges the base into each layer that is behind, with `gh pr update-branch` in MERGE mode, and reads until the head moves. A conflict goes to the agent, which resolves it with a plain push. |
| `wait` | `shepherd-pr wait` on each layer, in one bound for the stack. A required check of the base with no row on a layer is pending. The first layer that does not pass decides. |
| `merge` | Refuses unless every layer is ready, current and green. Then `gh stack merge <stack> --yes`, with squash, else merge, else rebase: the first that the repository and the rules of the base allow. A refusal by GitHub comes back in gh's own words. |

No step force pushes. A probe on #469 showed that GitHub merges a stack whose layers took the base
by a merge commit. `gh stack rebase`, `push` and `sync` each force push, so nothing here runs
them.

### What it never does

Never:
- merge by hand, except a stack with `shepherd-stack merge`
- enable or disable auto-merge
- bypass or re-run a required check
- edit labels
- force-push, a stack included
- commit with `--no-verify`

### Commands

The deterministic parts are three commands, and `discover` (below). The agent only decides
between their results. `<plugin>` below is the plugin's own directory. Inside Claude Code, the
skill and the agent use `${CLAUDE_PLUGIN_ROOT}` for it.

```bash
node <plugin>/scripts/shepherd.ts shepherd-status <path> [label] [--all]   # the work list, as JSON
node <plugin>/scripts/shepherd.ts shepherd-pr <path> <n> state|rebase|wait|settle|merged
node <plugin>/scripts/shepherd.ts shepherd-stack <path> <stack> state|update|wait|merge
```

`shepherd-status` changes nothing. It prints `targets` and `not_ready`. Each target carries
`approval` (`met`, `missing`, `not_required`, or `null`) and `threads` (`resolved`, `unresolved`,
`not_required`, or `null`). `shepherd-pr` writes only through one action: `rebase` (the branch
update). It refuses that when its precondition does not hold: the pull request is not open.
`state` reads the review rules of the base, and reports `approval` and `threads` the same way.
It also reads the ref of the head branch, for a pull request that is not from a fork. It reports
the ref's commit as `branchRefOid`, and `inSync`: false when that commit is not `headRefOid`.
Both are `null` for a fork, and for a ref it could not read (stderr says why).
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

`shepherd-stack` prints one JSON object per action too, with `stack` in place of `number`. A
read that fails never decides a verdict: it gives `ok: false`, or `result` `unread` from
`merge`. `merge` gives `merged`, `accepted` (GitHub took the merge, and a layer is not
merged yet), `refused` with gh's `reason` (or why gh could not run or was killed), or
`not_ready` with each layer and reason. A `not_ready` with an empty `failing` is a base that
allows no merge method, and `detail` says so.
`node <plugin>/scripts/shepherd.ts shepherd-stack --help` has the whole contract.

`node <plugin>/scripts/shepherd.ts shepherd-pr --help` lists the environment knobs
(`SHEPHERD_CI_SECONDS`, `SHEPHERD_WAIT_BOUND`, `SHEPHERD_WAIT_POLL`, `SHEPHERD_STALL_FLOOR`,
`SHEPHERD_LOG_LINES`, `SHEPHERD_SETTLE_BOUND`, `SHEPHERD_SETTLE_POLL`, `SHEPHERD_REBASE_BOUND`,
`SHEPHERD_REBASE_POLL`).

Repository discovery is shared with `/gh:sync`. Both skills resolve their scope by the same rule,
`lib/discover.ts` in the marketplace repository, and each plugin holds a copy of it.
`node <plugin>/scripts/shepherd.ts discover <path>` is that rule on its own, one checkout root per
line. A directory with no checkouts in it prints nothing, and exits **0**. That is an answer, not
a failure. Exit **1** means the command could not read the target at all, or git itself could not
run. Either way, the reason is on stderr. Exit **2** means the command refused the arguments.
The gh plugin's `sync` answers 2 where `discover` answers 1 on the same states. So a skill that runs both must
read each status against its own command.

## Session start hook

When a session starts, resumes, clears, or compacts, the hook checks that git, the GitHub CLI and
the `gh stack` extension are present. When all three are present, it writes nothing.

When git or gh is not on `PATH`, each one gets a line of its own. `additionalContext` says that
the plugin cannot run:

```
shepherd: ⚠️ git not found on PATH
shepherd: ⚠️ GitHub CLI (gh) not found on PATH
```

`shepherd-stack merge` runs `gh stack merge`, so a stack needs the extension
(`gh extension install github/gh-stack`). The hook reads gh's own extension directory, not
`PATH`: `extensions/gh-stack` under `$XDG_DATA_HOME/gh`, or `%LOCALAPPDATA%\GitHub CLI` on
Windows, or `~/.local/share/gh`. That is the order gh uses. When the extension is absent,
`additionalContext` says that `/shepherd:merge` cannot merge a stack:

```
shepherd: ⚠️ gh stack extension not found
```

The extension read needs neither git nor gh, so a tool problem does not hide it (#480). The tool
lines come first, then the extension line, and `additionalContext` carries both sentences:

```
shepherd: ⚠️ git not found on PATH
shepherd: ⚠️ gh stack extension not found
```

A read that does not finish within 2.5 seconds gives `could not be checked` in place of
`not found`, and adds no sentence to `additionalContext`. An environment with no home directory gives the same
line for the extension. The hook always exits 0. The same reason also goes to stderr, one line
for each item. The hook is `hooks/session-start.ts`.
