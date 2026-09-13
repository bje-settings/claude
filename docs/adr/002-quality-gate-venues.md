---
type: ADR
description: Local hooks run staged-only through lefthook and never run a suite, CI runs everything as exact-named jobs required by ruleset 22359720, and coverage is held at 100 on all four buckets above a 95 floor with the Cobertura report feeding the enterprise Code Coverage ruleset.
status: stable
created: 2026-09-12
owner: brianespinosa
related_milestones: [2]
---

# ADR 002: Quality gate venues

Drives [RFC 001](../rfc/001-typescript-port.md). This ADR records where each check runs once the
port changes what there is to check: what a commit waits for locally, what CI runs, which job names
the branch ruleset requires, and what happens to the coverage report.

## Context

**A commit waits for the whole suite.** The `pytest` hook in `.pre-commit-config.yaml` is
`always_run` with `pass_filenames: false`, and the comment beside it records the measurement: about
44 seconds under `-n auto` with the `slow` examples deselected, about 45 with them. It is
`always_run` because the substrate offers nothing cheaper. Tests drive each script black-box as its
own process, coverage of those children exists only through `patch = ["subprocess"]`, and there is
no relation from a staged file to the tests that exercise it, so the only scope reduction the
configuration can honestly offer is the fallback its own comment names: run `tests/<plugin>/` for
the plugins whose files changed, a mapping a contributor maintains by hand. Whatever the port does
to the test runner, it inherits this question, because a new runner will be fast at first and then
will not be.

**The required-check list is a contract kept in two places by hand.** Ruleset 22359720 requires
`ruff`, `pytest`, `pytest-floor`, `coverage` and `plugin-validate`, matched by exact string against
job names in `ci.yml` and `plugin-validate.yml`. Both workflows carry a header comment saying so,
because the failure mode is not a red build: a renamed job means the required check never reports
again and every pull request in the repository waits forever for something that will not arrive. A
port that adds three jobs and later removes four has to touch that list seven times, and each touch
has that failure available to it.

**Coverage has two consumers with different shapes, and one of them fails silently.** Locally and
in CI, `tests/coverage_check.py` reads `coverage/python.xml` and fails the job below 95, with the
per-file numbers in the log. Separately, the same file is uploaded by `actions/upload-code-coverage`
to satisfy the enterprise Code Coverage ruleset, which applies to every repository in the
enterprise and requires 95% minimum coverage. The enterprise consumer is the one that fails
quietly: a test runner that emits no Cobertura does not break a job, it just stops feeding a
ruleset that then has nothing to evaluate. Anything that replaces the Python test runner has to
answer both consumers deliberately, because only one of them will complain.

**And there is a class of failure nothing checks at all.** A plugin's files can change without its
`plugin.json` version moving, in which case nobody who has the plugin installed receives the
change. Nothing in CI looks at that today.

## Decision

**The venues split by what they can honestly scope, not by cost alone.** Local hooks run on staged
files and never run a suite. CI runs everything.

**lefthook replaces the pre-commit framework**, with staged-only hooks:
`biome check --staged`, `tsc -p` for the project, and
`vitest related --run --coverage.enabled=false {staged_files}`. `vitest related` is the thing the
current substrate could not offer: it resolves the module graph and runs the tests that actually
reach a changed file, so the hook scales with the diff rather than with the repository. The rule is
stated as a rule and not as a budget: **a hook never runs a suite.** A hook that runs everything
gets slower every time the repository grows, and the response is always to disable it, which is
worse than a hook that was never comprehensive.

The hooks are a convenience and CI is the enforcement layer, which is the split
`.pre-commit-config.yaml` already states and which does not change.

**CI runs everything, as exact-named jobs, and the ruleset requires them by name.** No aggregate
job stands in for the list. The names stay short and stable, and descriptive text goes in step
names, where it helps in a log without becoming load-bearing. Ruleset 22359720 is edited as the job
list changes, under two rules that are not symmetric and must not be made so:

