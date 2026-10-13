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
`/plugin install <plugin-name>@bje`. `claude --plugin-dir plugins/<plugin-name>` also works. A
plugin holds no symlink, so each install method gets the same files (ADR 006).

### Plugins

Plugins are listed in `README.md`; each has its own README. New `gh` skills belong in the `gh`
plugin. Its skills share repo discovery through `plugins/gh/src/discover.ts`. A skill reaches it
as `node "${CLAUDE_PLUGIN_ROOT}/scripts/gh.ts" discover <path>`. A new skill that audits a
repository's context files for rot belongs in the `audit` plugin.

Plugin code is TypeScript, run directly by node on a 22.18 floor; `.claude/rules/type-ts.md`
has the rules. Each dispatcher subcommand is an exported function, the command function. It
lives at `plugins/<plugin>/src/subcommands/<command>.ts`, behind one thin dispatcher at
`plugins/<plugin>/scripts/<plugin>.ts`. A hook goes at `plugins/<plugin>/hooks/*.ts`. Code
shared between plugins lives in the root `lib/`. Each plugin holds copies of the `lib/` files it
imports in `plugins/<plugin>/src/lib/`. Edit `lib/`, then run `node scripts/sync-lib.ts`. No
import leaves a plugin.

Nothing under `plugins/` is bash. A plugin takes no dependency and carries no `package.json`.
A command's exit codes and stdout are a contract with its callers.

`.claude/rules/_design-principles.md` holds the design approach: composition, mechanisms, state,
and how a plugin declares and checks a dependency outside its directory.

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

### Skills

Every skill has a flow directory, `docs/flows/<plugin>/<skill>/`, with `_skill-flow.md` and one
`<subcommand>-flow.md` for each dispatcher subcommand the skill runs. The diagrams stay out of
`SKILL.md`, which is loaded on every invocation, and out of the skill directory, which ships.
`tests/repo/skills.test.ts` enforces this rule. See `.claude/rules/file-skill-md.md`.

## Repo tooling: root `scripts/` and `.claude/skills/`

Not everything here is a plugin. A root `scripts/` script, in TypeScript, is this repository's
own tooling. A skill in `.claude/skills/` would drive one. Nobody installs either one.
Neither appears in the marketplace manifest. `claude plugin validate` never sees either one. The
convention still holds them to the same standard, because they can change other repositories.
`scripts/sync-lib.ts` is the one root script. It copies `lib/` into each plugin, and
`tests/repo/sync-lib.test.ts` tests it. No repo-local skill exists: #128 deleted the only one,
`/publish`.

Two things differ from a plugin:

- Repo-relative paths are correct in a root script rather than a defect.
- Its tests may drive it in-process.

`tests/repo/skills.test.ts` checks a repo-local skill too, including the frontmatter that `--strict`
would otherwise cover.

### Tests

`pnpm test` runs the suite with coverage.

#### Layout and fixtures

- Every test lives under `tests/`, never in a plugin or in `lib/`, because Claude Code copies a
  plugin's whole directory into each user's cache (ADR 004, `.claude/rules/path-plugins.md`).
  `tests/plugins/<plugin>/` mirrors `plugins/<plugin>/src/`, with fixtures at
  `tests/plugins/<plugin>/fixtures/`. `tests/lib/` and `tests/harness/` hold the tests of `lib/`
  and `harness/`, and `tests/repo/` holds this repository's own checks.
- A test imports plugin code through the `#<plugin>/*` aliases in the root `package.json`, and
  the harness through `#harness/*`. `harness/paths.ts` names a plugin's scripts and hooks for a
  test that runs them as a process.
- The shared harness lives in `harness/` at the repository root (see `harness/README.md`). No
  plugin file imports it, so it never ships.

#### Coverage

- `vitest.config.ts`'s thresholds are the gate: 100 on lines, branches, functions, and
  statements, over a named source set. `cobertura` feeds the enterprise Code Coverage ruleset.

#### CI required checks

- `vitest`, `vitest-floor`, `types`, `biome`, and `eslint` in `ci.yml`, plus `plugin-validate` in
  its own workflow, are required checks on the default branch. The ruleset matches each name
  exactly.
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
  (`tests/harness/*.test.ts`). Then the other tests cannot pass for the wrong reason.
- Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
  repositories outside the `bje` enterprise into this repository. Reconstruct the shape of the
  case instead.
- Test the non-deterministic parts too. For a skill or agent, run realistic prompts in fresh
  sessions, both with and without it, then compare the results. Or use the official
  `skill-creator` plugin for evals.

## ESLint

The `eslint-plugin-claude` npm package lints Claude Code configuration files. `eslint.config.ts`
holds the rule overrides. Run `pnpm lint .`; `CONTRIBUTING.md` has the editor setup.

## Claude settings

`.claude/settings.json` enables each plugin in this marketplace: `gh`, `workstreams`,
`mermaid` and `audit`. It turns off `typescript-lsp@claude-plugins-official` (#193). When you
add a plugin to the marketplace, add it to `enabledPlugins` too.
`extraKnownMarketplaces` names this repository as the `bje` source. A new machine or a cloud
session then installs each enabled `@bje` plugin.

Otherwise `.claude/settings.json` matches SurveyMonkey/skills' settings: it turns off auto memory
(`autoMemoryEnabled`) and strips the attribution trailer (`attribution`).

## Records

Decisions live in `docs/rfc/` and `docs/adr/`, under `.claude/rules/path-docs.md` and its
per-type rules, with an `index.md` per bundle that a landing PR updates. `docs/rfc/001-typescript-port.md`
is the record for the TypeScript port. `docs/adr/001-typescript-on-node-22-18.md` (runtime,
shared `lib/`, test seam) and `docs/adr/002-quality-gate-venues.md` (hooks, CI, coverage) back it.
