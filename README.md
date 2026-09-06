# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

Each plugin is one domain of work and is installed on its own. The lists below are an index;
the plugin's own README has the detail.

### [`gh`](plugins/gh)

Git and GitHub workflow.

Skills

- [`/gh:sync`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghsync): move a checkout to its default branch, fast-forward it, and prune branches and worktrees whose work has landed, for one repo or every repo one level down.
- [`/gh:shepherd`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd): merge a repo's auto-merge-enabled `dependencies` PRs one at a time, rebasing and waiting on CI between merges.

Agents

- [`shepherd-repo`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd): shepherds one repository serially; dispatched by `/gh:shepherd`, one per repo in parallel.

Hooks

- [Session start](https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook): report-only check on startup that offers `/gh:sync` when there is something to act on. Never changes a branch, worktree, or working tree.

Scripts

- [`gh-sync.sh`, `gh-sync-repo.sh`](https://github.com/bje-settings/claude/tree/main/plugins/gh#running-outside-claude-code): the deterministic half of `/gh:sync`, runnable without Claude Code.
- [`gh-shepherd-status.sh`, `gh-shepherd-pr.sh`](https://github.com/bje-settings/claude/tree/main/plugins/gh#scripts): the work list and the per-PR steps behind `/gh:shepherd`; the agent only decides between their results.
- [`lib/discover.sh`](https://github.com/bje-settings/claude/tree/main/plugins/gh#scripts): repository discovery shared by both skills.

### [`workstreams`](plugins/workstreams)

Issue orchestration: a set of GitHub issues becomes parallel streams run by subagents, each
ending in a reviewed draft PR. Requires `gh-stack` and `pr-review-toolkit`; see
[Requirements](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#requirements).

Skills

- [`/workstreams:plan`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsplan-selectors): resolve issue selectors, classify each issue as work now, defer, or blocked, group overlapping files into stacks, size each stream, and record the approved plan. Starts nothing.
- [`/workstreams:run`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): start one subagent per planned stream, check progress on a self-timed cadence, review every draft until a pass applies nothing, and report. PRs stay drafts.

Agents

- [`stream-low`, `stream-medium`, `stream-high`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): work one stream through to a draft PR at the effort the plan sized it; dispatched by `/workstreams:run`.
- [`reviewer`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): reviews one draft PR with `pr-review-toolkit`, applies the findings that hold, and refreshes a stale title or body.

Scripts

- [`ws-preflight.sh`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#scripts): dependency check with install hints.
- [`ws-issues.sh`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#scripts): selectors to a JSON array of issues.
- [`ws-state.sh`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#scripts): atomic read and write of the per-repo state file that lets a run resume; see [State and resuming](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#state-and-resuming).
- [`ws-pr-status.sh`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#scripts): one PR reduced to draft state, mergeability, folded checks, and review decision.

## Tests

```bash
spec/run.sh
```

Specs live in `spec/`, fixtures in `fixtures/<plugin>/`. See `fixtures/gh/README.md` and `fixtures/workstreams/README.md`.
Requires `shellspec` and `jq`; `shellcheck` is used if present.

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
/plugin install workstreams@bje
```
