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
`tidy-user-notifications`). The no-checkout rebase `rebase-prs` performs already lives here as
`gh-shepherd-pr.py rebase`; repo discovery shared by skills is `scripts/lib/discover.py`.

Plugin scripts are Python. Nothing under `plugins/` is bash any more, and nothing new should be:
the harness, the coverage tooling, and the rules all assume Python. A Python script goes at
`plugins/<plugin>/scripts/*.py` and a hook at `plugins/<plugin>/hooks/*.py`; code shared inside one
plugin goes in `plugins/<plugin>/scripts/lib/`, imported by `sys.path.insert(0, HERE)` where `HERE`
is the script's own directory, and a hook, which sits one level across rather than one level up,
inserts the sibling `scripts/` directory instead. Nothing imports across plugins: a user installs
one plugin without the others. `plugins/gh/scripts/lib/` and `plugins/workstreams/scripts/lib/` are
the worked examples: `cli.py` holds what every one of a plugin's scripts does around its own work
(the UTF-8 output streams, the flush, a reported failure, a closed pipe, an unanticipated
exception), and the modules beside it hold what used to be each script's jq filters and argument
checks, as plain functions with a unit test per arm. `plugins/field-test/scripts/lib/` is the same
shape, and its `run.py` is what `hooks/hook-io.py` imports rather than keeping a second copy of
where the run marker lives. Scripts import `lib` through `sys.path`; tests load a plugin's lib
modules by path under a plugin-unique module name, so the names the tests themselves hold do not
collide. That by-path load is not on its own enough: a script loaded in-process still runs its own
`from lib import ...` through `sys.modules["lib"]`, which the root `conftest.py` resets before every
test. The loader is why nothing under `lib/` imports another `lib/` module: a module loaded by path
sits outside any package, where a sibling import would not resolve, so a module that raises its own
error class hands it to `cli.run` rather than importing one.

Two plugins' `lib` packages collide on `sys.modules["lib"]`, because pytest runs every plugin's
tests in one process while each script resolves `lib` from its own `sys.path`. The root
`tests/conftest.py` handles it: an autouse fixture drops every `lib` and `lib.*` module and every
leftover `plugins/<plugin>/scripts` or `.../hooks` entry from `sys.path` before each test and again
after it, so each in-process load re-resolves `lib` from its own script's directory. Do not change
how a plugin script imports; end users run them as processes. An in-process loader must not cache a
script module across tests, or it hands the next test another plugin's `lib`; load it inside the
test that uses it.

Stdlib only, always, so an end user never needs `uv` or a virtualenv to run a plugin. The floor is
Python 3.9, which is what a Mac with the Command Line Tools has at `/usr/bin/python3`. ruff's
`target-version = "py39"` plus the `FA` rules catch the syntax: `match`, and a PEP 604 `X | None`
annotation in a module with no `from __future__ import annotations`. It cannot catch library
surface, such as `datetime.UTC` or a keyword argument added in a later release; only running on 3.9
does, which is what the `pytest-floor` job is for. A script's exit codes and its stdout are a
contract: the callers are skills and agents that read both, so a change to either is a change to
every call site.

`workstreams` depends on `gh-stack` and `pr-review-toolkit` through its preflight script; do not
vendor either. `field-test` depends on `workstreams` and `pr-review-toolkit` the same way, through
the `harden` skill's preflight; do not vendor those either, and do not duplicate the review loop
`workstreams` already owns.

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
  plan owns the whole lifecycle of it -- creation, resume, reconcile
  against the source of truth, and archive or removal when it is finished -- not just the write.
  `plugins/workstreams/docs/spike-65-state-file.md` is the worked example: what could be derived,
  what could not, and what the file owed once it was kept.
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
manifest, and `claude plugin validate` never sees either. They are held to the same standards
anyway, because they can change other repositories.

Three things differ from a plugin, and `.claude/rules/type-py.md` has the detail: a root script is
one self-contained module with no `lib/` and no `sys.path.insert`, repo-relative paths are correct
in it rather than a defect, and its tests may drive it in-process. `tests/test_repo_layout.py`
enforces the first of those, since its failure mode is a confusing error in an unrelated plugin's
tests. Repo-local skills are checked by `tests/test_skills.py`, including the frontmatter that
`--strict` would otherwise have covered.

### Publishing a plugin downstream

This repo is internal to the `bje` enterprise, so a team that cannot read it cannot install from
it either. Until it is published, a plugin is mirrored into a repository that team can read, and
that repository carries its own marketplace manifest.

`/publish <plugin> <dest>` is the skill; `scripts/publish-plugin.py` is the deterministic half.
The mirror enumerates `git ls-files`, so what gets published is what is committed, and it writes
only `<dest>/plugins/<name>/`. It never commits, and the destination repo reviews the result as a
pull request.

`sm-incubator/org-claude` is the one downstream today, holding a copy of `gh` in a marketplace
named `lab`; teammates there install with `/plugin install gh@lab`. That copy is generated and
read-only: a fix goes here and is republished, never edited there. Because it is distributed on
its own, `plugins/gh/README.md` must stay free of enterprise framing and literal local paths.
When this repo is published, the copy is replaced by a marketplace entry pointing here, and the
script and skill retire.

### Tests

