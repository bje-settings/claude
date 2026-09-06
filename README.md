# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

Each plugin is one domain of work and is installed on its own. The lists below are an index;
the plugin's own README has the detail, including the scripts the skills and hooks run.

### [`gh`](plugins/gh)

> Git and GitHub workflow.

| | |
| --- | --- |
| **Skills** | <ul><li>[`/gh:sync`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghsync): move a checkout to its default branch, fast-forward it, and prune branches and worktrees whose work has landed. _Scope: `cwd` can be a single repo or a directory of repo subdirs._</li><li>[`/gh:shepherd`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd): merge auto-merge-enabled `dependencies` PRs one at a time, rebasing and waiting on CI between merges. _Scope: `cwd` can be a single repo or a directory of repo subdirs._</li></ul> |
| **Agents** | <ul><li>[`shepherd-repo`](https://github.com/bje-settings/claude/tree/main/plugins/gh#ghshepherd): shepherds one repository serially; dispatched by `/gh:shepherd`, one per repo in parallel.</li></ul> |
| **Hooks** | <ul><li>[Session start](https://github.com/bje-settings/claude/tree/main/plugins/gh#session-start-hook): report-only check on startup that offers `/gh:sync` when there is something to act on. Never changes a branch, worktree, or working tree.</li></ul> |

### [`workstreams`](plugins/workstreams)

> Issue orchestration: a set of GitHub issues becomes parallel streams run by subagents, each
> ending in a reviewed draft PR. Requires `gh-stack` and `pr-review-toolkit`; see
> [Requirements](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#requirements).

| | |
| --- | --- |
| **Skills** | <ul><li>[`/workstreams:plan`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsplan-selectors): resolve issue selectors, classify each issue as work now, defer, or blocked, group overlapping files into stacks, size each stream, and record the approved plan. Starts nothing.</li><li>[`/workstreams:run`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): start one subagent per planned stream, check progress on a self-timed cadence, review every draft until a pass applies nothing, and report. PRs stay drafts.</li></ul> |
| **Agents** | <ul><li>[`stream-low`, `stream-medium`, `stream-high`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): work one stream through to a draft PR at the effort the plan sized it; dispatched by `/workstreams:run`.</li><li>[`reviewer`](https://github.com/bje-settings/claude/tree/main/plugins/workstreams#workstreamsrun): reviews one draft PR with `pr-review-toolkit`, applies the findings that hold, and refreshes a stale title or body.</li></ul> |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for running the tests and installing the marketplace locally.
