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
`/plugin install <plugin-name>@bje`. That path is the only local one that works here: an
install with `claude --plugin-dir`, from a local path, or from a `command` source in copy
mode keeps only the symlinks resolving inside the plugin's own directory, so a plugin's
`src/lib` is dropped and its commands fail at import.

### Plugins

Plugins are listed in `README.md`; each has its own README. New `gh` skills belong in the `gh`
plugin, and repo discovery shared by its skills is `plugins/gh/src/discover.ts`, reachable from a
skill as `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" discover <path>`. A new skill about auditing
a repository's context files for rot belongs in the `audit` plugin.

Plugin code is TypeScript, run directly by node on a 22.18 floor; `.claude/rules/type-ts.md`
has the rules. A command is an exported function at `plugins/<plugin>/src/commands/<command>.ts`
behind one thin dispatcher at `plugins/<plugin>/scripts/<plugin>.ts`, a hook goes at
`plugins/<plugin>/hooks/*.ts`, and code shared between plugins is the root `lib/`, reached through
the committed symlink `plugins/<plugin>/src/lib -> ../../../lib`, the only path out of a plugin.

Nothing under `plugins/` is bash, a plugin takes no dependency and carries no `package.json`, and
a command's exit codes and stdout are a contract with its callers.

Cross-plugin dependencies, declared through a preflight script rather than vendored:

- `workstreams` depends on `gh` and the `gh stack` extension, through
  `plugins/workstreams/src/commands/preflight.ts`. A new cross-plugin dependency is a row in its
  `REQUIRED_PLUGINS` table, or `OPTIONAL_PLUGINS` when a skill works around its absence, never a
  vendored copy.

### Plugin domains

Plugins are the unit of installation, so each plugin is one domain of work (`gh` is GitHub and
git workflow). Users and repos install only the domains they need, and a skill lands in the plugin
whose domain it belongs to, never in a catch-all plugin.

- When adding a skill, name the domain it belongs to before writing it.
- If no existing plugin fits, or a plugin has accumulated skills that split along a natural seam,
  raise it during planning and propose the new domain (or split) with a name and a one-line scope.
- Domains are expected to emerge and change as the marketplace grows; it is fine to start a
  plugin with a single skill.
- Moving a skill between plugins changes its `/plugin:skill` name, so settle the domain before the
  skill ships rather than after.

Signals that a domain boundary is off:

- A user who wants one skill would have to install several unrelated ones to get it.
- A skill's description leads with a tool or system that no other skill in the plugin touches.
- Two plugins would each want the same skill.

### Plugin design

