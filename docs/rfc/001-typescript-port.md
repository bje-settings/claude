---
type: RFC
description: Moves the marketplace's plugin scripts off Python 3.9 onto TypeScript executed directly by Node 22.18 or newer, with one root `lib/` symlinked into every plugin, tests co-located beside the code (superseded by ADR 004), and the local and CI quality gates split by venue.
status: stable
created: 2026-09-12
owner: brianespinosa
related_milestones: [2, 3, 4, 5]
related_adrs: [1, 2]
---

# RFC 001: The plugin marketplace moves to TypeScript

## Summary

This marketplace ships 11,082 lines of Python across four plugins, `field-test` (4,966), `gh`
(3,406), `workstreams` (2,587) and `mermaid` (123), with `scripts/publish-plugin.py` (926) beside
them as repo tooling, held up by 1,838 test functions over 25,113 lines in 64 files. Three costs of
that implementation are paid on every commit and in every session, and a fourth is paid standing.

**The local loop costs the whole suite per commit.** The `pytest` hook in
`.pre-commit-config.yaml` is `always_run` with `pass_filenames: false`, and its own comment records
the measurement: about 44 seconds under `-n auto` with the `slow` examples deselected, about 45
with them. It is `always_run` because nothing cheaper is available. The tests drive each script
black-box, as its own process under `sys.executable`, with a stub `gh` ahead of everything on
`PATH`, and coverage of those children exists only because `pyproject.toml` sets
`patch = ["subprocess"]`. There is no relation from a staged file to the tests that exercise it, so
the only scope reduction the configuration can honestly offer is the one its comment already names
as the fallback: run `tests/<plugin>/` for the plugins whose files changed, which is a heuristic a
contributor maintains by hand.

**There is no language server on plugin code.** The repository has no `.claude/settings.json`, so
no session working in this tree has one. Nothing renames a function across
`plugins/gh/scripts/lib/`, nothing resolves `from lib import cli` to a definition, and the
contracts `CLAUDE.md` calls load-bearing, "a script's exit codes and stdout are a contract with the
skills/agents that call it", are checked only by whichever test happens to assert them. A reviewer
is the type checker.

**The sharing pattern needs apparatus to work at all.** Code shared inside one plugin lives in
`plugins/<plugin>/scripts/lib/`, reached by `sys.path.insert(0, HERE)` in every script that wants
it. That is correct for a process running one plugin and wrong for pytest, which runs every
plugin's tests in one process, so `tests/conftest.py` carries `reset_plugin_lib_namespace`, which
deletes every `lib` entry from `sys.modules` and strips leftover `scripts/` and `hooks/` entries
off `sys.path` between tests. Without it the first plugin loaded in-process owns the name `lib` for
the rest of the run. `CLAUDE.md` in turn forbids changing how any script imports `lib`, which makes
the workaround a constraint on every future script. Nothing may be shared across plugins at all.
The 3.9 floor is not a choice either: it is what `/usr/bin/python3` is on a Mac with the Command
Line Tools, and ruff's `FA` rules and the `pytest-floor` CI job exist to hold it.

**Standing cost: the marketplace maintains two runtimes to ship one.** Claude Code is a Node
process. `claude plugin validate` runs from an `npm install -g`. Three of the four CI jobs install
Node, enable corepack and set up pnpm. The `mermaid` plugin's entire domain is a Node ecosystem.
Node is present wherever a plugin here can do its job; Python is a second runtime the repository
carries on top of it, with its own floor, its own package manager, its own linter and its own
coverage apparatus.

This RFC proposes moving plugin code, the hooks, ~~and `publish-plugin`~~ to TypeScript executed
directly by Node 22.18 or newer, with no build step; one root `lib/` shared into each plugin by a
committed symlink; tests co-located with the code they cover (superseded by ADR 004); and the
quality gates split so the local hooks are staged-only and CI runs everything. **Revised at
#128** (see Decisions & Follow-ups 14): `publish-plugin` is deleted rather than ported. The
runtime decision is
[ADR 001](../adr/001-typescript-on-node-22-18.md); the gate venues are
[ADR 002](../adr/002-quality-gate-venues.md).

## Motivation

