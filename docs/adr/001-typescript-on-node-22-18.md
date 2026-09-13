---
type: ADR
description: Plugin code runs on Node 22.18 or newer, executing erasable TypeScript directly with no build step and explicit `.ts` imports, sharing one root `lib/` through a committed symlink, with the command function as the test seam, tests co-located beside the code, and no plugin carrying its own `package.json`.
status: stable
created: 2026-09-12
owner: brianespinosa
related_milestones: [2, 3, 5]
---

# ADR 001: TypeScript on Node 22.18, executed directly

Drives [RFC 001](../rfc/001-typescript-port.md), which argues why the port happens at all. This ADR
records what a plugin is made of once it does: the runtime and its floor, how code is shared
between plugins, where the tests attach, and what a plugin may not contain.

## Context

A plugin script runs in the user's own environment, so the first question any substrate has to
answer is what that environment is guaranteed to have. This repository answered it once already and
the answer was Python, on the reasoning that a Mac with the Command Line Tools ships
`/usr/bin/python3` and an end user therefore needs to install nothing. That reasoning holds, and it
comes with a price the repository is now paying in full.

**The guaranteed Python is 3.9.** Not a version anyone chose: 3.9.6 is what Apple ships, and
because end users run the plugins with that interpreter, nothing here may resolve above it.
`pyproject.toml` records the constraint, ruff's `target-version` and `FA` rules hold the syntax to
it, and the `pytest-floor` CI job proves it on every pull request. The floor is therefore set by a
vendor's packaging decision rather than by anything about the work, and it moves when they move.

**Nothing in the tree has a language server.** There is no `.claude/settings.json` in this
repository, so no session working here gets one, and 11,082 lines of plugin code have no
go-to-definition, no rename across a plugin's `scripts/lib/`, and no type over the JSON contracts
`CLAUDE.md` calls load-bearing.

**Sharing code needs machinery, and it stops at the plugin boundary.** Each plugin reaches its own
`scripts/lib/` through `sys.path.insert(0, HERE)`, which is correct for a process running one
plugin and wrong for a test session running all of them, so `tests/conftest.py` deletes every `lib`
entry from `sys.modules` between tests. `CLAUDE.md` forbids changing how a script imports `lib` for
exactly that reason, and forbids importing across plugins at all. Code genuinely common to two
plugins has nowhere to live.

**And the environment already guarantees something else.** Claude Code is a Node process, so a Node
runtime is present wherever a plugin here can be invoked at all. `claude plugin validate`, which
gates every pull request, installs from npm. Three of the four CI jobs set up Node, corepack and
pnpm. The `mermaid` plugin's whole subject is a Node ecosystem. The repository is carrying a second
runtime, with its own floor, package manager, linter and coverage apparatus, on top of one it
cannot avoid.

What none of that settles is how TypeScript would run, and that is a real question rather than a
preference. TypeScript does not execute by itself. Either something compiles it, which puts a
generated tree between the bytes a reviewer reads and the bytes that run, in a marketplace
installed straight from its default branch, or the runtime strips the types. Node does strip types,
unflagged, from some release onward, and type stripping is not the whole of the language: syntax
with runtime meaning cannot be erased.

## Decision

**The runtime floor is Node 22.18, and plugins ship `.ts` files that Node executes directly.**

