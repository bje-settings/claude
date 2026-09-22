# The hook captures

A third README beside `README.md` (the four sync captures) and `README-shepherd.md` (the two
shepherd captures), for the same reason they are separate: a capture is never edited after the
commit that made it, and neither is the file that documents it.

| File | What it holds |
| --- | --- |
| `hook-output.json` | 54 runs of `plugins/gh/hooks/hook-io.py`, one per case, plus the `syncTimeout` table. |

Read by `plugins/gh/src/commands/hook-io.test.ts` and `plugins/gh/src/hook.test.ts`, beside
`divergences-hook.json`, which is the table of what the port deliberately says instead. That file
is not a capture: it grows when a divergence is found, which is the only way a divergence stays
countable rather than dissolving into a rewritten expectation, and every row of it is read by a
test.

Three `.ts` fixtures sit here too. `deleted-cwd.ts` enters a directory, removes it and then runs
the hook, which is the only way to reach the entry point's outermost handler: `process.cwd()`
raises there and the payload has no cwd to use instead, so the failure arrives before any of the
hook's own guards are in play. `slow-entry.ts` and `quick-entry.ts` are the
other two. They stand in for `scripts/gh.ts` in the one example that measures a real
bound: one never answers, so the timeout arm is reached by the timer firing
rather than by an injected result, and one answers at once, so the same bound
must not fire. All three are programs rather than data for the reason `lib/fixtures/`'s five
are: the suite that needs them has nowhere else to put a program. `vitest.config.ts` excludes
`**/fixtures/**` from collection and from coverage, so both are linted and type-checked and never
measured.

## What the acceptance needs from it

The acceptance line on #127 is that the SessionStart hook's output is BYTE-IDENTICAL on the same
repository state. Its stdout is a JSON document Claude Code parses, so key order, the `", "` and
`": "` separators Python's `json.dump` writes, the `\uXXXX` escaping `ensure_ascii` applies to
every character outside `0x20` to `0x7e`, and the trailing newline are all contract. A test that
asserted the port's own strings would pass whatever the port printed, so the only thing asserted is
this file.

## The shape of a row

`runs` maps a case name to one run:

| Key | Meaning |
| --- | --- |
| `argv` | What followed `hook-io.py` on the command line. |
| `stdin` | What was written to the child's stdin. |
| `env` | The variables set for that run on top of the sandbox's environment. |
| `status` | The exit status. |
| `stdout` | stdout, whole, byte for byte. |
| `stderr` | stderr, whole, byte for byte. |
| `child` | Present only where the hook's fan-out branch spawns one: what `gh-sync.py --dry-run --no-install <cwd>` printed from the same state. |

`child` is what makes the hook's parity independent of the ported `sync` command's. The hook's own
contract is the decision it takes and the document it wraps the child's report in; whether `sync`
prints what `gh-sync.py` printed is layer 2's contract, pinned by `bash-sync-output.json`. So the
port's test replays `child` through an injected runner and asserts the hook's document byte for
byte, and a separate example runs the real child end to end for the wiring.

`syncTimeout` is the second table a black-box run cannot show. `sync_timeout` decides the number
printed in the timeout line, and its whole input space cannot be reached through `session-start`
without waiting out the real fifty second bound for every unparseable value, so the function and
`format(value, "g")` were asked directly, in a child running the hook as a module. Each row is
`{raw, seconds, formatted}`: the environment value, Python's `repr` of the bound it produced, and
the text the timeout line carries. It is what pins the port's `float()` grammar (`"1_000"` is
1000.0, `"0x10"` is not a number, `"２"` is 2.0, `"-inf"` is not positive so the default wins)
and Python's `%g` formatting (`1234567.0` is `1.23457e+06`).

## How it was made

