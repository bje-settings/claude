---
paths:
  - "plugins/**/*.py"
  - "scripts/**/*.py"
  - "tests/**/*.py"
---

# Plugin Python

Every plugin script here is Python: stdlib only, driven black-box by pytest, measured by
coverage.py. The rules below are what the shell harness that preceded it taught, kept because they
still apply.

## A test per decision arm

**Where the code makes a decision, every branch needs a test.** A filter that selects, a fold that
maps outcomes to a verdict, a guard that refuses — each arm needs a test that reaches it.

Branch coverage names the arms, which line coverage could not: the folds and filters that used to
live inside a `jq` program scored as one covered line however much logic they held, so a file whose
every decision was untested read as fully covered. `branch = true` is set for exactly that reason.
It still only tells you an arm was *taken*, never that the assertion was worth anything.

### Verify by mutation, not by the number

Change one arm — narrow a filter, drop a value from a match list, invert a condition — and confirm
a *specific* test goes red. If the suite stays green, the fixtures are the gap.

This is not theoretical. Three mutations of one check-state fold (narrowing the fail set so
`CANCELLED` and `TIMED_OUT` stopped counting, dropping `NEUTRAL` from the pass set, inverting the
`COMPLETED` arm) each left a 219-example suite green with coverage unmoved. The first would have
reported a cancelled build as pending and polled it forever. That fold is now
`plugins/gh/scripts/lib/shepherd.py`, one plain function per arm with its own named test.

### One fixture per branch, not per input

Values that share an arm share a test. `CANCELLED`, `TIMED_OUT` and `ACTION_REQUIRED` all land in
the same "completed but not in the pass list" arm, so one fixture covers it. What needs its own
test is each arm the code can take.

## Layout

A script lives at `plugins/<plugin>/scripts/*.py`, a hook at `plugins/<plugin>/hooks/*.py`. Code
shared inside one plugin goes in `plugins/<plugin>/scripts/lib/`, imported with
`sys.path.insert(0, HERE)` where `HERE` is the script's own directory; a hook sits one level across
rather than one level up, so it inserts the sibling `scripts/` directory instead.

Nothing imports across plugins: a user installs one plugin without the others. Tests load a
plugin's `lib` modules **by path**, under a plugin-unique module name, so the names the tests
themselves hold do not collide. That is not on its own enough: a script loaded in-process still
runs its own `from lib import ...` through `sys.modules["lib"]`, which the root `conftest.py`
resets before every test. The by-path loader is also why nothing under `lib/` imports another
`lib/` module: a module loaded by path sits outside any package, where a sibling import would not
resolve.

Test module basenames are unique across the whole suite for the same reason: pytest imports them
into one namespace, so `test_gh_fixtures.py` and `test_ws_fixtures.py`, never two
`test_fixtures.py`.

## Repo tooling: `scripts/`

`scripts/*.py` at the repo root is this repo's own tooling. It is **not** a plugin: nobody
installs it, it is not in the marketplace manifest, and `claude plugin validate` never sees it.
It is held to everything else on this page anyway, coverage gate included, because it can delete
and overwrite files in another repository.

Three things differ from a plugin script:

- **No `lib/`, and no `sys.path.insert`.** A plugin reaches its shared code that way, and the root
  `tests/conftest.py` cleans up after it by stripping leftover `sys.path` entries -- but only ones
  whose parent parts contain `plugins`. A root `scripts` entry would survive that sweep and could
  then shadow a plugin's own `lib` in a later test. So a root script is one self-contained module.
  If it needs something a plugin's `lib/` already has, inline it with a comment naming the
  canonical copy and saying why it is not imported, and cover it with tests of its own; do not
  widen `_is_leftover_plugin_entry`, whose current meaning is precise.
- **Repo-relative paths are correct here.** The rule that a literal path is a defect is about
  plugins, which must run on any machine and any layout. Repo tooling runs in this checkout, so
  `python3 scripts/<name>.py` is the right call form, and there is no `${CLAUDE_PLUGIN_ROOT}` for
  it to use instead.
- **Tests may drive it in-process.** A script that derives its own repository root from `__file__`
  cannot be pointed at a fixture by copying it, because a copy is a different file and coverage's
  relative `source` would not measure it. Load the real module by path and set its root, and keep
  a few `run_script` examples for the contracts that only exist at the process boundary. See the
  docstring in `tests/test_publish.py`.

## The 3.9 floor

3.9.6 is what a Mac with the Command Line Tools has at `/usr/bin/python3`, and end users run the
plugins with it. So: `from __future__ import annotations` in any module with a PEP 604 `X | None`
annotation, no `match`, no `datetime.UTC`. ruff's `target-version = "py39"` plus the `FA` rules
catch the syntax; they cannot catch library surface added in a later release. Only running on 3.9
does, which is what the `pytest-floor` CI job is for.

Stdlib only, always, so an end user never needs `uv` or a virtualenv to run a plugin.

## Output: UTF-8, and a closed pipe

Every script's `main` reconfigures `sys.stdout` and `sys.stderr` to `encoding="utf-8",
errors="replace"` before printing, guarded with `try`/`except (AttributeError, ValueError)`, and
flushes stdout inside the guarded region so a `BrokenPipeError` is catchable. The handler redirects
both fds to devnull and exits 0. A `✓` crashing under a non-UTF-8 locale has cost this repo time
twice; a test that runs the script with `LC_ALL=en_US.ISO8859-1` or `PYTHONIOENCODING=ascii` and
asserts exit 0 with no traceback is the check. Assert the non-ASCII characters themselves only when
they come from the script's own source: a non-ASCII file name or argv value decodes differently on
Linux, where the filesystem encoding follows the locale, than on macOS, where it is always UTF-8.

**A script that changes state finishes its work before it worries about output.** When the reader
has gone away, the print helpers catch `BrokenPipeError`, go quiet (`dup2` devnull onto stdout
once), and the script carries on; only the final flush sits in the outer handler. Test it with a
reader that closes before the run and assert every side effect still happened.

Any script that can delete or overwrite something needs a test proving both that it acts when it
should and that it refuses when it should.

## Coverage

coverage.py with `branch = true` and `patch = ["subprocess"]`: the tests run each script as its own
process, the way Claude Code runs it, and without the patch the child is not measured at all.

Every omit pattern is `**/`-prefixed. A relative pattern is made absolute against the *current*
working directory, and coverage.py re-reads the config in each subprocess it measures, so a script
that chdirs into a fixture repository before spawning a stub would resolve `tests/...` against that
repository and omit nothing. Stub tools under `tests/<plugin>/bin/` are omitted because the
subprocess patch would otherwise measure a fixture standing in for a tool as code under test.

`tests/coverage_check.py` enforces 95%, the enterprise Code Coverage ruleset's threshold, and is
itself in the denominator. Do not omit a file to move the number; omit only what is genuinely not
code under test.