**Why now, first reason: [#111](https://github.com/bje-settings/claude/issues/111) writes a whole
plugin fresh.** `workstreams` is being rebuilt on the round primitives, which is 2,587 lines
replaced by new code rather than edited. Writing that in Python means writing the largest new
surface this repository will add all year into the substrate it intends to leave, and then porting
it. The order in this RFC exists so those primitives are written once, in the target substrate.

**Why now, second reason: the same toolchain is landing next door, under the same maintainer.**
`SurveyMonkey/skills` is moving its own deterministic layer to TypeScript under its
[RFC 002](https://github.com/SurveyMonkey/skills/blob/main/docs/rfc/002-typescript-port.md) and
[ADR 012](https://github.com/SurveyMonkey/skills/blob/main/docs/adr/012-typescript-on-node-22-18.md),
across its milestones 5 and 6: Node 22.18, `tsconfig` at strict, `noEmit`, `nodenext`,
`allowImportingTsExtensions` and `erasableSyntaxOnly`, pnpm with a `packageManager` pin and
`--frozen-lockfile`, Biome, lefthook with staged-only hooks, vitest with a 100 on a 95 floor, a
harness of fixture loader, in-process `gh` mock and git repo builder, and
`typescript-lsp@claude-plugins-official` in repo settings. Every one of those configuration
decisions has been argued and paid for once. This repository can take them 1:1 and spend its
review budget on the parts that genuinely differ here, which are the parts this RFC argues: a
marketplace of several plugins rather than one, a shared library that has to cross a plugin
boundary, a downstream mirror, and a different coverage consumer.

**Why now, third reason: the cost is concentrated where the work is growing.** The 44 second hook
is 44 seconds at four plugins and 25k test lines. Milestones 4 and 5 add the largest new surface in
the repository's history, and every line of it lengthens the hook for every commit anyone makes,
because the hook cannot be narrowed. Porting before that work is the cheapest point this decision
will ever have.

**What is not the motivation.** The Python port was its own milestone, "Plugin scripts to Python",
fifteen issues, and it is closed. It moved the plugins off bash, and the discipline it produced,
the black-box test posture, branch coverage verified by mutation, the exit-code-and-stdout
contract, is what this RFC carries forward unchanged. The state being changed is not a mistake
being corrected.

## Goals / Non-Goals

**Goals**

- ~~Every plugin script, every hook, and `publish-plugin` is TypeScript, executed directly by
  Node, with no build step and no generated tree.~~ **Revised at #128** (see Decisions &
  Follow-ups 14): every plugin script and every hook is TypeScript, as above; `publish-plugin` is
  deleted rather than ported, so this goal does not apply to it.
- The runtime floor is Node 22.18, the first release whose type stripping runs unflagged and
  writes nothing to stderr (the spike recorded in
  [SurveyMonkey/skills ADR 012](https://github.com/SurveyMonkey/skills/blob/main/docs/adr/012-typescript-on-node-22-18.md)
  is the evidence; it is not re-run here).
- Code shared between plugins lives in one root `lib/`, reached from each plugin by a committed
  symlink, and nothing else crosses a plugin boundary.
- Every session working on this checkout has a TypeScript language server.
- The local hooks run on staged files only and never run a suite; CI runs everything.
- Coverage of the TypeScript source is 100 on all four buckets, with 95 as the floor the gate never
  goes below, and exclusion by name with a stated reason as the only relief.
- The behavior a user sees does not change, other than the runtime floor.

**Non-Goals**

- **No rewrite of skill prose beyond the calls it makes.** A `SKILL.md` changes where it names a
  script path or a command; what it says is not re-derived. The same holds for the agent
  definitions.
- **No version-bump gate.** No check that `plugin.json` moved when a plugin's files did. The
  reasoning, and the argument against, are in Decisions & Follow-ups.
- **No aggregate `gates` job.** The exact-name required checks stay as they are. This is a
  deliberate divergence from `SurveyMonkey/skills`, argued in Alternatives Considered.
- ~~**`field-test` is untouched until milestone 5.** It is the largest plugin and the one whose
  `harden` skill depends on the review loop `workstreams` owns, so it moves after those primitives
  exist, not before.~~ **Revised at [#138](https://github.com/bje-settings/claude/issues/138):**
  `field-test` is retired, not ported (decision 8).
- **No published npm package, no bundler, no compiled output.** The plugin ships `.ts` files that
  Node executes.
- **No change to the test discipline.** `.claude/rules/type-py.md` becomes `type-ts.md`
  ([#123](https://github.com/bje-settings/claude/issues/123)); the rules in it that are about
  Python mechanisms are rewritten, and the rules that are about testing (a test per decision arm,
  verify by mutation rather than by the number, one fixture per branch) carry over unchanged.

## Proposed Approach

### Runtime

Node 22.18 or newer, executing `.ts` files directly by type stripping. Erasable syntax only,
enforced at lint time by `tsc --erasableSyntaxOnly`, so nothing in the tree depends on a transform:
no `enum`, no parameter properties, no namespaces. Imports name the `.ts` extension explicitly.
`tsconfig.json` is strict, `noEmit`, `nodenext` for both `module` and `moduleResolution`, and
`allowImportingTsExtensions`. ADR 001 records the decision and its consequences.

The floor is stated in three places and enforced in one: `engines.node` and an `.npmrc` carrying
`use-node-version` and `engine-strict` hold it for contributors, a CI leg runs the suite on 22.18
itself, and each entry point carries a guard that exits with a named error when the running Node is
older. `@types/node` tracks the 22 line rather than the newest, so a 24-only API is a type error
here rather than a runtime error on a user's machine.

**Divergence from `SurveyMonkey/skills` RFC 002:** that repository pins CI at 24.18.0 and treats
22.18 as the documented floor. Here the floor is the leg CI runs, because the floor is what an end
user's machine will actually be, and a floor nothing executes is a claim rather than a fact. There
is no 24 matrix leg until 22 leaves LTS; the argument against that is recorded below.

### Shape

```
lib/                          # shared across plugins; the only thing that crosses a boundary
  ...
plugins/<plugin>/
  scripts/<plugin>.ts         # thin adapter: one dispatcher, parse argv, build clients, exit
  src/
    lib -> ../../../lib       # committed symlink, dereferenced into the cache copy on install
    commands/*.ts             # one exported function per command; the test seam
    commands/*.test.ts        # co-located with the code it covers
    fixtures/                 # co-located with the tests that load them
  hooks/*.ts
```

**Revised at [#205](https://github.com/bje-settings/claude/issues/205):** `src/commands/` is now
`src/subcommands/`, and the tests and fixtures live under `tests/`, outside every plugin
([ADR 004](../adr/004-plugins-ship-runtime-files-only.md)).

~~`bin/<command>.ts`: one thin adapter per command.~~ **Revised at
[#130](https://github.com/bje-settings/claude/issues/130)** (round 8 ruling 6, and Decisions &
Follow-ups 15): one ~~`bin/<plugin>.ts`~~ `scripts/<plugin>.ts` dispatcher per plugin, with an arm
per command. Every plugin that has shipped an entry point chose it, ~~`plugins/gh/bin/gh.ts`~~
`plugins/gh/scripts/gh.ts` and ~~`plugins/mermaid/bin/mermaid.ts`~~
`plugins/mermaid/scripts/mermaid.ts` (the directory revised at #185, decision 16 below), so the
RFC's wording is what drifted; `plugins/workstreams` follows the precedent rather than the
sentence.

~~The directory is `bin/`.~~ **Revised at
[#185](https://github.com/bje-settings/claude/issues/185)** (Decisions & Follow-ups 16): it is
`scripts/`, so the dispatcher is `scripts/<plugin>.ts` and the three entry points are
`plugins/gh/scripts/gh.ts`, `plugins/mermaid/scripts/mermaid.ts` and
`plugins/workstreams/scripts/workstreams.ts`. `plugins/audit/` is on another open stack (#177,
#179, #182) and follows once that lands.

`scripts/` is an adapter and nothing else: it turns `process.argv` into the command function's
arguments, constructs the real clients, calls the function, and maps its result onto an exit code
and a stream. It holds no decisions, which is what lets one spawned contract test per plugin cover
all of it.

**The command function is the seam.** Parsed arguments and injected clients go in; an exit code and
output come out. Everything a command decides is reachable in-process from a test, without a
subprocess, without a stub binary on `PATH`, and without the `patch = ["subprocess"]` coverage
apparatus that exists today only to measure children. This is the same posture the
`mattpocock/skills` [`engineering/tdd`](https://github.com/mattpocock/skills/tree/main/skills)
skill describes: find the seam, and mock only at a system boundary, by dependency injection.

**Shared code is one root `lib/`, reached by a committed symlink** at `plugins/<p>/src/lib`
pointing at `../../../lib`. The Claude Code
[plugins reference](https://code.claude.com/docs/en/plugins-reference) documents the three-way rule
its installer applies: a symlink whose target is inside the plugin is preserved, a symlink whose
target is elsewhere in the same marketplace is dereferenced into the cache copy, and a symlink
pointing outside the marketplace is skipped. The root `lib/` is the middle case, so an installed
plugin carries a real copy of the library and needs nothing at run time that the marketplace did
not ship. A spike confirmed both halves of what that requires: Node resolves `.ts` imports through
the symlink and through the dereferenced copy identically, and `claude plugin validate --strict`
passes on a plugin carrying the symlink.

~~`publish-plugin` must apply the same three-way rule when it mirrors a plugin downstream. It
refuses symlinks outright today, on the reasoning that following one would inline foreign content
and preserving one could point outside the destination. Both halves of that reasoning are answered
by classifying the target the way the installer does, and
[#128](https://github.com/bje-settings/claude/issues/128) is where that lands.~~ **Revised at
#128** (see the Publishing section below and Decisions & Follow-ups 14): `publish-plugin` is
removed rather than ported, so this question does not arise for it; the three-way rule below
governs the install path only.

**Divergence from `SurveyMonkey/skills` RFC 002:** that repository is one plugin, so its `src/lib`
is a directory and the question never arises. ~~A marketplace of four plugins has to answer it, and
the answer has to survive both the install path and the mirror.~~ **Revised at #128:** a
marketplace of four plugins still has to answer it, and now only for the install path; there is no
mirror for the answer to survive.

**Tests and fixtures are co-located**, `src/**/*.test.ts` beside the code and fixtures beside the
tests that load them. The consequence is stated plainly because it cannot be avoided: Claude Code
copies the whole plugin directory into its cache with no exclusion mechanism, no ignore file and no
manifest field, so tests and fixtures ship into the cache copy, inert. They are never imported by
anything a session runs, and nothing executes them there. ~~What the downstream mirror ships is a
different question, and `publish-plugin` filters `*.test.ts`, fixtures and `evals/` out of it,
because that copy is read by another team as the plugin's source.~~ **Revised at #128:**
`publish-plugin` is removed rather than ported, so there is no mirror-side filter to build.
**Revised at #205:** the tests and fixtures live under `tests/` now, and do not ship
([ADR 004](../adr/004-plugins-ship-runtime-files-only.md)).

**The shared test harness lives at the repository root** and is imported only from test files, so
it is never inside a plugin and never reaches a cache copy. It carries a sandbox, an in-process
`gh` mock, a git repository builder and a spawn helper for the `scripts/` contract tests.

### The testing seam

`gh` is an injected mock, not a stub binary. It is SDK-shaped: one reply registered per endpoint, a
fail switch per endpoint, and an unhandled endpoint throws rather than returning empty. That last
property is the one the current stub cannot give, and it is the difference between a test that
proves a call was made correctly and a test that passes because nothing was called.

`git` is not mocked. Tests build real temporary repositories, which is the posture
`tests/gh/README.md` already argues for and which carries over intact: assert against a real
repository rather than against a mock of git.

No call-count assertions. A test asserts the verdict the command reached and the effect it had, not
how many times it asked. Counting calls pins an implementation detail and turns a refactor into a
red suite.

Each `scripts/` entry point gets one spawned contract test, which is where the process boundary is
still real: argv in, exit code and stream out. That is the only place the suite spawns anything.

**Divergence from `SurveyMonkey/skills` RFC 002:** its test layout was left as an open question and
decided later during execution. Here it is decided in this RFC, because the cache-copy consequence
above is specific to a marketplace of installable plugins and had to be weighed before the first
plugin was laid out rather than after four were.

### Hooks

~~Both Python hook scripts port: the `gh` SessionStart hook, and `field-test`'s PreToolUse and
PostToolUse hooks, which run on every Bash call, plus its PostToolUseFailure, SubagentStop and Stop
hooks. The `command -v python3` guard each one carries becomes a silent Node floor guard: it
checks the runtime, exits quietly when it cannot run, and says nothing on the happy path, because a
hook that writes to stderr writes into every tool call.

The cost is measured rather than assumed. On the author's machine, a bare `python3` start is about
33 ms and the current `field-test` hook about 45 ms; a bare `node` start is about 42 ms and a
hook-shaped `.ts` about 70 ms. That is roughly +50 ms per Bash tool call in a session with
`field-test` installed, and nothing in a session with only `gh` installed, where the hook runs once.~~
**Revised at [#138](https://github.com/bje-settings/claude/issues/138):** only the `gh` SessionStart
hook ported; `field-test`'s hooks were deleted with the plugin, so the per-call cost above is
never paid.

**Divergence from `SurveyMonkey/skills` RFC 002:** it kept `notice-scan.sh` in bash for exactly this
cost, as a stated non-goal. Here the hooks port anyway. The reason is that a hook left in Python
keeps the entire Python toolchain alive for one file: the floor, `uv.lock`, ruff, pytest, the
`pytest-floor` job, and the subprocess coverage patch, all to avoid 50 ms on a Bash call. The
argument against is recorded in Decisions & Follow-ups, and if the measurement turns out worse in
the field than on the bench, the hook is the one thing small enough to reconsider on its own.

**Revised at [#245](https://github.com/bje-settings/claude/issues/245):** the phrase "says
nothing on the happy path" held for a hook on every tool call. There, an alert would land in
every call. It does not hold for `SessionStart`, which runs once per session. Below the node
floor, the gh hook now writes one `systemMessage` line with the floor version. The `hooks.json`
command string writes a line when `command -v node` fails, since no script can run to report
that. A hook on each tool call, such as the workstreams guard, still checks `meetsNodeFloor` and
stays silent.

### Publishing

~~`publish-plugin` ports in [#128](https://github.com/bje-settings/claude/issues/128) and keeps
every property it has: the file list comes from `git ls-files`, so what ships is what is
committed; it writes only `<dest>/plugins/<name>/`; it never commits; its exit codes stay a
contract. It gains two rules. The symlink classification above replaces the blanket refusal, and
the mirror filters `*.test.ts`, fixture directories and `evals/` so the downstream copy is the
plugin rather than the plugin plus its test corpus.~~ **Revised at #128** (see Decisions &
Follow-ups): the maintainer re-scoped #128 from a port to a deletion on 2026-09-21, once this
repository's move to public was decided, since a downstream mirror has no further use once anyone
can read the repository directly. `scripts/publish-plugin.py` and the `/publish` skill are
removed rather than ported; the symlink classification and mirror filter described above were
never built.

The `gh` plugin was the one mirrored, into `sm-incubator/org-claude` as `gh@lab`. That copy stays
at the version it was taken from, unmaintained, until this repository is public, at which point
that marketplace points here instead.

### CI

The required checks stay exact-named jobs on ruleset 22359720, matched by string. Jobs are added to
the ruleset only after the new name has reported on `main` once, and removed from the ruleset
before the pull request that drops the job merges. `ci.yml`'s header comment already documents the
adding half and `CLAUDE.md` documents both, and every ruleset edit in milestones 2 and 5 follows
them.

The Python jobs, `ruff`, `pytest`, `pytest-floor` and `coverage`, stay required for as long as
Python is in the tree~~, which is through milestone 4~~. `biome`, `types` and `vitest` are added
alongside them in milestone 2, and the Python four are dropped in
[#138](https://github.com/bje-settings/claude/issues/138). `plugin-validate` is untouched by the
port: it validates manifests, which do not change substrate.

Coverage keeps its consumer. `actions/upload-code-coverage` feeds the enterprise Code Coverage
ruleset, which requires 95% minimum coverage on every repository in the enterprise, so the report
is not decoration here. vitest adds the `cobertura` reporter beside its own thresholds; the
thresholds are the gate, and `tests/coverage_check.py` retires with the Python toolchain rather
than being reimplemented.

**Divergence from `SurveyMonkey/skills` RFC 002:** its coverage report has no consumer outside the
repository, so nothing there emits Cobertura. The two configurations differ by one reporter entry,
and that entry is load-bearing here.

## Alternatives Considered

- **Keep Python and add pyright.** The cheapest answer to the loudest symptom: it gives the tree a
  language server and a type checker without changing a line of shipped code, and a repo
  `.claude/settings.json` could turn one on this week. Rejected because it fixes one of the four
  costs. The 44 second hook
  is a property of the subprocess test posture, not of the type checker; the `sys.path` and
  `sys.modules` apparatus stays exactly as it is; the 3.9 floor stays, so the type checker runs
  against a language version chosen by Apple's Command Line Tools; and the second runtime stays,
  with a third tool added to it. It buys the smallest of the problems at the cost of making the
  toolchain larger.
- **TypeScript compiled to JavaScript, shipping the JavaScript.** The conventional answer, and it
  removes the runtime floor argument entirely, because the shipped artifact is plain `.js`.
  Rejected on two grounds specific to this repository. A build step puts a generated tree between
  the bytes a reviewer reads and the bytes that execute, in a marketplace installed directly from
  its default branch. And `publish-plugin`'s central promise, that what gets published is what is
  committed, taken from `git ls-files` rather than from walking the directory, either breaks or has
  to be re-argued around a committed build output, which is the thing that promise exists to keep
  out.
- **A per-plugin `lib/`, duplicated.** No symlink, no install-path question, no marketplace rule to
  depend on. Rejected on drift: the same envelope, the same process runner and the same `gh` client
  in four copies diverge silently, and the failure mode is a fix applied to three of them. This is
  the shape the repository has today, and it is a shape it has because Python's import system
  forced it, not because anyone chose it.
- **One plugin holding many skills.** It dissolves the sharing problem completely: one plugin, one
  `src/lib`, no symlink, no install-path rule. Rejected because it breaks the plugin-domains rule
  in `CLAUDE.md`, which exists so a user installs only the domains they need, and because it breaks
  the `sm-incubator/org-claude` mirror, which distributes `gh` alone to a team that has no business
  installing `field-test`.
- **An aggregate `gates` job as the single required check.** `SurveyMonkey/skills` does this: the
  ruleset requires one job id, and adding or dropping a leg is a change to a `needs:` list rather
  than a ruleset edit. It would remove four to seven ruleset edits from this port. Rejected because
  the aggregate collapses the checks list on a pull request to one line, so a reviewer sees "gates"
  rather than which gate is red, and because an aggregate job that is wrong about its own arity
  reports green while running nothing, which is this repository's signature bug and the reason
  `plugin-validate` carries a `found` counter. The exact-name list is longer to maintain and
  impossible to be quietly wrong about.
- **A version-bump gate.** Deferred, not rejected on the merits. The argument for it is in
  Decisions & Follow-ups alongside the argument against deferring.
- **Do nothing.** The honest baseline. Rejected on the "why now" argument: milestones 4 and 5 add
  the largest new surface this repository has taken, so doing nothing is not holding the cost
  steady, it is choosing to pay it on a larger surface, in a substrate the maintainer is leaving
  next door anyway.

## Trade-offs & Risks

- **The runtime floor is user-visible.** Anyone whose Node is below 22.18 gets a named error
  instead of a working plugin. That is deliberate and it is the cost of direct execution; the
  alternative, a stack trace from a syntax error deep inside a command, is worse. Every supported
  LTS line clears the floor.
- **Two toolchains through milestones 2 to 4.** uv, ruff and pytest coexist with pnpm, Biome and
  vitest until ~~`field-test` is the last Python in the tree and~~ #138 removes it with
  `field-test`. Contributors need both, CI runs both, and the required-check list carries both.
  This is bounded by the milestone order and by nothing else.
- **Tests and fixtures ship inertly in the cache copy.** There is no exclusion mechanism, so the
  installed plugin is larger than the plugin. It is dead weight rather than a hazard, but it is
  weight~~, and the mirror filter that keeps it out of the downstream copy is one more rule to keep
  in sync with the layout~~. **Revised at #128:** there is no mirror filter; the downstream mirror
  was frozen rather than kept clean. **Superseded at #205:** nothing test-only ships now
  ([ADR 004](../adr/004-plugins-ship-runtime-files-only.md)).
- **Symlinks need git symlink support.** A clone on Windows without `core.symlinks` gets a text
  file where `plugins/<p>/src/lib` should be, and the failure is an unresolved import rather than a
  clear message. The repository's own tooling already assumes a POSIX checkout, but this makes the
  assumption load-bearing for anyone editing plugin code.
- **Whether the local development flow gets the dereference is unsettled.** The plugins reference
  carves three install paths out of the three-way rule: with `--plugin-dir`, from a local path, or
  from a `command` source in copy mode, only symlinks resolving inside the plugin's own directory
  are preserved, and all others are skipped. The same reference also has marketplace plugins copied
  into the cache, and gives the dereference a worked example of a plugin linking to a sibling in the
  same marketplace, which is what a relative-path source is. `/plugin marketplace add ./repo`
  followed by `/plugin install <name>@bje` installs through a marketplace of relative-path sources,
  so it reads either way. If it is the carve-out, a locally installed plugin arrives without its
  root `lib/` and the local flow needs a documented step in place of the dereference. The installed
  and mirrored paths, which are the ones users take, are unaffected either way.
  [#127](https://github.com/bje-settings/claude/issues/127) is the first plugin that links the root
  lib, and settling this is in its scope.
- **A type system is not a domain check.** Nothing about TypeScript catches a shepherd that treats
  a cancelled check as pending. The mutation discipline in `.claude/rules/type-py.md` is what caught
  that, and it carries into `type-ts.md` unchanged, because it is the part of the current setup that
  is actually doing the work.
- **The port is large and it touches everything.** Mitigation is the phase order: each milestone
  leaves a working marketplace, `mermaid` is the tracer bullet at 123 lines, and `gh` is a parity
  port with an existing test suite describing what parity means.

## Rollout / Migration Plan

Four milestones, each leaving the marketplace working. The keys below are the ones the issues
carry.

**[Milestone 2: TypeScript toolchain](https://github.com/bje-settings/claude/milestone/2).** No
plugin code moves; this is the substrate arriving.

| Key | Issue | Scope |
|---|---|---|
| T1 | [#115](https://github.com/bje-settings/claude/issues/115) | This RFC, ADR 001 and ADR 002 |
| T2 | [#116](https://github.com/bje-settings/claude/issues/116) | pnpm, `package.json`, the Node 22.18 floor |
| T3 | [#117](https://github.com/bje-settings/claude/issues/117) | `tsconfig.json` and the `types` job |
| T4 | [#118](https://github.com/bje-settings/claude/issues/118) | Biome for lint and format, and the `biome` job |
| T5 | [#119](https://github.com/bje-settings/claude/issues/119) | vitest, coverage thresholds, and the enterprise coverage upload |
| T6 | [#120](https://github.com/bje-settings/claude/issues/120) | lefthook replaces pre-commit; hooks are staged-only |
| T7 | [#121](https://github.com/bje-settings/claude/issues/121) | TypeScript language server for every session on this checkout |
| T8 | [#122](https://github.com/bje-settings/claude/issues/122) | Require `biome`, `types` and `vitest` on ruleset 22359720 |
| T9 | [#123](https://github.com/bje-settings/claude/issues/123) | `CLAUDE.md` and a `type-ts.md` rule for the TypeScript layer |

**[Milestone 3: TypeScript port: mermaid and gh](https://github.com/bje-settings/claude/milestone/3).**
The harness first, then the root lib, then the smallest plugin as a tracer bullet, then the largest
parity port.

| Key | Issue | Scope |
|---|---|---|
| P1 | [#124](https://github.com/bje-settings/claude/issues/124) | Harness: sandbox, in-process `gh` mock, git repo builder, spawn helper |
| P2 | [#125](https://github.com/bje-settings/claude/issues/125) | The root `lib/` and the symlink convention |
| P3 | [#126](https://github.com/bje-settings/claude/issues/126) | Port `mermaid` (tracer bullet) |
| P4 | [#127](https://github.com/bje-settings/claude/issues/127) | Port `gh` (sync, shepherd, hook) onto the root lib |
| P5 | [#128](https://github.com/bje-settings/claude/issues/128) | ~~`publish-plugin` in TypeScript, with the symlink rule and the test filter~~ Delete `publish-plugin` and the downstream mirror instead (Decisions & Follow-ups 14) |

This milestone absorbs three open `gh` defects, each fixed as part of the port rather than fixed
twice: [#81](https://github.com/bje-settings/claude/issues/81) (the single-repo path drops the
child's exit status), [#110](https://github.com/bje-settings/claude/issues/110) (the sync hook's
session messages are agent prompts rather than deterministic status) and
[#106](https://github.com/bje-settings/claude/issues/106) (measure auto-merge latency instead of
settle's 90s constant).

**[Milestone 4: workstreams primitives](https://github.com/bje-settings/claude/milestone/4).** The
parent is [#111](https://github.com/bje-settings/claude/issues/111). The plugin is removed first
and the primitives are written into an empty directory.

| Key | Issue | Scope |
|---|---|---|
| W1 | [#129](https://github.com/bje-settings/claude/issues/129) | Remove the `workstreams` plugin |
| W2 | [#130](https://github.com/bje-settings/claude/issues/130) | Sweep (primitive 1) |
| W3 | [#131](https://github.com/bje-settings/claude/issues/131) | Question phase and plan comment (primitive 2) |
| W4 | [#132](https://github.com/bje-settings/claude/issues/132) | Stream (primitive 3) |
| W5 | [#133](https://github.com/bje-settings/claude/issues/133) | Review loop over one PR (primitive 4) |
| W6 | [#134](https://github.com/bje-settings/claude/issues/134) | Orchestrator duties (primitive 5) |
| W7 | [#135](https://github.com/bje-settings/claude/issues/135) | One real round on the primitives; decide compositions |

The primitives absorb six issues filed against the plugin being replaced:
[#96](https://github.com/bje-settings/claude/issues/96),
[#98](https://github.com/bje-settings/claude/issues/98),
[#100](https://github.com/bje-settings/claude/issues/100),
[#101](https://github.com/bje-settings/claude/issues/101),
[#102](https://github.com/bje-settings/claude/issues/102) and
[#18](https://github.com/bje-settings/claude/issues/18). Each is a requirement on the primitive
that replaces the behavior it reports, not a fix to be applied to code that is being deleted.

**[Milestone 5: field-test on TypeScript](https://github.com/bje-settings/claude/milestone/5).**
Last, because `harden` is rebuilt on the review loop W5 owns. **Revised at #138:** F1 and F2 are
closed as not planned and F3 deletes `field-test` with the Python toolchain (decision 8).

| Key | Issue | Scope |
|---|---|---|
| F1 | [#136](https://github.com/bje-settings/claude/issues/136) | Port run, collect, redact, verify, resolve, issue, enterprise, wait-pr and the hooks |
| F2 | [#137](https://github.com/bje-settings/claude/issues/137) | Rebuild `harden` on the review-loop primitive |
| F3 | [#138](https://github.com/bje-settings/claude/issues/138) | Retire the Python toolchain |

It absorbs six `field-test` issues: [#93](https://github.com/bje-settings/claude/issues/93),
[#94](https://github.com/bje-settings/claude/issues/94),
[#95](https://github.com/bje-settings/claude/issues/95),
[#74](https://github.com/bje-settings/claude/issues/74),
[#64](https://github.com/bje-settings/claude/issues/64) and
[#63](https://github.com/bje-settings/claude/issues/63).

## Open Questions

- **Is ruleset 22359720 managed in `@bje-settings/terraform`?** The enterprise `CLAUDE.md` records
  that terraform manages org settings, Actions policy, custom properties and org rulesets, and that
  `bje-co` is not yet covered; it does not say whether a repository ruleset on this repository is in
  scope. The answer decides where #122 and #138 make their edits, in HCL under review or in the
  GitHub UI. It does not change what the required-check list should contain, so it blocks neither
  milestone 2's first issues nor this RFC.
- **Does `/plugin marketplace add ./repo` dereference the root-lib symlink?** The plugins reference
  states the three-way rule for a plugin copied into the cache, and separately carves out installs
  with `--plugin-dir`, from a local path, or from a `command` source in copy mode, where only
  symlinks resolving inside the plugin's own directory survive. A marketplace added from a local
  directory sits between the two: its plugins are marketplace plugins copied into the cache, and its
  sources are relative paths. The reference does not say which rule applies, so what is open is
  whether the local flow needs a documented step in place of the dereference. #127 settles it on the
  first plugin that links the root lib. The decision on the root `lib/` is unaffected either way,
  because the installed and mirrored paths are the ones users take.

## Decisions & Follow-ups

Sixteen decisions, each with the argument against it recorded beside it. Decisions 2, 3, 4, 5, 10
and 12 are also carried by [ADR 001](../adr/001-typescript-on-node-22-18.md); decisions 1, 6, 7 and
13 by [ADR 002](../adr/002-quality-gate-venues.md).

1. **The coverage report keeps its consumer.** `actions/upload-code-coverage` stays, feeding the
   enterprise Code Coverage ruleset; vitest's own thresholds are the gate; the `cobertura` reporter
   is added for the upload; `tests/coverage_check.py` retires with Python rather than being
   reimplemented. *Against:* it makes the two repositories' vitest configs differ by one reporter
   entry, which is a divergence a future reader has to notice, and it is one of the few places
   where `SurveyMonkey/skills`'s configuration cannot be taken 1:1, because nothing there consumes
   a coverage report outside the repository and nothing there emits Cobertura at all.
2. **The Node floor is 22.18, held in three places and executed in one.** `.npmrc` with
   `use-node-version` and `engine-strict`, `engines.node` in `package.json`, one CI leg on 22.18
   itself, `@types/node` on the 22 line, and no 24 matrix leg until 22 leaves LTS. *Against:*
   nothing runs the suite on 24, so a behavioral difference between 22 and 24 would ship
   unnoticed, and users are more likely to be on 24 than on the floor.
3. **The command function is the test seam.** Parsed arguments and injected clients in, exit code
   and output out. ~~`bin/`~~ **`scripts/`** (revised at #185, decision 16 below) is a thin adapter
   with one spawned contract test per ~~command~~
   **plugin** (revised at #130, decision 15 below). `gh` is an
   injected per-endpoint mock, SDK-shaped, with one reply per endpoint, a fail switch, and an
   unhandled endpoint throwing. `git` is real temporary repositories. No call-count assertions.
   Verified against the `mattpocock/skills` `engineering/tdd` skill, which argues the same two
   rules: find the seam, and mock only at a system boundary, through dependency injection.
   *Against:* it constrains how every command is written before the first one exists, and it means
   every `gh` endpoint the plugins touch needs a typed function written up front rather than a
   command string assembled where it is used.
4. **One root `lib/`, shared by a committed symlink** at `plugins/<p>/src/lib`, dereferenced into
   the cache copy on install, ~~with `publish-plugin` applying the same three-way rule for the
   downstream mirror~~. **Revised at #128:** `publish-plugin` is removed rather than ported (the
   repository is going public, so the downstream mirror has no future); the symlink rule applies
   only to the install path now. *Against:* every plugin sees the whole library, so a change to
   `lib/` is a change to every plugin's shipped code at once, and nothing in the layout stops a
   helper that only `field-test` needs from landing where `mermaid` also carries it.
5. ~~**Both hook scripts port to TypeScript**, with a silent Node floor guard replacing
   `command -v python3`. *Against:* the measured cost is about +50 ms on every Bash tool call in a
   session with `field-test` installed, and `SurveyMonkey/skills` kept its per-call hook in bash for
   exactly this reason, as a stated non-goal of its own port.~~ **Revised at
   [#138](https://github.com/bje-settings/claude/issues/138):** only the `gh` hook ported, with the
   floor guard; `field-test`'s hooks were deleted with the plugin (decision 8). **Revised at
   [#245](https://github.com/bje-settings/claude/issues/245):** the silent guard is
   `meetsNodeFloor`, for a hook on every tool call. A `SessionStart` hook runs once, so it may
   alert. Below the floor, it writes one line with the floor version. `hooks.json`'s own command
   string writes a line when `command -v node` fails. *Against:* the node check is now shell in a
   `hooks.json` string as well as a TypeScript guard, so the alert has two places with logic
   instead of one.
6. **No version-bump gate, for now.** No check that a plugin's `plugin.json` version moved when its
   files did. *Against:* the failure it catches is silent by construction, an unbumped plugin simply
   does not update for anyone who has it installed. ~~The `sm-incubator/org-claude` mirror makes
   that failure visible to people outside this enterprise rather than only to the maintainer.~~
   **Revised at #128:** `publish-plugin` was removed rather than ported, so that mirror is now
   frozen at the version it last received and this risk no longer propagates to it; the remaining
   exposure is to whoever has installed a plugin directly from this repository.
7. **The required checks stay exact-named jobs**, and ruleset 22359720 is edited as jobs are added,
   after the new name has reported on `main` once, and as jobs are dropped, before the pull request
   that removes them merges. *Against:* that is four to seven ruleset edits across the port, and
   each one is a chance to block every pull request in the repository on a check that will never
   report.
8. ~~**`field-test` is deferred entirely until the `workstreams` primitives exist**, so uv, ruff and
   pytest coexist with the TypeScript toolchain through milestones 2 to 4. *Against:* it means the
   Python toolchain's retirement waits on #111, which is a body of work with its own risk, so the
   two-toolchain period is as long as the least predictable milestone in the plan.~~ **Revised at
   [#138](https://github.com/bje-settings/claude/issues/138):**
   `field-test` is retired rather than ported, and the Python toolchain goes with it, without
   waiting on #111; [#196](https://github.com/bje-settings/claude/issues/196) redesigns
   field-testing as an independent plugin. *Against:* whatever `field-test` caught is uncaught
   until #196 lands.
9. **The order is toolchain, then harness, then `mermaid` as a tracer bullet, then `gh` as a parity
   port that establishes the root lib, then `workstreams` written fresh as the #111 primitives.**
   *Against:* #111 is the work actually wanted, and this order puts it behind a 3,406 line parity
   port of a plugin that already works.
10. **Tests and fixtures are co-located** at `src/**/*.test.ts`, the shared harness lives at the
    repository root and is imported only from test files. ~~`publish-plugin` filters `*.test.ts`,
    fixtures and `evals/` out of the downstream mirror.~~ **Revised at #128:** there is no mirror
    left to filter for; `publish-plugin` is removed rather than ported. Claude Code copies the
    whole plugin directory into the cache with no exclusion mechanism, so tests and fixtures ship
    inertly. *Against:* the cache copy carries fixture trees for no one's benefit~~, and the mirror
    filter is one more rule that has to stay in sync with the layout, enforced by a test rather
    than by the structure~~. **Superseded at #205** by
    [ADR 004](../adr/004-plugins-ship-runtime-files-only.md): tests and fixtures live under
    `tests/`, outside every plugin, and do not ship.
11. **The records live in `docs/rfc/` and `docs/adr/`**, under the `path-docs`, `path-docs-adr` and
    `path-docs-rfc` rules copied from `SurveyMonkey/skills` unchanged. *Against:* it is a docs tree
    to maintain, with an index to keep current on every landing, in a repository that has managed
    without one by putting its reasoning in `CLAUDE.md` and in comments.
12. **Erasable syntax only**, enforced by `tsc --erasableSyntaxOnly`, with explicit `.ts` imports,
    `nodenext` for both `module` and `moduleResolution`, `allowImportingTsExtensions`, and no build
    step anywhere in the tree. *Against:* it rules out `enum`, parameter properties and namespaces,
    which are ordinary TypeScript that every other project a contributor has worked in allows, and
    it makes the substrate depend on a runtime feature younger than anything else in the toolchain,
    with a compiler flag rather than a compiler standing between the source and a launch failure.
13. **The local hooks are staged-only and never run a suite**, with lefthook replacing the
    pre-commit framework and `vitest related` resolving the module graph so the hook scales with
    the diff rather than with the repository. *Against:* a commit stops proving the suite is green,
    which is most of what the current hook is for, so a contributor can commit something CI will
    fail on; and stating it as a rule rather than as a budget forecloses running a suite locally
    even at a size where it would still be cheap.

14. **#128 is re-scoped from a port to a deletion.** The maintainer decided on 2026-09-21 (round 7
    RULINGS, ruling 1) that this repository is going public once the TypeScript port finishes, so
    the downstream mirror `publish-plugin` served has no future. `scripts/publish-plugin.py`, its
    tests and the `/publish` skill are deleted rather than ported; the publish halves of decisions
    4 and 10 above and the Publishing section under Proposed Approach are struck through
    accordingly. *Against:* the downstream mirror still has one dependent,
    `sm-incubator/org-claude`, which is left on `gh` 0.3.0 and unmaintained until this repository is
    public and that marketplace points here directly instead.

15. **One ~~`bin/<plugin>.ts`~~ `scripts/<plugin>.ts` dispatcher per plugin, not one ~~`bin`~~
    adapter per command.** Decided on
    2026-09-21 (round 8 ruling 6) and amended into "Shape" above. Both plugins that had shipped an
    entry point by then, `gh` (five arms) and `mermaid` (one), had already written it this way, so
    the RFC's `bin/<command>.ts` was a sentence nothing implemented; `.claude/rules/type-ts.md` is
    corrected with it. The plugin gets one node floor guard, one EPIPE guard and one spawned
    contract test whose examples are the arms. The directory name is revised by decision 16 below;
    the one-dispatcher decision is unchanged. *Against:* every command in a plugin then shares one
    usage string and one dispatch table, so adding a command touches a file the other commands own,
    and a caller that wants one command still installs the whole entry point.

16. **The entry point directory is `scripts/`, not `bin/`.** Decided on 2026-09-22
    ([#185](https://github.com/bje-settings/claude/issues/185)) and amended into "Shape",
    decision 3 and decision 15 above. The docs are explicit
    ([plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces#keep-executables-out-of-the-top-level-bin-directory)):
    "Don't include a top-level `bin/` directory in any plugin you distribute through organization
    settings. claude.ai rejects a plugin that has one, whether the plugin arrives by marketplace
    sync or by direct upload ... Keep executables in another directory, such as `scripts/`, and
    reference them as `${CLAUDE_PLUGIN_ROOT}/scripts/<name>` from your skills, hooks, or MCP
    server configs." Every plugin here that had shipped a TypeScript entry point shipped it at
    `bin/<plugin>.ts`, so none of the three was eligible for that distribution path at all.
    `bin/` also has a side effect nothing here wants: the
    [file locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)
    adds it to the Bash tool's `PATH` while the plugin is enabled, which makes every entry point a
    bare command in any session. `gh`, `mermaid` and `workstreams` moved with this decision;
    `plugins/audit/` is on another open stack (#177, #179, #182), is untouched here, and follows
    once that lands. *Against:* the move renames a path every skill, agent, README, hook and
    spawned contract test names, and `scripts/` is the name this repository already uses for its
    retiring Python layer and for its own root tooling, so the two meanings now share a word.

**The fresh slate is literal.** #129 removes `plugins/workstreams` and `tests/workstreams` as soon
as this RFC merges; the primitives are written into an empty directory.

Two constraints found while verifying the shape, both of which bind anything built under this RFC:

- **A plugin must never gain its own `package.json` plus lockfile.** Claude Code runs a dependency
  install inside the cache copy when it finds a `package.json` and an npm or bun lockfile, which
  turns installing a plugin into a network fetch on someone else's machine. Dependencies are
  declared once, at the repository root, and everything a plugin ships at run time is either in its
  own tree or in the root `lib/` the installer dereferenced into it.
- **The local development flow may need its own answer for the root-lib symlink.** The documented
  three-way rule has a carve-out for `--plugin-dir`, local-path and copy-mode `command` installs,
  where only symlinks inside the plugin's own directory survive, and the reference does not say
  whether a marketplace added from a local directory falls under it. #127 is the first plugin that
  links the root lib and is where that is settled.

## Related

- [Milestone 2: TypeScript toolchain](https://github.com/bje-settings/claude/milestone/2)
- [Milestone 3: TypeScript port: mermaid and gh](https://github.com/bje-settings/claude/milestone/3)
- [Milestone 4: workstreams primitives](https://github.com/bje-settings/claude/milestone/4)
- [Milestone 5: field-test on TypeScript](https://github.com/bje-settings/claude/milestone/5)
- [#111: rebuild workstreams on the round primitives](https://github.com/bje-settings/claude/issues/111)
- [ADR 001: TypeScript on Node 22.18, executed directly](../adr/001-typescript-on-node-22-18.md)
- [ADR 002: Quality gate venues](../adr/002-quality-gate-venues.md)
- [SurveyMonkey/skills RFC 002: the gh-security deterministic layer moves to TypeScript](https://github.com/SurveyMonkey/skills/blob/main/docs/rfc/002-typescript-port.md)
- [SurveyMonkey/skills ADR 012: TypeScript on Node 22.18, executed directly](https://github.com/SurveyMonkey/skills/blob/main/docs/adr/012-typescript-on-node-22-18.md)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference), for the
  symlink handling rule the root `lib/` depends on
- [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills), `engineering/tdd`, for
  the seam and dependency-injection posture in decision 3
- [Node.js: running TypeScript natively](https://nodejs.org/api/typescript.html)