Generated from the Python at `cd0d515` (this stack's layer 3 head), before a line of the hook port
was written. The capture script was a pytest module copied into `tests/gh/` for the run and deleted
afterwards. It is committed here as text rather than as a file of its own, because `tests/gh` is
deleted in the same layer and a `.py` file under `plugins/gh/src/` would outlive the interpreter
that runs it. Running it again from the same commit gives the same bytes.

```bash
cp <the script below> tests/gh/test_capture_hook.py
HOOK_CAPTURE=<a scratch directory> uv run --locked pytest \
  tests/gh/test_capture_hook.py -q -p no:cacheprovider
rm tests/gh/test_capture_hook.py
```

That run writes one JSON object per line to `$HOOK_CAPTURE/lines.jsonl`. `hook-output.json` is that
stream regrouped, and the regrouping is the whole of it, so it is written out rather than left to a
script nobody kept:

- every row but one becomes an entry under its own `name` in `runs`, in the order the run produced
  them, with `name` dropped from the entry;
- the one row named `table/sync-timeout` becomes the top-level `syncTimeout` array;
- the file is then written with `json.dumps(..., indent=2, ensure_ascii=False)` and a trailing
  newline, and formatted by biome, which touches whitespace only.

```python
import json, pathlib, collections

rows = [json.loads(line) for line in pathlib.Path("lines.jsonl").read_text("utf-8").splitlines()]
runs, timeout = collections.OrderedDict(), None
for row in rows:
    name = row.pop("name")
    if name == "table/sync-timeout":
        timeout = row["rows"]
        continue
    runs[name] = row
pathlib.Path("plugins/gh/src/fixtures/hook-output.json").write_text(
    json.dumps({"runs": runs, "syncTimeout": timeout}, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
```

## Normalisation

The two things that legitimately differ between two runs are commit hashes and the temporary
directory the fixtures were built in, and both are replaced exactly as `tests/gh/scenarios.py`
`normalise` replaces them: the sandbox path, in both its logical and its resolved spelling, becomes
`<sandbox>`, and `\b[0-9a-f]{7,40}\b` becomes `<sha>`. The port's tests substitute their own
sandbox back in before comparing.

## The capture script, verbatim

Verbatim but for line wrapping: `ruff format` reaches Python inside a fenced block in a markdown
file, and the `ruff` job in CI checks this one. It is the same program either way.

```python
"""Capture what `plugins/gh/hooks/hook-io.py` writes, one JSON row per case.

Run once, from the repository root, before a line of the hook port is written:

    cp <this file> tests/gh/test_capture_hook.py
    HOOK_CAPTURE=<a scratch directory> uv run --locked pytest \
        tests/gh/test_capture_hook.py -q -p no:randomly
    rm tests/gh/test_capture_hook.py

It writes one JSON object per line to `$HOOK_CAPTURE/lines.jsonl`. The fixture
file `plugins/gh/src/fixtures/hook-output.json` is that stream regrouped by
`name`, in the order the run produced them.

Every case records the hook's own run (`argv`, `stdin`, `env`, `status`,
`stdout`, `stderr`). A case whose hook spawns the fan-out also records the
child's run (`child`), captured from the same state by running `gh-sync.py
--dry-run --no-install <cwd>` itself, so the port's test can replay the child
rather than depend on the ported `sync` command's own parity, which is layer
2's contract and not this one's.

Paths and commit hashes are the two things that legitimately differ between two
runs, and `normalise` replaces both, exactly as `tests/gh/scenarios.py` does.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
HOOK_IO = ROOT / "plugins" / "gh" / "hooks" / "hook-io.py"
SYNC = ROOT / "plugins" / "gh" / "scripts" / "gh-sync.py"

SHA = re.compile(r"\b[0-9a-f]{7,40}\b")

OUT = Path(os.environ["HOOK_CAPTURE"])


def normalise(text, sandbox, extra=()):
    for path in [*extra, sandbox]:
        for spelling in {str(path), str(Path(path).resolve())}:
            text = text.replace(spelling, "<sandbox>" if path == sandbox else "<elsewhere>")
    return SHA.sub("<sha>", text)


def record(name, *, argv, stdin, env, result, sandbox, extra=(), child=None):
    row = {
        "name": name,
        "argv": list(argv),
        "stdin": normalise(stdin, sandbox, extra),
        "env": {key: normalise(str(value), sandbox, extra) for key, value in sorted(env.items())},
        "status": result.status,
        "stdout": normalise(result.stdout, sandbox, extra),
        "stderr": normalise(result.stderr, sandbox, extra),
    }
    if child is not None:
        row["child"] = child
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "lines.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def payload(cwd):
    return json.dumps({"session_id": "s1", "cwd": str(cwd)})


def run_child(cwd, sandbox, env=None):
    """`gh-sync.py --dry-run --no-install <cwd>`, from the same state."""
    child_env = dict(os.environ)
    if env:
        child_env.update({key: str(value) for key, value in env.items()})
    completed = subprocess.run(
        [sys.executable, str(SYNC), "--dry-run", "--no-install", str(cwd)],
        capture_output=True,
        env=child_env,
        check=False,
    )
    return {
        "argv": ["--dry-run", "--no-install", "<sandbox-cwd>"],
        "status": completed.returncode,
        "stdout": normalise(completed.stdout.decode("utf-8", "replace"), sandbox),
        "stderr": normalise(completed.stderr.decode("utf-8", "replace"), sandbox),
    }


# --- session-start, inside a git repository ----------------------------------


def hook_case(run_script, gh, name, cwd, env=None, stdin=None, child=None, **kwargs):
    text = payload(cwd) if stdin is None else stdin
    result = run_script(HOOK_IO, "session-start", stdin=text, env=env, **kwargs)
    record(
        name,
        argv=["session-start"],
        stdin=text,
        env=env or {},
        result=result,
        sandbox=gh.path,
        child=child,
    )
    return result


def test_capture_in_repo(run_script, gh):
    hook_case(run_script, gh, "in-repo/default-branch", gh.repo)

    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    hook_case(run_script, gh, "in-repo/off-default-branch", gh.repo)
    hook_case(run_script, gh, "in-repo/off-default-branch-again", gh.repo)


def test_capture_local_main_fallback(run_script, gh):
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    hook_case(run_script, gh, "in-repo/local-main-fallback", gh.repo)


def test_capture_local_master_fallback(run_script, gh):
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "branch", "-m", "main", "master")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    hook_case(run_script, gh, "in-repo/local-master-fallback", gh.repo)


def test_capture_prefers_local_main(run_script, gh):
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "branch", "master", "main")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    hook_case(run_script, gh, "in-repo/prefers-local-main", gh.repo)


def test_capture_origin_head_wins(run_script, gh):
    gh.git(gh.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    hook_case(run_script, gh, "in-repo/origin-head-wins", gh.repo)


def test_capture_origin_head_outside_the_namespace(run_script, gh):
    gh.git(gh.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/trunk")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    hook_case(run_script, gh, "in-repo/origin-head-outside-namespace", gh.repo)


def test_capture_offline(run_script, gh):
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    gh.break_origin(gh.repo)
    hook_case(run_script, gh, "in-repo/broken-origin-still-answers", gh.repo)


def test_capture_detached_head(run_script, gh):
    gh.git(gh.repo, "checkout", "-q", "--detach")
    hook_case(run_script, gh, "in-repo/detached-head", gh.repo)


def test_capture_no_default_resolves(run_script, gh):
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    gh.forget_origin_head(gh.repo)
    gh.drop_remote_branches(gh.repo)
    gh.git(gh.repo, "branch", "-D", "main")
    hook_case(run_script, gh, "in-repo/no-default-resolves", gh.repo)


# --- session-start, outside a git repository ---------------------------------


def test_capture_no_repositories(run_script, gh):
    empty = gh.path / "empty"
    empty.mkdir()
    child = run_child(empty, gh.path)
    hook_case(run_script, gh, "fan-out/no-repositories", empty, child=child)


def test_capture_everything_in_order(run_script, gh):
    fan = gh.path / "fan"
    gh.create_at(fan, "a")
    child = run_child(fan, gh.path)
    hook_case(run_script, gh, "fan-out/one-repository-in-order", fan, child=child)


def test_capture_prunable_work(run_script, gh):
    fan = gh.path / "fan"
    work = gh.create_at(fan, "a")
    gh.branch_with_work(work, "gone")
    gh.merge_commit(work, "gone")
    child = run_child(fan, gh.path)
    hook_case(run_script, gh, "fan-out/prunable-work", fan, child=child)


def test_capture_many_repositories(run_script, gh):
    fan = gh.path / "fan"
    first = gh.create_at(fan, "a")
    gh.create_at(fan, "b")
    third = gh.create_at(fan, "c")
    gh.branch_with_work(first, "gone")
    gh.merge_commit(first, "gone")
    gh.break_origin(third)
    child = run_child(fan, gh.path)
    hook_case(run_script, gh, "fan-out/many-repositories", fan, child=child)


def test_capture_degraded_lookups(run_script, gh):
    fan = gh.path / "fan"
    work = gh.create_at(fan, "a")
    gh.branch_with_work(work, "wip")
    env = {"GH_FIXTURE_FAIL": "1"}
    child = run_child(fan, gh.path, env=env)
    hook_case(run_script, gh, "fan-out/degraded-merge-lookups", fan, env=env, child=child)


def test_capture_fetch_failed(run_script, gh):
    fan = gh.path / "fan"
    work = gh.create_at(fan, "a")
    gh.break_origin(work)
    child = run_child(fan, gh.path)
    hook_case(run_script, gh, "fan-out/fetch-failed", fan, child=child)


def test_capture_nothing_actionable(run_script, gh):
    """A fan-out that ran clean: the report exists and the filter drops it."""
    fan = gh.path / "fan"
    gh.create_at(fan, "a")
    gh.create_at(fan, "b")
    child = run_child(fan, gh.path)
    hook_case(run_script, gh, "fan-out/nothing-actionable", fan, child=child)


def test_capture_fan_out_failed(run_script, gh):
    fan = gh.path / "fan"
    gh.create_at(fan, "a")
    fan.chmod(0o000)
    try:
        child = run_child(fan, gh.path)
        hook_case(run_script, gh, "fan-out/child-exited-non-zero", fan, child=child)
    finally:
        fan.chmod(0o755)


def test_capture_timeout(run_script, gh, sandbox):
    fan = gh.path / "fan"
    work = gh.create_at(fan, "a")
    gh.branch_with_work(work, "wip")
    slow = gh.path / "slow-bin"
    slow.mkdir()
    stub = slow / "gh"
    stub.write_text("#!/bin/sh\nsleep 120\n")
    stub.chmod(0o755)
    sandbox.stub_path(slow)
    hook_case(
        run_script,
        gh,
        "fan-out/timeout",
        fan,
        env={"GH_HOOK_SYNC_TIMEOUT": "0.5"},
    )


def test_capture_timeout_two_repositories(run_script, gh, sandbox):
    fan = gh.path / "fan"
    for name in ("a", "b"):
        work = gh.create_at(fan, name)
        gh.branch_with_work(work, "wip")
    slow = gh.path / "slow-bin"
    slow.mkdir()
    stub = slow / "gh"
    stub.write_text("#!/bin/sh\nsleep 120\n")
    stub.chmod(0o755)
    sandbox.stub_path(slow)
    hook_case(
        run_script,
        gh,
        "fan-out/timeout-two-repositories",
        fan,
        env={"GH_HOOK_SYNC_TIMEOUT": "1.25"},
    )


def test_capture_missing_git(run_script, gh, sandbox):
    fan = gh.path / "fan"
    gh.create_at(fan, "a")
    hook_case(
        run_script,
        gh,
        "fan-out/missing-git",
        fan,
        env={"PATH": sandbox.path_without("git")},
    )


def test_capture_missing_sync_script(run_script, gh, tmp_path):
    lonely = tmp_path / "lonely-hooks"
    lonely.mkdir()
    copy = lonely / "hook-io.py"
    shutil.copy(str(HOOK_IO), str(copy))
    empty = gh.path / "elsewhere"
    empty.mkdir()
    text = payload(empty)
    result = run_script(copy, "session-start", stdin=text)
    record(
        "fan-out/missing-entry-point",
        argv=["session-start"],
        stdin=text,
        env={},
        result=result,
        sandbox=gh.path,
        extra=[tmp_path],
    )


# --- session-start, payloads -------------------------------------------------


@pytest.fixture
def elsewhere(gh):
    place = gh.path / "elsewhere"
    place.mkdir()
    return place


def payload_case(run_script, gh, name, stdin, cwd):
    result = run_script(HOOK_IO, "session-start", stdin=stdin, cwd=cwd)
    record(
        name,
        argv=["session-start"],
        stdin=normalise(stdin, gh.path),
        env={},
        result=result,
        sandbox=gh.path,
    )


def test_capture_payloads(run_script, gh, elsewhere):
    payload_case(run_script, gh, "payload/not-json", "not json at all", elsewhere)
    payload_case(run_script, gh, "payload/empty-stdin", "", elsewhere)
    payload_case(run_script, gh, "payload/not-an-object", '["a","b"]', elsewhere)
    payload_case(
        run_script, gh, "payload/cwd-not-a-string", '{"session_id":"s1","cwd":3}', elsewhere
    )
    payload_case(
        run_script, gh, "payload/cwd-empty-string", '{"session_id":"s1","cwd":""}', elsewhere
    )
    payload_case(run_script, gh, "payload/no-cwd-key", '{"session_id":"s1"}', elsewhere)
    payload_case(
        run_script,
        gh,
        "payload/cwd-does-not-exist",
        payload(gh.path / "gone"),
        elsewhere,
    )


def test_capture_falls_back_to_the_process_cwd(run_script, gh):
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = run_script(HOOK_IO, "session-start", stdin='{"session_id":"s1"}', cwd=gh.repo)
    record(
        "payload/falls-back-to-process-cwd",
        argv=["session-start"],
        stdin='{"session_id":"s1"}',
        env={},
        result=result,
        sandbox=gh.path,
    )


# --- the three seams and the usage error -------------------------------------


def seam_case(run_script, gh, name, argv, stdin=None, env=None):
    result = run_script(HOOK_IO, *argv, stdin=stdin, env=env)
    record(
        name,
        argv=list(argv),
        stdin=stdin or "",
        env=env or {},
        result=result,
        sandbox=gh.path,
    )


def test_capture_cwd_seam(run_script, gh):
    seam_case(run_script, gh, "cwd/with-a-cwd", ["cwd"], '{"session_id":"s","cwd":"/some/where"}')
    seam_case(run_script, gh, "cwd/without-a-cwd", ["cwd"], '{"session_id":"s"}')
    seam_case(run_script, gh, "cwd/not-json", ["cwd"], "not json")
    seam_case(run_script, gh, "cwd/not-an-object", ["cwd"], '["a","b"]')
    seam_case(run_script, gh, "cwd/empty-stdin", ["cwd"], "")
    seam_case(run_script, gh, "cwd/non-ascii", ["cwd"], '{"cwd":"/tmp/café-✓"}')
    seam_case(run_script, gh, "cwd/cwd-is-null", ["cwd"], '{"cwd":null}')


def test_capture_branch_seam(run_script, gh):
    seam_case(run_script, gh, "branch/both-names", ["branch", "feature-x", "main"])
    seam_case(run_script, gh, "branch/non-ascii", ["branch", "féature-✓", "main"])
    seam_case(run_script, gh, "branch/quotes-and-backslashes", ["branch", 'a"b\\c', "main"])
    seam_case(run_script, gh, "branch/one-name", ["branch", "only-one"])
    seam_case(run_script, gh, "branch/three-names", ["branch", "a", "b", "c"])
    seam_case(run_script, gh, "branch/no-names", ["branch"])


def test_capture_report_seam(run_script, gh):
    seam_case(run_script, gh, "report/simple", ["report"], "repo-a: would delete gone")
    seam_case(run_script, gh, "report/non-ascii", ["report"], "a: ✗ fetch failed\nb: ✓ ok\n")
    seam_case(run_script, gh, "report/empty-stdin", ["report"], "")
    seam_case(run_script, gh, "report/trailing-newlines", ["report"], "one\ntwo\n\n\n")
    seam_case(run_script, gh, "report/control-characters", ["report"], "tab\there\rand\x01more")
    seam_case(
        run_script,
        gh,
        "report/single-byte-locale",
        ["report"],
        "a: ✗ fetch failed",
        env={"LC_ALL": "en_US.ISO8859-1", "PYTHONIOENCODING": "ascii"},
    )
    seam_case(run_script, gh, "report/astral", ["report"], "a: \U0001f600 done")


def test_capture_usage(run_script, gh):
    seam_case(run_script, gh, "usage/no-subcommand", [])
    seam_case(run_script, gh, "usage/unknown-subcommand", ["session_start"])
    seam_case(run_script, gh, "usage/empty-subcommand", [""])


# --- the two tables a black-box run cannot show ------------------------------


def test_capture_sync_timeout_table(run_script, gh):
    """`sync_timeout` and `format(value, "g")`, read out of the Python itself.

    The bound decides the number printed in the timeout line, and the whole of
    its input space cannot be reached through `session-start` without waiting
    out the real fifty second bound for every unparseable value. So the two
    functions are asked directly, in a child running the hook as a module, and
    the answers are a table the port's own tests read.
    """
    raw_values = [
        "",
        "soon",
        "0",
        "-3",
        "1.5",
        "50",
        " 2.5 ",
        "0.5",
        "nan",
        "inf",
        "-inf",
        "infinity",
        "Inf",
        "NaN",
        "1e3",
        "1E-2",
        "0x10",
        "1_000",
        "+4",
        ".5",
        "5.",
        "1234567",
        "0.0000001",
        "1e400",
        "２",
        "50.0",
        "true",
        "None",
    ]
    program = (
        "import importlib.util, json, os, sys\n"
        "spec = importlib.util.spec_from_file_location('h', sys.argv[1])\n"
        "module = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(module)\n"
        "rows = []\n"
        "for raw in json.loads(sys.argv[2]):\n"
        "    os.environ[module.SYNC_TIMEOUT_ENV] = raw\n"
        "    value = module.sync_timeout()\n"
        "    rows.append({'raw': raw, 'seconds': repr(value), 'formatted': format(value, 'g')})\n"
        "json.dump(rows, sys.stdout)\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", program, str(HOOK_IO), json.dumps(raw_values)],
        capture_output=True,
        check=True,
    )
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "lines.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {"name": "table/sync-timeout", "rows": json.loads(completed.stdout)},
                ensure_ascii=False,
                sort_keys=True,
            )
            + "\n"
        )
```
