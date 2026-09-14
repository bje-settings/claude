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

New `gh` skills belong in the `gh` plugin. Repo discovery shared by skills is
`scripts/lib/discover.py`.

Plugin scripts are Python, stdlib only -- nothing under `plugins/` is bash, and an end user never
needs `uv` or a virtualenv to run a plugin:

- A script goes at `plugins/<plugin>/scripts/*.py`, a hook at `plugins/<plugin>/hooks/*.py`, and
  code shared within one plugin goes in `plugins/<plugin>/scripts/lib/`, imported via
  `sys.path.insert(0, HERE)`.
- Nothing imports across plugins, and nothing under one plugin's `lib/` imports another `lib/`
  module -- `plugins/gh/scripts/lib/` and `plugins/field-test/scripts/lib/` are the worked
  examples.
- Do not change how a plugin script imports `lib`: the root `tests/conftest.py` resets
  `sys.modules`/`sys.path` between tests so each plugin's `lib` resolves independently, which
  means an in-process test loader must not cache a script module across tests either.
- The floor is Python 3.9 (what a Mac's Command Line Tools ships at `/usr/bin/python3`); ruff's
  `target-version` catches most syntax issues, but library surface added after 3.9 only the
  `pytest-floor` CI job catches.
- A script's exit codes and stdout are a contract with the skills/agents that call it.

Cross-plugin dependencies, declared through a preflight script rather than vendored:

- `field-test` depends on `workstreams` and `pr-review-toolkit` (through the `harden` skill's
  preflight). `workstreams` is being rebuilt as the #111 primitives, and `harden` is rebuilt on
  them at #137; do not duplicate the review loop in `field-test` meanwhile.

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
  and `effort` in its frontmatter to the smallest that passes the specs.
- Skills with side effects set `disable-model-invocation: true`, unless the skill exists to be
  invoked by another skill: the flag hides it from the `Skill` tool, so its callers cannot reach
  it at all. Keep `SKILL.md` under 500 lines;
  reference material goes in supporting files. Put the key use case first in `description`,
  since the listing truncates at 1,536 characters.
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
The diagram stays out of `SKILL.md`, which is loaded on every invocation. Enforced by
`tests/test_skills.py` across the plugins **and** `.claude/skills/`; see
`.claude/rules/file-skill-md.md`.

## Repo tooling: root `scripts/` and `.claude/skills/`

Not everything here is a plugin. `scripts/*.py` is this repo's own tooling and `.claude/skills/`
holds the skills that drive it. Neither is installed by anyone, neither is in the marketplace
manifest, and `claude plugin validate` never sees either -- they're held to the same standards
anyway, because they can change other repositories.

Three things differ from a plugin (`.claude/rules/type-py.md` has the detail):

- A root script is one self-contained module, with no `lib/` and no `sys.path.insert`. Enforced by
  `tests/test_repo_layout.py`, since a violation's failure mode is a confusing error in an
  unrelated plugin's tests.
- Repo-relative paths are correct in a root script rather than a defect.
- Its tests may drive it in-process.

Repo-local skills are checked by `tests/test_skills.py`, including the frontmatter that `--strict`
would otherwise have covered.

### Publishing a plugin downstream

This repo is internal to the `bje` enterprise, so a team that cannot read it cannot install from
it either. Until it is published, a plugin is mirrored into a repository that team can read, and
that repository carries its own marketplace manifest.

- `/publish <plugin> <dest>` is the skill; `scripts/publish-plugin.py` is the deterministic half.
- The mirror enumerates `git ls-files`, so what gets published is what is committed, and it writes
  only `<dest>/plugins/<name>/`.
- It never commits; the destination repo reviews the result as a pull request.

Downstream today: `sm-incubator/org-claude` holds a copy of `gh` in a marketplace named `lab`;
teammates there install with `/plugin install gh@lab`.

- That copy is generated and read-only: a fix goes here and is republished, never edited there.
- Because it is distributed on its own, `plugins/gh/README.md` must stay free of enterprise
  framing and literal local paths.

### Tests

One harness, one command: `uv run --locked pytest -n auto --cov`. `--locked` everywhere, as in CI,
so a stale `uv.lock` fails instead of being rewritten under you.

#### Layout and fixtures

- A plugin's tests live in `tests/<plugin>/`; tests that span plugins or cover the harness itself
  sit at the root of `tests/`.
- A test module's basename is unique across the whole suite, because pytest imports them into one
  namespace -- hence `test_gh_fixtures.py` and `test_ft_fixtures.py` rather than two
  `test_fixtures.py`.
- `run_script` drives a script black-box, as its own process under `sys.executable`, the way
  Claude Code runs it; decision logic that's awkward to provoke from the outside gets direct unit
  tests beside that.
- `sandbox` is a private temp dir with `HOME` inside it and `CLAUDE_PLUGIN_DATA` unset. Its
  `stub_path` method puts a directory ahead of everything on `PATH` (for stubs); its `path_without`
  method builds a `PATH` holding the real tools minus the named ones (for "tool is not installed"
  branches). Each plugin brings its own stub `gh` and its own canned data on top of those.
- The suite runs in parallel under `pytest-xdist` (`-n auto`), so every test must build its state
  in its own temp dir (the `sandbox` fixture); nothing may write to the checkout or a fixed path.

#### Coverage

- coverage.py, with `branch = true` and `patch = ["subprocess"]`, so a script exercised black-box
  in a child process is still measured. Stub tools under `tests/<plugin>/bin/` are omitted from
  the config. See `.claude/rules/type-py.md`.
- `tests/coverage_check.py` is the gate, at 95% (the enterprise Code Coverage ruleset's threshold),
  and is itself in the denominator. It's deliberately stdlib-only and 3.9-compatible since CI runs
  it with the runner's system `python3`, outside the uv environment.
- Reproduce a CI coverage run with `uv run --locked pytest -n auto --cov --cov-report=xml`
  followed by `python3 tests/coverage_check.py coverage/python.xml 95`.

#### CI required checks

- `ruff`, `pytest`, `pytest-floor` and `coverage` in `ci.yml`, plus `plugin-validate` in its own
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

#### Pre-commit

In an opted-in clone, `claude plugin validate --strict`, ruff, and the Python suite run before
every commit through the `pre-commit` framework.

- `.pre-commit-config.yaml` holds the hooks; `CONTRIBUTING.md` says how to opt in.
- Every hook is `repo: local`: each tool already has one source of truth (`uv.lock` for ruff and
  pytest, `PATH` for `claude`), and mirroring versions into `rev:` fields here would add a second.
- Opting in is once per clone, from the root checkout, and covers every worktree of it, since
  worktrees share the clone's `.git/hooks/`; CI, not the hooks, is the enforcement layer.

#### Fixture quality

- Any script that can delete or overwrite something needs a test proving both that it acts when
  it should and that it refuses when it should. Assert against real repositories built by the
  fixtures rather than mocking git; see `tests/gh/README.md`.
- When a fixture makes a claim about the state it produces, assert that claim in the plugin's own
  fixture test too (`tests/gh/test_gh_fixtures.py`, `tests/field-test/test_ft_fixtures.py`), so
  the other tests cannot pass for the wrong reason.
- Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
  repos outside the `bje` enterprise into this repo; reconstruct the shape of the case instead.
- Test the non-deterministic parts too. For a skill or agent, run realistic prompts in fresh
  sessions with and without it and compare, or use the official `skill-creator` plugin for evals.

## Language server

Sessions on this checkout run the TypeScript language server: `.claude/settings.json` enables
`typescript-lsp@claude-plugins-official`, which expects the server on `PATH`, so install it once
per machine:

```bash
npm install -g typescript-language-server typescript
```

The server resolves the compiler the repository pins in `devDependencies` (`typescript`, landing
with #117), so `tsc` and the editor answer from the same version.

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.

## Records

Decisions live in `docs/rfc/` and `docs/adr/`, under `.claude/rules/path-docs.md` and its per-type
rules, with an `index.md` per bundle that a landing PR updates. `docs/rfc/001-typescript-port.md`
is the record for the TypeScript port, with `docs/adr/001-typescript-on-node-22-18.md` (runtime,
shared `lib/`, test seam) and `docs/adr/002-quality-gate-venues.md` (hooks, CI, coverage) behind it.