Pick the mechanism by the decision rule in the
[extension overview](https://code.claude.com/docs/en/features-overview#match-features-to-your-goal).
If a plugin grows until the right mechanism changes, raise it during planning or review.

- Skills and tools should aim to be as simple as possible.
- Anything getting too complex may need to become modular primitives instead.
- Hook when the action must happen the same way every time and needs no reasoning. Hooks cost
  zero context unless they return output. Guardrails belong in `PreToolUse` hooks; an instruction
  in CLAUDE.md or a skill is a request, not enforcement.
- Skill when Claude has to decide how to apply the steps, or the content is knowledge.
- Subagent only for context isolation or parallel work. A subagent that has to wait on
  something external waits in the foreground with a bounded blocking call and returns once,
  with structured output. It must not arm a Monitor or a scheduled wake and end its turn: that
  idles the worker and the orchestrator sees only "waiting". Wakes belong to the session that
  dispatched it, if anywhere.
- Anything deterministic runs in a script, not an agent. Split work so the script emits
  structured output and the agent decides from it. Where an agent is still needed, set `model`
  and `effort` in its frontmatter to the smallest that passes the specs, unless the caller sizes
  it: `model` can be passed per call, `effort` cannot, so a caller-sized agent (the workstreams
  `stream` agent) leaves both unset and inherits the session's effort.
- A skill that exists to be invoked by another skill or an orchestrator never sets
  `disable-model-invocation: true`: the flag hides it from the `Skill` tool, so its callers
  cannot reach it at all. Use `user-invocable: false` instead when only the model should start
  it; the workstreams primitives are the example, `question`, `stream` and `review` model-only
  and `sweep` open to both. Reserve `disable-model-invocation: true` for a workflow a person
  alone should trigger. Keep `SKILL.md` under 500 lines; reference material goes in supporting
  files. Put the key use case first in `description`, since the listing truncates at 1,536
  characters.
- New plugins use `skills/`, not `commands/`. The docs treat `commands/` as the flat legacy form.
- Plugin state lives under `${CLAUDE_PLUGIN_DATA}`. `${CLAUDE_PLUGIN_ROOT}` changes on update.
- Derive what a plugin needs each time it runs, rather than writing a file to remember it. State
  on disk is a last resort: it is the copy that goes stale. A plugin that must keep state or a
  plan owns its whole lifecycle -- creation, resume, reconcile against the source of truth, and
  archive or removal when finished -- not just the write.
- A plugin works generally, on any machine and any repository layout. Nothing in one may assume
  the author's directory structure, tool setup, or environment beyond what its preflight script
  checks and reports. Paths come from `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and the
  target repository's own conventions; a literal path, or a tool the preflight does not check, is
  a defect.

### Skills

Every skill directory carries a `FLOW.md` beside its `SKILL.md`, holding a mermaid flow diagram.
The diagram stays out of `SKILL.md`, which is loaded on every invocation. Enforced across the
plugins **and** `.claude/skills/` by `tests/skills.test.ts`; see `.claude/rules/file-skill-md.md`.

## Repo tooling: root `scripts/` and `.claude/skills/`

Not everything here is a plugin. A root `scripts/` script, TypeScript, would be this repo's own
tooling, with `.claude/skills/` holding the skill that drives it. Neither would be installed by
anyone, neither would be in the marketplace manifest, and `claude plugin validate` never sees
either; the convention holds them to the same standards anyway, because they can change other
repositories. Neither exists today: #128 deleted the only ones there were, `publish-plugin.py`
and the `/publish` skill.

Two things would differ from a plugin:

- Repo-relative paths are correct in a root script rather than a defect.
- Its tests may drive it in-process.

A repo-local skill is checked by `tests/skills.test.ts`, including the frontmatter that `--strict`
would otherwise have covered.

### Tests

`pnpm test` runs the suite with coverage.

#### Layout and fixtures

- TypeScript tests are co-located at `plugins/<plugin>/src/**/*.test.ts`, with fixtures at
  `src/fixtures/`. The shared harness is `harness/` at the repository root (`harness/README.md`),
  imported only from test files so it never ships; `tests/` holds this repository's own checks.

#### Coverage

- `vitest.config.ts`'s thresholds are the gate, 100 on lines, branches, functions and statements
  over a named source set, with `cobertura` feeding the enterprise Code Coverage ruleset.

#### CI required checks

- `vitest`, `vitest-floor`, `types` and `biome` in `ci.yml`, plus `plugin-validate` in its own
  workflow, are required checks on the default branch, matched by exact string.
- Renaming one silently blocks every pull request forever (the required check never reports
  again) -- put descriptive text in step names instead.
- Adding or removing a required job means updating the branch ruleset in the same pull request:
  add only after the new name has reported on main once; remove before the pull request that
  drops the job merges.
- Manifest validation is its own workflow, `.github/workflows/plugin-validate.yml`, so a bad
  manifest reads as its own check rather than a failure inside `ci.yml`. It runs `claude plugin
  validate --strict` over the marketplace manifest and every directory under `plugins/`, which
  needs no API key or login, on a pinned Claude Code version.

#### Git hooks

- lefthook, staged-only, never a suite (ADR 002).
- `lefthook.yml` holds the steps; `CONTRIBUTING.md` says how they install.
- A worktree without its own `pnpm install` still runs the hooks, borrowed from whichever checkout
  installed them; each pnpm-based step warns and skips until that worktree runs `pnpm install`.

#### Fixture quality

- Any script that can delete or overwrite something needs a test proving both that it acts when
  it should and that it refuses when it should. Assert against real repositories built by the
  fixtures rather than mocking git; `harness/git.ts` builds them.
- When a fixture makes a claim about the state it produces, assert that claim in the fixture's
  own test too (`harness/*.test.ts`), so the other tests cannot pass for the wrong reason.
- Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
  repos outside the `bje` enterprise into this repo; reconstruct the shape of the case instead.
- Test the non-deterministic parts too. For a skill or agent, run realistic prompts in fresh
  sessions with and without it and compare, or use the official `skill-creator` plugin for evals.

## Language server

`.claude/settings.json` enables this marketplace's `typescript7-lsp` and turns
`typescript-lsp@claude-plugins-official` off (#193), so `tsc` and the language server run the same
pinned `node_modules/typescript`.

Otherwise `.claude/settings.json` matches SurveyMonkey/skills' settings: it turns off auto memory
(`autoMemoryEnabled`) and strips the attribution trailer (`attribution`).

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.
`ENTERPRISE_REPO_MIGRATION.md` is symlinked alongside it as `~/Code/@bje/REPO-MIGRATION.md`: the
plan for which `brianespinosa` repos move into which bje org.

## Records

Decisions live in `docs/rfc/` and `docs/adr/`, under `.claude/rules/path-docs.md` and its per-type
rules, with an `index.md` per bundle that a landing PR updates. `docs/rfc/001-typescript-port.md`
is the record for the TypeScript port, with `docs/adr/001-typescript-on-node-22-18.md` (runtime,
shared `lib/`, test seam) and `docs/adr/002-quality-gate-venues.md` (hooks, CI, coverage) behind it.
