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
`/bin/bash`. No associative arrays, no `wait -n` without a fallback. This applies to every script
not yet ported to Python, which today is all of them but the two hook helpers.

Python scripts live at `plugins/<plugin>/scripts/*.py`, with code shared inside one plugin in
`plugins/<plugin>/scripts/lib/` and imported by `sys.path.insert(0, HERE)` where `HERE` is the
script's own directory; hooks live at `plugins/<plugin>/hooks/*.py`. Nothing imports across
plugins: a user installs one plugin without the others. Stdlib only, always, so an end user never
needs `uv` or a virtualenv to run a plugin. The floor is Python 3.9, which is what a Mac with the
Command Line Tools has at `/usr/bin/python3`: `from __future__ import annotations` for modern
annotations, no `match`, no `datetime.UTC`. ruff's `target-version = "py39"` enforces the syntax,
so the floor is checked rather than remembered. New scripts are Python, not bash. A port keeps the
script's exit codes and its stdout contract exactly as they were; the callers are skills and shell
scripts that read both.

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
- Skills with side effects set `disable-model-invocation: true`. Keep `SKILL.md` under 500 lines;
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

Python tests are pytest, under `tests/<plugin>/`, with the shared sandbox in `tests/conftest.py`.
Run them alone with `uv run pytest -n auto --cov`. A script is driven black-box through the
`run_script` fixture, which runs it as its own process under `sys.executable` the way Claude Code
runs it; decision logic that is awkward to provoke from the outside gets direct unit tests beside
that. `tests/conftest.py` also carries `sandbox` (a private temp dir with `HOME` inside it),
`stub_path` (a directory put ahead of everything on `PATH`, for stubs) and `path_without` (a `PATH`
holding the real tools minus the named ones, for the "tool is not installed" branches). Each port
brings its own stub `gh` and its own canned data on top of those.

Coverage for the Python side is coverage.py with `branch = true` and `patch = ["subprocess"]`, so a
script exercised black-box in a child process is still measured. Branch coverage is the point: a
`jq` program moved into Python stops being one opaque line and becomes arms the report can name,
which is the answer to the blind spot `.claude/rules/type-jq.md` describes.
`plugins/field-test/hooks/hook-io.py` is omitted from the coverage.py config until issue #59 ports
its examples; its coverage comes from kcov in the meantime, through the shell specs that drive it.

`tests/coverage_check.py` is the gate for both reports, at 95%, which is the enterprise Code
Coverage ruleset's threshold. It is deliberately stdlib-only and 3.9-compatible: CI runs it with
the runner's system `python3`, outside the uv environment. It prints per-file numbers with the
uncovered lines, and, where the report carries branch data, the partly-taken branches beside them,
so a drop says which file moved. The threshold is enforced there rather than by shellspec's
`--fail-low-coverage`, which reports a failure at any coverage level once enabled. Reproduce a CI
coverage run with `spec/run.sh --coverage`.

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
`setup_ws_sandbox`, and the `sandbox` fixture on the Python side); nothing may write to the checkout
or to a fixed path.

The CI job names `shellcheck`, `bash-5`, `bash-3.2`, `coverage`, `ruff`, `pytest` and
`pytest-floor` are required checks on the default branch, matched by exact string. Renaming one
does not fail the build: the required check never reports and pull requests wait forever. Put
descriptive text in step names instead. The last three join the ruleset only once this lands on
main, because a required check that has never reported there blocks every pull request.

Any script that can delete or overwrite something needs a spec or a test proving both that it acts
when it should and that it refuses when it should. Assert against real repositories built by the
fixtures rather than mocking git; see `fixtures/gh/README.md`. When a fixture makes a claim about
the state it produces, assert that claim in `spec/gh/fixtures_spec.sh` too, so the other specs
cannot pass for the wrong reason.

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
