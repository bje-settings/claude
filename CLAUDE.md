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

New `gh` skills belong in the `gh` plugin, which is the intended home for the commands still in
`~/Code/@brianespinosa/dotfiles/.claude/commands/gh/` (`rebase-prs`, `security-alerts`,
`tidy-user-notifications`).

Plugin scripts must run under bash 3.2, which is what macOS ships at `/bin/bash`. No associative
arrays, no `wait -n` without a fallback.

### Plugin domains

Plugins are the unit of installation, so each plugin is one domain of work (`gh` is GitHub and
git workflow). Users and repos install only the domains they need, and a skill lands in the plugin
whose domain it belongs to, never in a catch-all plugin.

When adding a skill, name the domain it belongs to before writing it. If no existing plugin fits,
or a plugin has accumulated skills that split along a natural seam, raise it during planning and
propose the new domain (or split) with a name and a one-line scope. Domains are expected to
emerge and change as the marketplace grows; it is fine to start a plugin with a single skill.

Signals that a domain boundary is off:

- A user who wants one skill would have to install several unrelated ones to get it.
- A skill's description leads with a tool or system that no other skill in the plugin touches.
- Two plugins would each want the same skill.

Moving a skill between plugins changes its `/plugin:skill` name, so settle the domain before the
skill ships rather than after.

### Plugin design

Pick the mechanism by the decision rule in the
[extension overview](https://code.claude.com/docs/en/features-overview#match-features-to-your-goal).
If a plugin grows until the right mechanism changes, raise it during planning or review.

- Hook when the action must happen the same way every time and needs no reasoning. Hooks cost
  zero context unless they return output. Guardrails belong in `PreToolUse` hooks; an instruction
  in CLAUDE.md or a skill is a request, not enforcement.
- Skill when Claude has to decide how to apply the steps, or the content is knowledge.
- Subagent only for context isolation or parallel work.
- Anything deterministic runs in a script, not an agent. Split work so the script emits
  structured output and the agent decides from it. Where an agent is still needed, set `model`
  and `effort` in its frontmatter to the smallest that passes the specs.
- Skills with side effects set `disable-model-invocation: true`. Keep `SKILL.md` under 500 lines;
  reference material goes in supporting files. Put the key use case first in `description`,
  since the listing truncates at 1,536 characters.
- New plugins use `skills/`, not `commands/`. The docs treat `commands/` as the flat legacy form.
- Plugin state lives under `${CLAUDE_PLUGIN_DATA}`. `${CLAUDE_PLUGIN_ROOT}` changes on update.

### Skills

Every skill directory carries a `FLOW.md` beside its `SKILL.md`, holding a mermaid flow diagram.
The diagram stays out of `SKILL.md`, which is loaded on every invocation. Enforced by
`spec/skills_spec.sh` across all plugins; see `.claude/rules/file-skill-md.md`.

### Tests

Specs are shellspec, under `spec/<plugin>/`; fixtures under `fixtures/<plugin>/`. Run everything
with `spec/run.sh`, which lints and then runs the suite under both bash 5 and bash 3.2.

CI runs shellcheck, the suite on both shells, and a coverage job that fails below 95%, which is
the enterprise Code Coverage ruleset's threshold. That number does not mean "tested" where the
logic lives inside a `jq` program; see `.claude/rules/type-sh.md`.

Coverage uses `kcov`, pinned to `ubuntu-22.04`: newer kcov builds break shellspec, and the
alternative, bashcov, prevents shellspec running at all. Re-test before changing either.

The threshold is enforced by `spec/coverage-check.py`, not shellspec's `--fail-low-coverage`,
which reports a failure at any coverage level once enabled. Reproduce a CI coverage run with
`spec/run.sh --coverage`.

Any script that can delete or overwrite something needs a spec proving both that it acts when it
should and that it refuses when it should. Assert against real repositories built by the fixtures
rather than mocking git; see `fixtures/gh/README.md`. When a fixture makes a claim about the state
it produces, assert that claim in `spec/gh/fixtures_spec.sh` too, so the other specs cannot pass
for the wrong reason.

Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
repos outside the `bje` enterprise into this repo; reconstruct the shape of the case instead.

Test the non-deterministic parts too. Run `claude plugin validate --strict` in CI. For a skill or
agent, run realistic prompts in fresh sessions with and without it and compare, or use the
official `skill-creator` plugin for evals.

## Rules and settings syncing (future)

Not yet implemented. When added, this section should describe how `.claude/rules/` and
`settings.json` get shared into other `@bje` repos.

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.
