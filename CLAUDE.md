# claude

Claude Code configuration for the `bje` enterprise: a plugin marketplace today, and eventually a
place to sync Claude rules and settings to other `@bje` repos.

## Plugin marketplace

`.claude-plugin/marketplace.json` is the marketplace manifest (`name: "bje"`). Plugins live under
`plugins/<plugin-name>/`, each with its own `.claude-plugin/plugin.json`, and are registered as
entries in the marketplace manifest's `plugins` array. See
[plugin-marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces.md) and
[plugins-reference docs](https://code.claude.com/docs/en/plugins-reference.md).

Test locally with `/plugin marketplace add ./path/to/this/repo`, then
`/plugin install <plugin-name>@bje`.

### Plugins

Plugins are listed in `README.md`; each has its own README.

New `gh` commands belong in the `gh` plugin, which is the intended home for the ones still in
`~/Code/@brianespinosa/dotfiles/.claude/commands/gh/` (`rebase-prs`, `security-alerts`,
`tidy-user-notifications`).

Plugin scripts must run under bash 3.2, which is what macOS ships at `/bin/bash`. No associative
arrays, no `wait -n` without a fallback.

## Rules and settings syncing (future)

Not yet implemented. When added, this section should describe how `.claude/rules/` and
`settings.json` get shared into other `@bje` repos.

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.