- **Adding:** the job lands first, reports on `main` once, and only then is added to the ruleset. A
  required check that has never reported is a pull request that never merges.
- **Removing:** the ruleset entry goes first, before the pull request that deletes the job merges.
  A required check whose job no longer exists is the same deadlock from the other direction.

Through this port that means `biome`, `types` and `vitest` are added in milestone 2
([#122](https://github.com/bje-settings/claude/issues/122)) while `ruff`, `pytest`, `pytest-floor`
and `coverage` stay required, and the four Python jobs come off in milestone 5
([#138](https://github.com/bje-settings/claude/issues/138)) when the last Python leaves the tree.
`plugin-validate` is untouched: it validates manifests, which do not change substrate.

**Coverage is 100 on all four buckets, lines, branches, functions and statements, with 95 as the
floor the gate never goes below, and exclusion by name with a stated reason as the only relief.**
A file that genuinely cannot reach 100, a process boundary or a platform branch, is named in the
exclusion list with a comment saying why. The number is never lowered to accommodate it, because a
lowered threshold hides every other file's regression behind the one file that earned the
exception. 95 is not an arbitrary floor: it is the enterprise Code Coverage ruleset's threshold, so
going below it fails the repository at the enterprise level as well as here.

**vitest's own thresholds are the gate, and the Cobertura report is kept for the enterprise
consumer.** vitest adds the `cobertura` reporter alongside its defaults, and
`actions/upload-code-coverage` keeps uploading it. `tests/coverage_check.py` is not reimplemented;
it retires with the Python toolchain in #138, because what it does, fail a build below a threshold
with per-file numbers in the log, is what the test runner now does natively. The one property worth
carrying over explicitly is the reason that script exists at all: a threshold satisfied by an empty
file set is this repository's signature bug, the same one `plugin-validate` answers with a `found`
counter, so the coverage configuration names the source set explicitly rather than discovering it.

**No version-bump gate, for now.** No check that a plugin's `plugin.json` version moved when its
files did. It is deferred rather than refused: nothing about the port makes it harder to add later,
and the cost of adding it now is another required check and another ruleset edit in a milestone
that already has several.

## Consequences

- **Every job change is a ruleset edit, in a specific order.** Four to seven of them across this
  port, each one able to block every pull request in the repository if the order is reversed or the
  name is mistyped. The mitigation is that the rule is written down in three places that a person
  changing a job will be looking at: the `ci.yml` header comment, this ADR, and the acceptance
  criteria of #122 and #138. There is no automation behind it, and that is a known gap rather than
  an oversight; the alternative, an aggregate `gates` job requiring one name, was considered and
  rejected in RFC 001 because it collapses the checks list to one line and can report green while
  running nothing.
- **The exclusion list is the thing to watch.** A coverage policy whose relief valve is "name the
  file and say why" degrades exactly as fast as reviewers let entries accumulate. The standing
  review obligation is that the list is empty or every entry carries a reason, and that a new entry
  is argued rather than appended.
- **The Python jobs stay required until #138.** For milestones 2 through 4 the repository runs both
  toolchains and the required-check list carries seven names, so a pull request that touches
  neither substrate still waits on both. That is the cost of porting one plugin at a time, and it
  ends when `field-test` moves.
- **A commit no longer proves the suite is green.** Staged-only hooks are a smaller promise than
  the current one, deliberately: a contributor can commit something that fails a test the hook did
  not select. CI is where that is caught, which was already true for anything the hook's `-x` short
  circuited or its `-m "not slow"` deselected.
- **The version-bump failure stays silent.** Until a gate exists, a plugin whose files changed
  without a version bump simply does not update for anyone who has it installed, and the
  `sm-incubator/org-claude` mirror means that can be someone outside this enterprise. Reversing this
  decision costs one job and one ruleset edit, in that order.