22.18 is the first release whose type stripping runs without a flag and writes nothing to stderr.
Zero bytes on stderr is the property, not merely a zero exit: a warning printed into the middle of
every command's output lands in the stderr capture a script's own contract promises. The evidence
is the spike recorded in
[SurveyMonkey/skills ADR 012](https://github.com/SurveyMonkey/skills/blob/main/docs/adr/012-typescript-on-node-22-18.md),
which measured 22.16 and 22.17 failing at launch and 22.18.0, 22.22.2, 24.15.0 and 24.18.0 all
running silently. It is cited rather than re-run: it is the same question about the same runtime,
asked by the same maintainer in a record that landed next door on the same day as this one.

**The floor is held in three places and executed in one.** `.npmrc` carries `use-node-version` and
`engine-strict`, `package.json` carries `engines.node`, and each entry point carries a guard that
exits with a named error when the running Node is older, so the failure is a sentence rather than a
syntax error. One CI leg runs the suite on 22.18 itself, because a floor nothing executes is a
claim; `@types/node` tracks the 22 line, so an API that exists only on 24 is a type error here
rather than a runtime error on a user's machine. There is no 24 matrix leg until 22 leaves LTS.

**Erasable syntax only, enforced by `tsc --erasableSyntaxOnly`.** No `enum`, no parameter
properties, no namespaces. The flag turns a class of failure that would otherwise land at launch on
a user's machine into a failure of the `types` job on a pull request. `tsconfig.json` is strict,
`noEmit`, `nodenext` for `module` and `moduleResolution`, and `allowImportingTsExtensions`; imports
name the `.ts` extension explicitly. No build step, no bundler, no generated tree, no published
package: the file a reviewer reads is the file that runs, which is also what keeps
`publish-plugin`'s promise that what ships is what is committed.

**Code shared between plugins lives in one root `lib/`, reached by a committed symlink** at
`plugins/<plugin>/src/lib` pointing at `../../../lib`. The Claude Code
[plugins reference](https://code.claude.com/docs/en/plugins-reference) documents a three-way rule:
a symlink whose target is inside the plugin is preserved, a symlink whose target is elsewhere in
the same marketplace is dereferenced into the cache copy on install, and a symlink pointing outside
the marketplace is skipped. The root `lib/` is the middle case, so an installed plugin carries a
real copy and needs nothing at run time the marketplace did not ship. A spike confirmed the two
things that depend on: Node resolves `.ts` imports through the symlink and through the dereferenced
copy identically, and `claude plugin validate --strict` passes on a plugin carrying it.
`publish-plugin` applies the same three-way classification when it mirrors a plugin downstream,
replacing the blanket symlink refusal it carries today.

**The symlink is the only path out of a plugin.** Nothing else imports across a plugin boundary,
and the repository layout test is what enforces that, the way `tests/test_repo_layout.py` enforces
the root-script rule today: a violation's failure mode is otherwise a confusing error in an
unrelated plugin's tests.

**The command function is the test seam.** A command is an exported function taking parsed
arguments and injected clients and returning an exit code and output. `bin/` is a thin adapter that
parses `process.argv`, constructs the real clients, calls the function and maps the result onto a
stream and an exit code; it holds no decisions, and one spawned contract test per command covers
it. `gh` is an injected mock rather than a stub binary on `PATH`: SDK-shaped, one reply registered
per endpoint, a fail switch per endpoint, and an unhandled endpoint throwing rather than returning
empty, which is the property a stub binary cannot give and the difference between proving a call
was made correctly and passing because nothing was called. `git` is not mocked; tests build real
temporary repositories. No test asserts a call count, because counting calls pins an implementation
detail and turns a refactor red.

**Tests and fixtures are co-located**, `src/**/*.test.ts` beside the code and fixtures beside the
tests that load them, with the shared harness at the repository root, imported only from test files
so it never sits inside a plugin. Claude Code copies the whole plugin directory into its cache with
no exclusion mechanism, no ignore file and no manifest field, so tests and fixtures reach the cache
copy and sit there inert, imported by nothing and executed by nothing. The downstream mirror is a
different audience, read by another team as the plugin's source, so `publish-plugin` filters
`*.test.ts`, fixture directories and `evals/` out of it.

**Both hook scripts port**, the `gh` SessionStart hook and `field-test`'s PreToolUse, PostToolUse,
PostToolUseFailure, SubagentStop and Stop hooks, with a silent Node floor guard replacing
`command -v python3`. Silent is the requirement: a hook writes into every tool call, so it checks
the runtime, exits quietly when it cannot run, and says nothing otherwise. The measured cost is
about +50 ms per Bash tool call in a
session with `field-test` installed, against about 33 ms for a bare `python3` start, 45 ms for the
current hook, 42 ms for a bare `node` start and 70 ms for a hook-shaped `.ts`. It is paid so that
one file does not keep an entire second toolchain alive.

**A plugin never carries its own `package.json`.** Claude Code runs an `npm install` inside the
cache copy when it finds a `package.json` and a lockfile together, which turns installing a plugin
into a network fetch on a user's machine at the moment they wanted a tool. Dependencies are
declared once, at the repository root, where they are dev and CI dependencies only. What a plugin
ships at run time is its own tree plus the root `lib/` the installer dereferenced into it, and
nothing else.

## Consequences

- **The floor is a user-visible breaking change.** Anyone below Node 22.18 gets a named error
  instead of a working plugin. That is the cost of direct execution, paid deliberately, and the
  guard exists so it is paid as a sentence rather than as a syntax error from inside a command.
  Every supported LTS line clears it, so the floor excludes no release anyone should be running.
- **The repository depends on a young runtime feature.** Type stripping is newer than anything else
  in this toolchain. `--erasableSyntaxOnly` is the containment: it keeps the source inside the
  subset the feature is specified to handle, so the exposure is a runtime regression rather than a
  source-level surprise. The single 22.18 CI leg is what would catch the former.
- **The root `lib/` is shared by everyone, so a change to it is a change to every plugin at once.**
  There is no per-plugin visibility and no mechanism to give one, which makes review the only thing
  standing between the shared library and a helper only one plugin needs. The layout test enforces
  that the symlink is the only crossing; it cannot enforce that what crosses deserves to.
- **The local development flow is carved out of the three-way rule.** The plugins reference states
  that for a plugin installed with `--plugin-dir`, from a local path, or from a `command` source in
  copy mode, only symlinks resolving inside the plugin's own directory are preserved and all others
  are skipped. `/plugin marketplace add ./repo` reads as the local-path case, so the local
  development flow most likely needs a documented step in place of the dereference; it is settled on
  the first plugin that links the root lib. Nothing about the installed or mirrored paths changes.
- **Tests and fixtures ship inertly in the cache copy.** The installed plugin is larger than the
  plugin, permanently, because there is no exclusion mechanism to ask for. The mirror filter keeps
  the downstream copy clean and is one more rule to keep in sync with the layout.
- **Symlink support becomes load-bearing for contributors.** A clone without git symlink support
  gets a text file where `plugins/<plugin>/src/lib` should be, and the symptom is an unresolved
  import rather than a message naming the cause.
- **A type system is not a domain check.** Nothing here catches a fold that treats a cancelled
  check as pending. The test discipline that caught that, a test per decision arm and verification
  by mutation rather than by the coverage number, carries over from `.claude/rules/type-py.md` into
  `type-ts.md` unchanged, because it is the part of the current setup doing the work.
