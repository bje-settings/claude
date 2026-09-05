# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`gh`](plugins/gh) | Git and GitHub workflow skills. `/gh:sync` moves a checkout to its default branch, fast-forwards it, and prunes branches and worktrees whose work has already landed, for one repo or every repo one level down. `/gh:shepherd` merges a repo's auto-merge-enabled `dependencies` PRs one at a time, rebasing and waiting on CI between merges. |

## Tests

```bash
spec/run.sh
```

Specs live in `spec/`, fixtures in `fixtures/<plugin>/`. See `fixtures/gh/README.md`.
Requires `shellspec` and `jq`; `shellcheck` is used if present.

## Local install

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
```
