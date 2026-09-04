# claude

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for the
`bje` enterprise, defined in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`gh`](plugins/gh) | Git and GitHub workflow commands. `/gh:sync` moves a checkout to its default branch, fast-forwards it, and prunes branches and worktrees whose work has already landed, for one repo or every repo one level down. |

Add the marketplace locally for testing:

```bash
/plugin marketplace add ./path/to/this/repo
/plugin install gh@bje
```
