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
`gh-shepherd-pr.sh rebase`; repo discovery shared by skills is `scripts/lib/discover.sh`.

Plugin scripts that are still bash must run under bash 3.2, which is what macOS ships at
`/bin/bash`. No associative arrays, no `wait -n` without a fallback. This applies to every `.sh`
under `plugins/` (`find plugins -name '*.sh'` lists them); `workstreams` is entirely Python.

New scripts are Python, not bash. A Python script goes at `plugins/<plugin>/scripts/*.py` and a
hook at `plugins/<plugin>/hooks/*.py`; code shared inside one plugin goes in
`plugins/<plugin>/scripts/lib/`, imported by `sys.path.insert(0, HERE)` where `HERE` is the
script's own directory. Nothing imports across plugins: a user installs one plugin without the
others. `plugins/workstreams/scripts/lib/` is the worked example: `cli.py` holds what every one of
that plugin's scripts does around its own work (the UTF-8 output streams, the flush, a reported
failure, a closed pipe, an unanticipated exception), and `state.py`, `issues.py` and `pr_status.py`
hold what used to be each script's jq filters and argument checks, as plain functions with a unit
test per arm. Scripts import `lib` through `sys.path`, but tests load a plugin's lib modules by
path under a plugin-unique module name, because two plugins' `lib` packages collide on
`sys.modules["lib"]` in one pytest process. That loader is why nothing under `lib/` imports another
`lib/` module: a module loaded by path sits outside any package, where a sibling import would not
resolve, so a module that raises its own error class hands it to `cli.run` rather than importing one.

Stdlib only, always, so an end user never needs `uv` or a virtualenv to run a plugin. The floor is
Python 3.9, which is what a Mac with the Command Line Tools has at `/usr/bin/python3`. ruff's
`target-version = "py39"` plus the `FA` rules catch the syntax: `match`, and a PEP 604 `X | None`
annotation in a module with no `from __future__ import annotations`. It cannot catch library
surface, such as `datetime.UTC` or a keyword argument added in a later release; only running on 3.9
does, which is what the `pytest-floor` job is for. A port keeps the script's exit codes and its
stdout contract exactly as they were; the callers are skills and shell scripts that read both.

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

### Skills

Every skill directory carries a `FLOW.md` beside its `SKILL.md`, holding a mermaid flow diagram.
The diagram stays out of `SKILL.md`, which is loaded on every invocation. Enforced by
`tests/test_skills.py` across all plugins; see `.claude/rules/file-skill-md.md`.

### Tests

Two harnesses, one command. `spec/run.sh` lints and then runs both: shellspec for the scripts that
are still bash, pytest for the ones that are Python. It runs the shellspec suite under both bash 5
and bash 3.2, and fails if either does.

Python tests are pytest. A plugin's tests live in `tests/<plugin>/`; tests that span plugins or
cover the harness itself sit at the root of `tests/`. Run them alone with
`uv run --locked pytest -n auto --cov`; `--locked` everywhere, as in CI, so a stale `uv.lock`
fails instead of being rewritten under you. A script is driven black-box through the `run_script`
fixture, which runs it as its own process under `sys.executable` the way Claude Code runs it;
decision logic that is awkward to provoke from the outside gets direct unit tests beside that. The
other fixture is `sandbox`, a private temp dir with `HOME` inside it and `CLAUDE_PLUGIN_DATA`
unset; it returns an object whose `stub_path` method puts a directory ahead of everything on
`PATH` (for stubs) and whose `path_without` method builds a `PATH` holding the real tools minus
the named ones (for the "tool is not installed" branches). Each port brings its own stub `gh` and
its own canned data on top of those.

Coverage for the Python side is coverage.py with `branch = true` and `patch = ["subprocess"]`, so a
script exercised black-box in a child process is still measured. Branch coverage is the point: a
`jq` program moved into Python stops being one opaque line and becomes arms the report can name,
which is the answer to the blind spot `.claude/rules/type-jq.md` describes.
Stub tools under `tests/<plugin>/bin/` are omitted from the config, since the subprocess patch
would otherwise measure a fixture standing in for a tool as code under test. Every omit pattern is
`**/`-prefixed because a relative one is anchored to the current directory of whichever process
reads the config, and coverage.py re-reads it in every measured child.
`plugins/field-test/hooks/hook-io.py` is omitted as well, and is measured by
neither harness until issue #59 ports its examples: kcov does not follow the `python3` child the
shell specs launch, so the file appears in no report at all. The omit only keeps that gap from
reading as a 0% file and sinking the Python gate; it does not stand in for coverage.

