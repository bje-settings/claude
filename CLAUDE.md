# claude

Claude Code configuration for the `bje` enterprise. Today it is a plugin marketplace. It will
also sync Claude rules and settings to other `@bje` repos.

## Plugin marketplace

`.claude-plugin/marketplace.json` is the marketplace manifest (`name: "bje"`). Plugins live under
`plugins/<plugin-name>/`. Each plugin has its own `.claude-plugin/plugin.json` file. The
marketplace manifest lists each plugin as an entry in its `plugins` array. See
[plugin-marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces.md) and
[plugins-reference docs](https://code.claude.com/docs/en/plugins-reference.md).

Test locally with `/plugin marketplace add ./path/to/this/repo`, then
`/plugin install <plugin-name>@bje`. This is the only local install path that works here. Three
other install methods keep only the symlinks that resolve inside a plugin's own directory. These
methods are `claude --plugin-dir`, a local path install, and a `command` source in copy mode.
Each method drops the plugin's `src/lib` symlink, so its commands fail at import.

### Plugins

Plugins are listed in `README.md`; each has its own README. New `gh` skills belong in the `gh`
plugin. Its skills share repo discovery through `plugins/gh/src/discover.ts`. A skill reaches it
as `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" discover <path>`. A new skill that audits a
repository's context files for rot belongs in the `audit` plugin.

Plugin code is TypeScript, run directly by node on a 22.18 floor; `.claude/rules/type-ts.md`
has the rules. A command is an exported function. It lives at
`plugins/<plugin>/src/commands/<command>.ts`, behind one thin dispatcher at
`plugins/<plugin>/scripts/<plugin>.ts`. A hook goes at `plugins/<plugin>/hooks/*.ts`. Code
shared between plugins lives in the root `lib/`. Each plugin reaches it through the committed
symlink `plugins/<plugin>/src/lib -> ../../../lib`, the only path out of a plugin.

Nothing under `plugins/` is bash. A plugin takes no dependency and carries no `package.json`.
A command's exit codes and stdout are a contract with its callers.

Cross-plugin dependencies, declared through a preflight script rather than vendored:

- `workstreams` depends on `gh` and the `gh stack` extension, through
  `plugins/workstreams/src/commands/preflight.ts`. A new cross-plugin dependency is a row in its
  `REQUIRED_PLUGINS` table. It goes in `OPTIONAL_PLUGINS` instead when a skill works around its
  absence. It is never a vendored copy.

### Plugin domains

Plugins are the unit of installation, so each plugin is one domain of work (`gh` is GitHub and
git workflow). Users and repos install only the domains they need. A skill lands in the plugin
whose domain it belongs to, never in a catch-all plugin.

- Name a new skill's domain before you write it.
- Two cases call for a new domain. Either no existing plugin fits, or a plugin has accumulated
  skills that split along a natural seam. Raise it before you start work. Propose the new domain,
  or a split, with a name and a one-line scope.
- Domains emerge and change as the marketplace grows. It is fine to start a plugin with a
  single skill.
- When a skill moves between plugins, its `/plugin:skill` name changes. Settle the domain before
  the skill ships, not after.

Signals that a domain boundary is off:

- A user who wants one skill would have to install several unrelated ones to get it.
- A skill's description leads with a tool or system that no other skill in the plugin touches.
- Two plugins would each want the same skill.

### Plugin design

Pick the mechanism by the decision rule in the
[extension overview](https://code.claude.com/docs/en/features-overview#match-features-to-your-goal).
If a plugin grows and needs a different mechanism, raise it before the work starts, or in review.

- Skills and tools should aim to be as simple as possible.
- Anything that becomes too complex may need to become modular primitives instead.
- Hook when the action must always happen the same way and the agent need not reason about it.
  Hooks cost zero context unless they return output. Guardrails belong in `PreToolUse` hooks. An
  instruction in CLAUDE.md or a skill is a request, not enforcement.
- Skill when Claude has to decide how to apply the steps, or the content is knowledge.
- Subagent only for context isolation or parallel work. A subagent that must wait on something
  external waits in the foreground with a bounded blocking call. It returns once, with structured
  output. It must not arm a Monitor or a scheduled wake, then end its turn. That idles the
  worker, and the orchestrator then sees only "waiting". Wakes belong to the session that
  dispatched it, if anywhere.
- Anything deterministic runs in a script, not an agent. Split work so the script emits
  structured output and the agent decides from it. When an agent is needed, set `model` and
  `effort` in its frontmatter to the smallest value that passes the specs. The caller can size it
  instead. A call can set `model`, but not `effort`. A caller-sized agent, such as the workstreams
  `stream` agent, leaves both unset and inherits the session's effort.
- A skill that another skill or an orchestrator invokes never sets `disable-model-invocation:
  true`. That flag hides the skill from the `Skill` tool, so its callers cannot reach it at all.
  Use `user-invocable: false` instead, when only the model should start the skill. The
  workstreams primitives are the example: `question`, `stream`, and `review` are model-only, and
  `sweep` is open to both. Reserve `disable-model-invocation: true` for a workflow only a person
  should trigger.
- Keep `SKILL.md` under 500 lines, and put reference material in supporting files. Put the key
  use case first in `description`, since the listing truncates at 1,536 characters.
- New plugins use `skills/`, not `commands/`. The docs treat `commands/` as the flat legacy form.
- Plugin state lives under `${CLAUDE_PLUGIN_DATA}`. `${CLAUDE_PLUGIN_ROOT}` changes on update.
- Derive what a plugin needs each time it runs. Do not write a file to remember it. State on
  disk is a last resort: it is the copy that goes stale.
- A plugin that must keep state, or a plan, owns its whole lifecycle, not just the write. That
  lifecycle runs from creation through resume and reconciliation with the source of truth. It
  ends with archive or removal when the work finishes.
- A plugin works generally, on any machine and any repository layout. Nothing in one may assume
  the author's directory structure, tool setup, or environment beyond what its preflight script
  checks and reports. Paths come from `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and the
  target repository's own conventions. A literal path, or a tool the preflight does not check, is
  a defect.

### Skills

Every skill directory carries a `FLOW.md` beside its `SKILL.md`. It holds a mermaid flow diagram.
The diagram stays out of `SKILL.md`, which is loaded on every invocation. `tests/skills.test.ts`
enforces this rule across the plugins and `.claude/skills/`. See `.claude/rules/file-skill-md.md`.

## Repo tooling: root `scripts/` and `.claude/skills/`

Not everything here is a plugin. A root `scripts/` script, in TypeScript, would be this
repository's own tooling. `.claude/skills/` would hold the skill that drives it. Nobody would
install either one. Neither would appear in the marketplace manifest. `claude plugin validate`
never sees either one. The convention still holds them to the same standard, because they can
change other repositories. Neither exists today: #128 deleted the only ones there were,
`publish-plugin.py` and the `/publish` skill.

Two things would differ from a plugin:

- Repo-relative paths are correct in a root script rather than a defect.
- Its tests may drive it in-process.

`tests/skills.test.ts` checks a repo-local skill too, including the frontmatter that `--strict`
would otherwise cover.

### Tests

`pnpm test` runs the suite with coverage.

#### Layout and fixtures

- TypeScript tests sit beside the code, at `plugins/<plugin>/src/**/*.test.ts`, with fixtures at
  `src/fixtures/`. The shared harness lives in `harness/` at the repository root (see
  `harness/README.md`). Only test files import it, so it never ships. `tests/` holds this
  repository's own checks.

#### Coverage

- `vitest.config.ts`'s thresholds are the gate: 100 on lines, branches, functions, and
  statements, over a named source set. `cobertura` feeds the enterprise Code Coverage ruleset.

#### CI required checks

- `vitest`, `vitest-floor`, `types`, and `biome` in `ci.yml`, plus `plugin-validate` in its own
  workflow, are required checks on the default branch. The ruleset matches each name exactly.
- If you rename one, it silently blocks every pull request forever, because the required check
  never reports again. Put descriptive text in step names instead.
- If you add or remove a required job, update the branch ruleset in the same pull request. Add
  the new job only after it has reported on `main` once. Remove a job before the pull request
  that drops it merges.
- Manifest validation is its own workflow, `.github/workflows/plugin-validate.yml`. A bad
  manifest then reads as its own check, not as a failure inside `ci.yml`. It runs `claude plugin
  validate --strict` over the marketplace manifest and every directory under `plugins/`, on a
  pinned Claude Code version. This check needs no API key or login.

#### Git hooks

- lefthook, staged-only, never a suite (ADR 002).
- `lefthook.yml` holds the steps. `CONTRIBUTING.md` says how they install.
- A worktree without its own `pnpm install` still runs the hooks, borrowed from whichever
  checkout installed them. Each pnpm-based step warns and skips, until that worktree runs
  `pnpm install`.

#### Fixture quality

- Any script that can delete or overwrite something needs a test. The test must prove the
  script acts when it should. It must also prove the script refuses when it should not.
- Assert against real repositories that the fixtures build. Do not mock git. `harness/git.ts`
  builds these repositories.
- A fixture may claim what state it produces. Assert that claim in the fixture's own test too
  (`harness/*.test.ts`). Then the other tests cannot pass for the wrong reason.
- Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
  repositories outside the `bje` enterprise into this repository. Reconstruct the shape of the
  case instead.
- Test the non-deterministic parts too. For a skill or agent, run realistic prompts in fresh
  sessions, both with and without it, then compare the results. Or use the official
  `skill-creator` plugin for evals.

## Language server

`.claude/settings.json` enables this marketplace's `typescript7-lsp` and turns off
`typescript-lsp@claude-plugins-official` (#193). Then `tsc` and the language server run the same
pinned `node_modules/typescript`.

Otherwise `.claude/settings.json` matches SurveyMonkey/skills' settings: it turns off auto memory
(`autoMemoryEnabled`) and strips the attribution trailer (`attribution`).

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself. It is
symlinked there, so enterprise-wide context lives here instead of in the personal dotfiles
repository. `ENTERPRISE_REPO_MIGRATION.md` is symlinked alongside it as
`~/Code/@bje/REPO-MIGRATION.md`: the plan for which `brianespinosa` repos move into which bje org.

## Records

Decisions live in `docs/rfc/` and `docs/adr/`, under `.claude/rules/path-docs.md` and its
per-type rules, with an `index.md` per bundle that a landing PR updates. `docs/rfc/001-typescript-port.md`
is the record for the TypeScript port. `docs/adr/001-typescript-on-node-22-18.md` (runtime,
shared `lib/`, test seam) and `docs/adr/002-quality-gate-venues.md` (hooks, CI, coverage) back it.
