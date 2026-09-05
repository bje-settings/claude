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

### Plugin design

Every plugin should be as efficient as possible. Not everything should be a skill, a command, a
workflow, or a hook. Pick the mechanism that fits the job. If a plugin evolves far enough that the
right mechanism changes, raise it during planning or review rather than leaving the original
choice in place.

Not everything should run through an agent or need model context. Anything deterministic enough
belongs in a script: it is more consistent, cheaper, and testable, and it lets a smaller model
handle the parts that still need one. Split work so a script does the deterministic part and
emits structured output, and an agent makes decisions based on that output.

Testing is critical for anything built here, and scripts are what make determinism provable.
Build fixtures from real use cases seen in field tests wherever possible. Do not leak specifics
from field tests on repos outside the `bje` enterprise into this repo; reconstruct the shape of
the case instead.

### Tests

Specs are shellspec, under `spec/<plugin>/`; fixtures under `fixtures/<plugin>/`. Run everything
with `spec/run.sh`, which lints and then runs the suite under both bash 5 and bash 3.2.

CI runs shellcheck, the suite on both shells, and a coverage job that fails below 95%, which is
the enterprise Code Coverage ruleset's threshold. Coverage uses `kcov`, pinned to `ubuntu-22.04`:
newer kcov builds break shellspec, and the alternative, bashcov, prevents shellspec running at
all. Re-test before changing either.

The threshold is enforced by `spec/coverage-check.py`, not shellspec's `--fail-low-coverage`,
which reports a failure at any coverage level once enabled. Reproduce a CI coverage run with
`spec/run.sh --coverage`.

Any script that can delete or overwrite something needs a spec proving both that it acts when it
should and that it refuses when it should. Assert against real repositories built by the fixtures
rather than mocking git; see `fixtures/gh/README.md`. When a fixture makes a claim about the state
it produces, assert that claim in `spec/gh/fixtures_spec.sh` too, so the other specs cannot pass
for the wrong reason.

## Rules and settings syncing (future)

Not yet implemented. When added, this section should describe how `.claude/rules/` and
`settings.json` get shared into other `@bje` repos.

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.