`tests/coverage_check.py` is the gate for both reports, at 95%, and is itself in the Python
denominator, because a gate nobody tests is a gate nobody can trust. 95% is the enterprise Code
Coverage ruleset's threshold. The script is deliberately stdlib-only and 3.9-compatible: CI runs
it with the runner's system `python3`, outside the uv environment, so a broken dev environment is
never what decides whether a build passes. It prints per-file numbers with the uncovered lines,
and, where the report carries branch data, the partly-taken branches beside them, so a drop says
which file moved. The gate itself is the root line-rate in both reports: a partial branch is
reported for a human to act on, never enforced. The threshold lives there rather than in
shellspec's `--fail-low-coverage`, which reports a failure at any coverage level once enabled.
Reproduce a CI coverage run with `spec/run.sh --coverage`.

Coverage for the shell scripts stays kcov, pinned to `ubuntu-22.04`: newer kcov builds break
shellspec, and the alternative, bashcov, prevents shellspec running at all. Re-test before changing
either. It is line coverage only, so the number does not mean "tested" where the logic lives inside
a `jq` program; see `.claude/rules/type-jq.md`. The kcov run is serial: shellspec's kcov executor
wraps the whole suite in one kcov process and ignores `--jobs`, so neither `spec/run.sh --coverage`
nor the CI coverage job can parallelise it.

The two shellspec passes run concurrently, splitting shellspec `--jobs` sized to the machine between
them (`SPEC_JOBS` overrides the total). Under `--jobs`, shellspec 0.28.1 does not stop on Ctrl-C,
only on a SIGTERM sent to its whole process group; `spec/run.sh` handles that for both passes, so
use it rather than bare `shellspec --jobs` for a run you may need to interrupt. Parallelism is per
spec file, not per example, so a spec file that grows much larger than the rest becomes the floor on
wall time. Every example must keep building its state in its own temp dir (`setup_sandbox`,
`setup_ft_sandbox`, and the `sandbox` fixture on the Python side); nothing may write to the checkout
or to a fixed path.

The CI job names `shellcheck`, `bash-3.2`, `coverage`, `ruff`, `pytest` and
`pytest-floor` are required checks on the default branch, matched by exact string. Renaming one
does not fail the build: the required check never reports and pull requests wait forever. Put
descriptive text in step names instead. A new job name becomes a required check only after it has
reported on main, because one that never has blocks every pull request; add it to the ruleset right
after the pull request that introduces it merges. Removing a job is the mirror image: delete its name
from the ruleset before merging the pull request that removes it, or that pull request and every later
one wait on a check that never reports.

Manifest validation is its own workflow, `.github/workflows/plugin-validate.yml`, so a bad manifest
reads as its own check rather than as a failure inside `ci.yml`. It runs `claude plugin validate
--strict` over the marketplace manifest and every directory under `plugins/`, which needs no API key
or login, on a pinned Claude Code version. Its job name, `plugin-validate`, becomes a ruleset
contract like the names above once it is added to the repo ruleset Require CI (22359720), which
happens right after the pull request that introduced the workflow merges, per the rule above.

In an opted-in clone, `claude plugin validate --strict`, ruff, and the Python suite run before every
commit through the `pre-commit` framework, and shellcheck runs when a shell file is staged; `.pre-commit-config.yaml` holds the
hooks and `CONTRIBUTING.md` says how to opt in. Every hook is `repo: local`: each tool already has
one source of truth, `uv.lock` for ruff and pytest and PATH for `claude` and `shellcheck`, and
mirroring versions into `rev:` fields here would add a second. Opting in is once per clone, from the
root checkout, and covers every worktree of it, since worktrees share the clone's `.git/hooks/`; CI,
not the hooks, is the enforcement layer.

Any script that can delete or overwrite something needs a spec or a test proving both that it acts
when it should and that it refuses when it should. Assert against real repositories built by the
fixtures rather than mocking git; see `fixtures/gh/README.md`. When a fixture makes a claim about
the state it produces, assert that claim in `spec/gh/fixtures_spec.sh` too, so the other specs
cannot pass for the wrong reason.

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