One harness, one command: `uv run --locked pytest -n auto --cov`. `--locked` everywhere, as in CI,
so a stale `uv.lock` fails instead of being rewritten under you.

A plugin's tests live in `tests/<plugin>/`; tests that span plugins or cover the harness itself sit
at the root of `tests/`. A test module's basename is unique across the whole suite, because pytest
imports them into one namespace: hence `test_gh_fixtures.py` and `test_ws_fixtures.py` rather than
two `test_fixtures.py`. A script is driven black-box through the `run_script` fixture, which runs
it as its own process under `sys.executable` the way Claude Code runs it; decision logic that is
awkward to provoke from the outside gets direct unit tests beside that. The other fixture is
`sandbox`, a private temp dir with `HOME` inside it and `CLAUDE_PLUGIN_DATA` unset; it returns an
object whose `stub_path` method puts a directory ahead of everything on `PATH` (for stubs) and
whose `path_without` method builds a `PATH` holding the real tools minus the named ones (for the
"tool is not installed" branches). Each plugin brings its own stub `gh` and its own canned data on
top of those.

Coverage is coverage.py with `branch = true` and `patch = ["subprocess"]`, so a script exercised
black-box in a child process is still measured. Branch coverage is the point: a former `jq`
program moved into Python stops being one opaque line and becomes arms the report can name, which
is why the port was worth doing at all. Stub tools under `tests/<plugin>/bin/` are omitted from the
config, since the subprocess patch would otherwise measure a fixture standing in for a tool as code
under test. Every omit pattern is `**/`-prefixed because a relative one is anchored to the current
directory of whichever process reads the config, and coverage.py re-reads it in every measured
child. See `.claude/rules/type-py.md`.

`tests/coverage_check.py` is the gate, at 95%, and is itself in the denominator, because a gate
nobody tests is a gate nobody can trust. 95% is the enterprise Code Coverage ruleset's threshold.
The script is deliberately stdlib-only and 3.9-compatible: CI runs it with the runner's system
`python3`, outside the uv environment, so a broken dev environment is never what decides whether a
build passes. It prints per-file numbers with the uncovered lines, and the partly-taken branches
beside them, so a drop says which file moved. The gate itself is the report's root line-rate: a
partial branch is reported for a human to act on, never enforced. Reproduce a CI coverage run with
`uv run --locked pytest -n auto --cov --cov-report=xml` followed by
`python3 tests/coverage_check.py coverage/python.xml 95`.

The suite runs in parallel under `pytest-xdist` (`-n auto`), so every test must build its state in
its own temp dir (the `sandbox` fixture); nothing may write to the checkout or to a fixed path.

The CI job names `ruff`, `pytest`, `pytest-floor` and `coverage` in `ci.yml`, plus `plugin-validate`
in its own workflow, are required checks on the default branch, matched by exact string. Renaming
one does not fail the build: the required check never reports and pull requests wait forever. Put
descriptive text in step names instead. A new job name becomes a required check only after it has
reported on main, because one that never has blocks every pull request; add it to the ruleset right
after the pull request that introduces it merges. Removing a job is the mirror image: delete its
name from the ruleset before merging the pull request that removes it, or that pull request and
every later one wait on a check that never reports.

Manifest validation is its own workflow, `.github/workflows/plugin-validate.yml`, so a bad manifest
reads as its own check rather than as a failure inside `ci.yml`. It runs `claude plugin validate
--strict` over the marketplace manifest and every directory under `plugins/`, which needs no API key
or login, on a pinned Claude Code version.

In an opted-in clone, `claude plugin validate --strict`, ruff, and the Python suite run before every
commit through the `pre-commit` framework; `.pre-commit-config.yaml` holds the hooks and
`CONTRIBUTING.md` says how to opt in. Every hook is `repo: local`: each tool already has one source
of truth, `uv.lock` for ruff and pytest and PATH for `claude`, and mirroring versions into `rev:`
fields here would add a second. Opting in is once per clone, from the root checkout, and covers
every worktree of it, since worktrees share the clone's `.git/hooks/`; CI, not the hooks, is the
enforcement layer.

Any script that can delete or overwrite something needs a test proving both that it acts when it
should and that it refuses when it should. Assert against real repositories built by the fixtures
rather than mocking git; see `tests/gh/README.md`. When a fixture makes a claim about the state it
produces, assert that claim in the plugin's own fixture test too (`tests/gh/test_gh_fixtures.py`,
`tests/workstreams/test_ws_fixtures.py`, `tests/field-test/test_ft_fixtures.py`), so the other
tests cannot pass for the wrong reason.

Build fixtures from real cases seen in field tests. Do not copy specifics from field tests on
repos outside the `bje` enterprise into this repo; reconstruct the shape of the case instead.

Test the non-deterministic parts too. For a skill or agent, run realistic prompts in fresh
sessions with and without it and compare, or use the official `skill-creator` plugin for evals.

## Rules and settings syncing (future)

Not yet implemented. When added, this section should describe how `.claude/rules/` and
`settings.json` get shared into other `@bje` repos.

## Enterprise CLAUDE.md

`ENTERPRISE_CLAUDE.md` is the `CLAUDE.md` for the `~/Code/@bje/` directory itself, symlinked there
so enterprise-wide context lives here instead of in the personal dotfiles repo.
