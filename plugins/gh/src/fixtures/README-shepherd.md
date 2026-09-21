# The shepherd captures

A second README rather than rows in `README.md`: #127 layer 3's file set allows NEW files under
`plugins/gh/src/fixtures/` and no edits to what is already here, so this file is where the two
shepherd captures are documented. `README.md` covers the four sync captures and still describes
the rule both sets live by: a capture is never edited after the commit that made it.

| File | What it holds |
| --- | --- |
| `shepherd-pr-output.json` | 67 runs of `plugins/gh/scripts/gh-shepherd-pr.py`, one per case. |
| `shepherd-status-output.json` | 21 runs of `plugins/gh/scripts/gh-shepherd-status.py`. |

Both are read by `commands/shepherd-pr.test.ts` and `commands/shepherd-status.test.ts`.

## How they were made

Generated from the Python at `5da7328` (this stack's layer 2 head), before a line of the port was
written, so the port is checked against the Python and never against itself. The capture script was
a pytest module copied into `tests/gh/` for the run and deleted afterwards. It is committed here
as text at the end of this file rather than as a file of its own, because `tests/gh` is deleted in
layer 4 and a `.py` file under `plugins/gh/src/` would outlive the interpreter that runs it.
Running it again from the same commit gives the same bytes.

```bash
cp <the script below> tests/gh/test_capture_shepherd.py
SHEPHERD_CAPTURE=<a scratch directory> uv run --locked pytest tests/gh/test_capture_shepherd.py -q
rm tests/gh/test_capture_shepherd.py
```

That run writes one JSON object per example to `$SHEPHERD_CAPTURE/lines.jsonl`. The two files here
are that stream regrouped, and the regrouping is the whole of it, so it is written out rather than
left to a script nobody kept:

- the rows are split by `script`, `gh-shepherd-pr.py`'s into `shepherd-pr-output.json` and
  `gh-shepherd-status.py`'s into `shepherd-status-output.json`;
- within a file each row becomes one entry under its own `name`, in the order the run produced
  them, with `script` and `name` themselves dropped;
- the one key whose spelling changes is `gh_calls`, which is written `ghCalls` here, because
  everything these fixtures are read by is TypeScript;
- every other key, and every byte of every value, is the capture's own.

Nothing is normalised at this step: `normalise` in the script below is the only substitution made
anywhere, and it runs before the row is written.

Every case is driven through the same fixtures the Python's own tests use: the `gh` fixture from
`tests/gh/conftest.py` (a real git repository, a canned pull-request set, and the stub `gh` from
`tests/gh/bin/gh` on `PATH`), the row builders `dep_pr` and `write_prs`, and `run_script` from
`tests/conftest.py`, which runs the script as its own process. The states are the states those
tests build; nothing here is hand-written.

## What each case records

| Key | What it is |
| --- | --- |
| `argv` | The arguments the script was given, with the sandbox path normalised. |
| `env` | The environment variables the case set, and nothing else. |
| `prs` | The canned pull-request set the stub `gh` answered from, whole, or `null` where the case wrote none. It is the input a test registers with `harness/gh.ts`'s server to reproduce the run. |
| `status` | The exit status. |
| `stdout` | Everything the script printed, normalised. For every action this is one JSON document, `json.dumps(..., indent=2, ensure_ascii=False)` with a trailing newline. |
| `stderr` | Everything the script printed on stderr, normalised. |
| `ghCalls` | Every invocation the stub `gh` was given, in order, one per line, as `GH_FIXTURE_CALL_LOG` recorded them. This is the argv side of the contract: which endpoints were called, with which filters, and in which order. |
| `note` | Present only where the case could not be driven through argv, saying how it was driven instead. |

Normalisation is `tests/gh/scenarios.py`'s `normalise` and nothing else: the sandbox directory
(and its realpath) become `<sandbox>`, and every run of 7 to 40 hex characters becomes `<sha>`. No
other substitution is made, so a captured string is the Python's own bytes.

## The measured fields

`waited` (both `wait` and `settle`) and `settle`'s `reads_ok` and `read_failures` are recorded
exactly as the Python printed them, which means they are a measurement of the machine the capture
ran on: `settle_reports_open_when_auto_merge_never_fires` reads `"waited": 3` because a 3 second
bound with a 1 second poll took 3 seconds of real time there, and a loaded machine would have
written 4. `wait`'s `watcher_rc` where the bound fired (the Python's own 124 for a killed watcher)
and `recreate`'s `read_failures` are the same kind of number.

They are NOT skipped, and there is no list of them for the parity test to keep in step. The port
takes its clock and its sleep as arguments and the tests pass a fake that advances instantly, so
the injected clock is made to produce the numbers the Python's real one did, which is what an
injected clock is for. The whole document is then compared byte for byte like every other key: a
field that stopped being reproducible turns the comparison red rather than quietly joining a list.

## What the port deliberately says instead

Every one of these is a sentence the Python owned that now belongs to `lib/gh.ts`, or a fact the
port reaches differently. The parity test knows about each; none is a silent rewrite.

They are also recorded AS DATA, in `divergences-shepherd.json` beside this file, which is layer 2's
rule (`README.md`, "a divergence stays countable"): the two parity blocks read which cases are not
replayed, and the two sentences they assert, out of that file rather than out of a literal, so a
ninth divergence needs a row there. A separate file rather than a section of `divergences.json`
because that one is layer 2's and this layer's file set allows new files here and no edits to what
is already present. The table below is the same set, at length.

| Case | The Python | The port |
| --- | --- | --- |
| `a_directory_that_cannot_be_entered` | `cannot enter <p>: [Errno 13] Permission denied: '<p>'` | `cannot enter <p>: ` and then node's own account of the same refused access. Nothing changes directory in the port (several commands share one process), so the check is an access probe rather than a `chdir` that failed. |
| `gh_is_not_on_path` | `gh is required`, from a `shutil.which` preflight | the same line, off the first `gh` call's start failure (status 127). No preflight is ported (#158). |
| every case where `gh` answered something unreadable | `gh answered with something that is not JSON` | `gh answered gh pr view with something that is not JSON: ...`, which is `GhError.detail` and names the call that could not be read. |
| `wait_answers_failed_*` with a log `gh` refused | `could not read the failed job's log: <words>` for a refusal, and a bare `cannot run gh: ...` for a `gh` that never started | one prefix for both, because the two are one `GhError` now and telling them apart would mean branching on prose. |
| `help`, `usage_with_too_few_arguments`, `an_unknown_action` | the script's own docstring, which opens `gh-shepherd-pr.py — ...` and spells `gh-shepherd-pr.py <path> <number> <action>` | the command's own usage, which opens with the same sentence and spells `gh.ts shepherd-pr <path> <number> <action>`. The line in FRONT of the usage (`unknown action: dance`) is compared against the Python's; the usage itself is compared against this command's, and every action it advertises is asserted to be accepted. |
| `an_internal_error` | `gh-shepherd-pr.py: internal error: <type>: <message>` | `gh.ts shepherd-pr: internal error: <name>: <message>`. The file is `bin/gh.ts` for every command now, so the line names the command. The status, 3, and the rule that nothing reaches stdout are unchanged. |

One sentence deliberately did NOT change, though it names a script that is now a command:
`settle`'s `there is nothing to settle, and this script never enables it`. It is inside the JSON
document, which an agent copies into its report, so it is output rather than prose, and output is
what this layer keeps byte for byte.

`ghCalls` is recorded and is NOT compared. The port reaches `gh` through the injected `GhClient`,
so its argv is `lib/gh.ts`'s and is pinned by that module's own suite; comparing the stub's gh argv
against it would be asserting the client's translation twice. What `ghCalls` was the only record of
is what each WRITE was asked to send, and that is asserted directly instead, against the client's
own request rather than against gh argv: `asks for a rebase of the pull request it was given, and
never a merge`, `posts the words Dependabot answers, on the pull request it was given`, and `posts
the reason file it was given, as the body of the comment` in `commands/shepherd-pr.test.ts`. Each
of those three also asserts the CLIENT the request is sent through, because `--repo` is not a
field of any request here: it is a construction option, so the repository half of `gh_calls` is
asserted as `{ cwd: <target>, repository: <resolved> }` rather than as argv. `commands/
shepherd-status.test.ts` does the same for its two listings. The field is kept in the capture
because it is the Python's record and the captures are never edited.

## The capture script

```python
"""Capture the shepherd scripts' contract before #127 layer 3 ports them.

Run from the repository root with the file copied to tests/gh/:

    cp <this file> tests/gh/test_capture_shepherd.py
    SHEPHERD_CAPTURE=/tmp/capture uv run --locked pytest tests/gh/test_capture_shepherd.py -q
    rm tests/gh/test_capture_shepherd.py

Each example writes one JSON object per line to $SHEPHERD_CAPTURE/lines.jsonl;
"How they were made" above says how those become the two fixture files.
Nothing here is committed: the fixtures are.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import time
from pathlib import Path

import pytest
from conftest import SHEPHERD_PR, SHEPHERD_STATUS

OUT = Path(os.environ["SHEPHERD_CAPTURE"]) / "lines.jsonl"
SHA = re.compile(r"\b[0-9a-f]{7,40}\b")


def normalise(text, sandbox):
    for path in {str(sandbox), str(Path(sandbox).resolve())}:
        text = text.replace(path, "<sandbox>")
    return SHA.sub("<sha>", text)


def record(script, name, sandbox, argv, env, prs, result, calls, note=""):
    row = {
        "script": script,
        "name": name,
        "argv": [normalise(str(a), sandbox) for a in argv],
        "env": {k: normalise(str(v), sandbox) for k, v in sorted((env or {}).items())},
        "prs": prs,
        "status": result.status,
        "stdout": normalise(result.stdout, sandbox),
        "stderr": normalise(result.stderr, sandbox),
        "gh_calls": [normalise(line, sandbox) for line in calls],
    }
    if note:
        row["note"] = note
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_calls(path):
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def read_prs(gh):
    path = gh.path / "prs.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def run_case(gh, run_script, script, name, build):
    log = gh.path / "calls.log"
    argv, env = build(gh)
    env = dict(env or {})
    env["GH_FIXTURE_CALL_LOG"] = str(log)
    before = read_prs(gh)
    result = run_script(script, *argv, env=env)
    record(
        script.name,
        name,
        gh.path,
        argv,
        {k: v for k, v in env.items() if k != "GH_FIXTURE_CALL_LOG"},
        before,
        result,
        read_calls(log),
    )


def runs_file(gh, *specs):
    rows = []
    for spec in specs:
        parts = str(spec).split(":")
        seconds = int(parts[0])
        branch = parts[1] if len(parts) > 1 else "main"
        status = parts[2] if len(parts) > 2 else "completed"
        end = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(1767225600 + seconds))
        rows.append(
            {
                "headBranch": branch,
                "status": status,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": end,
            }
        )
    path = gh.path / "runs.json"
    path.write_text(json.dumps(rows), encoding="utf-8")
    return {"GH_FIXTURE_RUNS": str(path)}


# --------------------------------------------------------------- gh-shepherd-pr


def _plain(gh):
    plain = gh.path / "plain"
    plain.mkdir(exist_ok=True)
    return plain


def _reason(gh, text="Skipping: the failing test asserts behaviour, not a mechanical fix.\n"):
    reason = gh.path / "reason.md"
    reason.write_text(text, encoding="utf-8")
    return reason


def _log(gh, text):
    """A failed-step log for `gh run view --log-failed` to print."""
    path = gh.path / "log.txt"
    path.write_text(text, encoding="utf-8")
    return str(path)


def _only_a_number(gh):
    """An answer carrying nothing the loop decides from."""
    (gh.path / "prs.json").write_text(json.dumps([{"number": 7}]), encoding="utf-8")
    return [gh.repo, 7, "wait"]


def _rollup_null(gh):
    pull = gh.dep_pr(1, checks="pending")
    pull["statusCheckRollup"] = [None]
    gh.write_prs(pull)


PR_CASES = {
    # --- preflight and usage ---
    "usage_with_too_few_arguments": lambda gh: ([gh.repo, 1], {}),
    "help": lambda gh: (["--help"], {}),
    "a_number_that_is_not_a_number": lambda gh: ([gh.repo, "abc", "state"], {}),
    "a_path_that_is_not_a_directory": lambda gh: ([gh.path / "nope", 1, "state"], {}),
    "a_directory_that_is_not_a_git_repository": lambda gh: ([_plain(gh), 1, "state"], {}),
    "an_unknown_action": lambda gh: ([gh.repo, 1, "dance"], {}),
    "gh_cannot_resolve_the_repository": lambda gh: (
        [gh.repo, 1, "state"],
        {"GH_FIXTURE_FAIL": "1"},
    ),
    "skip_without_a_reason_file": lambda gh: ([gh.repo, 1, "skip"], {}),
    "skip_with_an_empty_reason_file_argument": lambda gh: ([gh.repo, 1, "skip", ""], {}),
    # --- state ---
    "state_reads_the_pull_request": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND")) or [gh.repo, 1, "state"],
        {},
    ),
    "state_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "state"], {}),
    "state_reads_a_rollup_holding_a_null_row": lambda gh: (
        _rollup_null(gh) or [gh.repo, 1, "state"],
        {},
    ),
    "state_says_a_log_line_override_was_ignored": lambda gh: (
        gh.write_prs(gh.dep_pr(1)) or [gh.repo, 1, "state"],
        {"SHEPHERD_LOG_LINES": "lots"},
    ),
    "state_carries_a_non_ascii_title": lambda gh: (
        gh.write_prs(dict(gh.dep_pr(1), title="build(deps): bump café — 1.0.0"))
        or [gh.repo, 1, "state"],
        {},
    ),
    # --- merged ---
    "merged_reports_the_merge_commit": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="MERGED")) or [gh.repo, 1, "merged"],
        {},
    ),
    "merged_reports_an_open_pull_request_as_not_merged": lambda gh: (
        gh.write_prs(gh.dep_pr(1)) or [gh.repo, 1, "merged"],
        {},
    ),
    "merged_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "merged"], {}),
    # --- rebase ---
    "rebase_moves_the_head": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND")) or [gh.repo, 1, "rebase"],
        {},
    ),
    "rebase_refuses_a_pull_request_that_is_not_open": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="MERGED")) or [gh.repo, 1, "rebase"],
        {},
    ),
    "rebase_reports_a_failure_without_a_new_head": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY")) or [gh.repo, 1, "rebase"],
        {"GH_FIXTURE_FAIL_REBASE": "1"},
    ),
    "rebase_reports_an_update_that_has_only_been_queued": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND")) or [gh.repo, 1, "rebase"],
        {"GH_FIXTURE_REBASE_ASYNC": "1"},
    ),
    "rebase_reports_a_branch_that_was_already_up_to_date": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND")) or [gh.repo, 1, "rebase"],
        {"GH_FIXTURE_REBASE_UPTODATE": "1"},
    ),
    "rebase_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "rebase"], {}),
    # --- recreate ---
    "recreate_refuses_a_pull_request_dependabot_did_not_author": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY", bot=False)) or [gh.repo, 1, "recreate"],
        {},
    ),
    "recreate_refuses_a_pull_request_that_is_not_open": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="CLOSED")) or [gh.repo, 1, "recreate"],
        {},
    ),
    "recreate_reports_a_comment_it_could_not_post": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY")) or [gh.repo, 1, "recreate"],
        {"GH_FIXTURE_FAIL_COMMENT": "1"},
    ),
    "recreate_gives_up_when_the_head_never_moves": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY")) or [gh.repo, 1, "recreate"],
        {"SHEPHERD_CI_SECONDS": "1", "SHEPHERD_POLL_SECONDS": "1"},
    ),
    "recreate_polls_at_least_once_when_the_ci_estimate_is_zero": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY")) or [gh.repo, 1, "recreate"],
        {"SHEPHERD_CI_SECONDS": "0", "SHEPHERD_POLL_SECONDS": "1"},
    ),
    "recreate_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "recreate"], {}),
    # --- wait ---
    "wait_answers_merged_without_watching": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="MERGED")) or [gh.repo, 1, "wait"],
        {},
    ),
    "wait_answers_passed_when_nothing_reported_a_check": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="none")) or [gh.repo, 1, "wait"],
        {},
    ),
    "wait_answers_passed_from_a_green_rollup": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="passed")) or [gh.repo, 1, "wait"],
        {},
    ),
    "wait_answers_failed_and_carries_the_log_tail": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="failed")) or [gh.repo, 1, "wait"],
        {"GH_FIXTURE_RUN_LOG": _log(gh, "line 1\nline 2\nline 3\n")},
    ),
    "wait_keeps_only_the_requested_number_of_log_lines": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="failed")) or [gh.repo, 1, "wait"],
        {
            "GH_FIXTURE_RUN_LOG": _log(gh, "line 1\nline 2\nline 3\n"),
            "SHEPHERD_LOG_LINES": "2",
        },
    ),
    "wait_walks_past_a_failing_row_that_is_not_an_actions_job": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="status-then-job-failed")) or [gh.repo, 1, "wait"],
        {"GH_FIXTURE_RUN_LOG": _log(gh, "the failing step\n")},
    ),
    "wait_answers_failed_with_no_log_for_a_status_context": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="status-failed")) or [gh.repo, 1, "wait"],
        {},
    ),
    "wait_reports_pending_when_its_bound_is_hit": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="pending")) or [gh.repo, 1, "wait"],
        {"GH_FIXTURE_WATCH_HANG": "1", "SHEPHERD_WAIT_BOUND": "1"},
    ),
    "wait_clamps_the_bound_to_the_maximum": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="pending")) or [gh.repo, 1, "wait"],
        {"SHEPHERD_CI_SECONDS": "1000"},
    ),
    "wait_reports_the_rollup_once_the_watcher_returns": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="pending")) or [gh.repo, 1, "wait"],
        {"SHEPHERD_WAIT_BOUND": "5"},
    ),
    "wait_says_a_bound_override_was_ignored": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="pending")) or [gh.repo, 1, "wait"],
        {"SHEPHERD_WAIT_BOUND": "abc"},
    ),
    "wait_refuses_an_answer_without_the_fields_the_loop_reads": lambda gh: (
        _only_a_number(gh),
        {},
    ),
    "wait_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "wait"], {}),
    # --- settle ---
    "settle_reports_merged_at_once": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="MERGED", auto=False, checks="none"))
        or [gh.repo, 1, "settle"],
        {},
    ),
    "settle_reports_blocked_naming_the_merge_state": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BLOCKED", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_reports_blocked_naming_the_review_decision": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="passed", review="REVIEW_REQUIRED"))
        or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_names_both_causes_when_both_are_blocking": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BLOCKED", checks="passed", review="CHANGES_REQUESTED"))
        or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_keeps_waiting_on_an_approved_review": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="passed", review="APPROVED"))
        or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_reports_changed_when_the_base_moved": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_reports_changed_on_a_dirty_base": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="DIRTY", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_reports_open_when_auto_merge_never_fires": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_keeps_waiting_through_a_merge_state_github_has_not_computed": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="UNKNOWN", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_accepts_a_head_that_reported_no_checks": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="none")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "3", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_refuses_without_auto_merge": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="passed", auto=False))
        or [gh.repo, 1, "settle"],
        {},
    ),
    "settle_refuses_checks_that_are_pending": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="pending")) or [gh.repo, 1, "settle"],
        {},
    ),
    "settle_refuses_checks_that_failed": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="CLEAN", checks="failed")) or [gh.repo, 1, "settle"],
        {},
    ),
    "settle_refuses_a_pull_request_that_is_closed": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="CLOSED", auto=False)) or [gh.repo, 1, "settle"],
        {},
    ),
    "settle_cannot_read_an_unknown_pull_request": lambda gh: ([gh.repo, 99, "settle"], {}),
    "settle_says_a_bound_override_was_ignored": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BLOCKED", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_BOUND": "soon", "SHEPHERD_SETTLE_POLL": "1"},
    ),
    "settle_says_a_poll_override_was_ignored": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BLOCKED", checks="passed")) or [gh.repo, 1, "settle"],
        {"SHEPHERD_SETTLE_POLL": "often", "SHEPHERD_SETTLE_BOUND": "3"},
    ),
    # --- skip ---
    "skip_posts_the_reason": lambda gh: (
        gh.write_prs(gh.dep_pr(1)) or [gh.repo, 1, "skip", _reason(gh)],
        {},
    ),
    "skip_refuses_an_empty_reason_file": lambda gh: (
        gh.write_prs(gh.dep_pr(1)) or [gh.repo, 1, "skip", _reason(gh, "")],
        {},
    ),
    "skip_refuses_a_pull_request_that_is_not_open": lambda gh: (
        gh.write_prs(gh.dep_pr(1, state="MERGED")) or [gh.repo, 1, "skip", _reason(gh, "reason\n")],
        {},
    ),
    "skip_reports_a_comment_it_could_not_post": lambda gh: (
        gh.write_prs(gh.dep_pr(1)) or [gh.repo, 1, "skip", _reason(gh, "not mechanical\n")],
        {"GH_FIXTURE_FAIL_COMMENT": "1"},
    ),
    "skip_cannot_read_an_unknown_pull_request": lambda gh: (
        [gh.repo, 99, "skip", _reason(gh, "reason\n")],
        {},
    ),
}


@pytest.mark.parametrize("name", sorted(PR_CASES))
def test_capture_shepherd_pr(gh, run_script, name):
    run_case(gh, run_script, SHEPHERD_PR, name, PR_CASES[name])


# ----------------------------------------------------------- gh-shepherd-status


STATUS_CASES = {
    "help": lambda gh: (["--help"], {}),
    "a_path_that_is_not_a_directory": lambda gh: ([gh.path / "nope"], {}),
    "a_directory_that_is_not_a_git_repository": lambda gh: ([_plain(gh)], {}),
    "gh_cannot_answer_for_the_repository": lambda gh: ([gh.repo], {"GH_FIXTURE_FAIL": "1"}),
    "no_pull_requests": lambda gh: ([gh.repo], {}),
    "targets_and_the_rest": lambda gh: (
        gh.write_prs(
            gh.dep_pr(1),
            gh.dep_pr(2, auto=False),
            gh.dep_pr(3, draft=True),
            gh.dep_pr(4, state="MERGED"),
        )
        or [gh.repo],
        {},
    ),
    "a_pull_request_without_the_dependencies_label": lambda gh: (
        gh.write_prs(gh.dep_pr(1), dict(gh.dep_pr(2), labels=[{"name": "enhancement"}]))
        or [gh.repo],
        {},
    ),
    "ordering_by_merge_risk_band": lambda gh: (
        gh.write_prs(
            gh.dep_pr(5, risk="high", created="2026-01-01T00:00:00Z"),
            gh.dep_pr(6, created="2026-01-03T00:00:00Z"),
            gh.dep_pr(7, created="2026-01-02T00:00:00Z"),
            gh.dep_pr(8, risk="medium", created="2026-01-01T00:00:00Z"),
            gh.dep_pr(9, risk="low", created="2026-01-09T00:00:00Z"),
        )
        or [gh.repo],
        {},
    ),
    "the_fields_the_loop_needs": lambda gh: (
        gh.write_prs(gh.dep_pr(1, merge="BEHIND", checks="failed")) or [gh.repo],
        {},
    ),
    "a_status_context_rollup": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="status-failed")) or [gh.repo],
        {},
    ),
    "every_conclusion_the_loop_folds": lambda gh: (
        gh.write_prs(
            gh.dep_pr(1, checks="neutral"),
            gh.dep_pr(2, checks="cancelled"),
            gh.dep_pr(3, checks="null-conclusion"),
            gh.dep_pr(4, checks="status-pending"),
            gh.dep_pr(5, checks="status-passed"),
        )
        or [gh.repo],
        {},
    ),
    "a_failure_beside_something_running": lambda gh: (
        gh.write_prs(gh.dep_pr(1, checks="mixed")) or [gh.repo],
        {},
    ),
    "a_human_author": lambda gh: (gh.write_prs(gh.dep_pr(1, bot=False)) or [gh.repo], {}),
    "the_median_of_recent_run_durations": lambda gh: (
        [gh.repo],
        runs_file(gh, 30, 900, 60, 45, 50),
    ),
    "only_completed_runs_on_the_default_branch": lambda gh: (
        [gh.repo],
        runs_file(gh, 40, 50, 60, "5000:main:in_progress", "6000:feature"),
    ),
    "a_non_positive_duration_falls_back": lambda gh: ([gh.repo], runs_file(gh, 0)),
    "a_run_listing_that_is_unavailable": lambda gh: (
        [gh.repo],
        {"GH_FIXTURE_RUNS": str(gh.path / "missing.json")},
    ),
    "a_non_ascii_title": lambda gh: (
        gh.write_prs(dict(gh.dep_pr(1), title="build(deps): bump café — 1.0.0")) or [gh.repo],
        {},
    ),
}


@pytest.mark.parametrize("name", sorted(STATUS_CASES))
def test_capture_shepherd_status(gh, run_script, name):
    run_case(gh, run_script, SHEPHERD_STATUS, name, STATUS_CASES[name])


# -------------------------------------------------- the two paths with no argv


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Captured:
    def __init__(self, status, out, err):
        self.status = status
        self.stdout = out
        self.stderr = err


def boom(*args, **kwargs):
    raise RuntimeError("boom")


def test_capture_internal_error(gh, monkeypatch, capsys):
    """Exit 3, which no argv can reach: the crash is provoked where it lives."""
    for script, name, argv in (
        (SHEPHERD_PR, "an_internal_error", [str(gh.repo), "1", "state"]),
        (SHEPHERD_STATUS, "an_internal_error", [str(gh.repo)]),
    ):
        module = _load(script, "capture_" + script.stem.replace("-", "_"))
        with monkeypatch.context() as patch:
            patch.setattr(module.os.path, "isdir", boom)
            status = module.main(argv)
        captured = capsys.readouterr()
        record(
            script.name,
            name,
            gh.path,
            argv,
            {},
            None,
            _Captured(status, captured.out, captured.err),
            [],
            note="driven in-process with os.path.isdir raising: no argv reaches exit 3",
        )


def test_capture_gh_is_required(gh, run_script, sandbox):
    """The `gh is required` preflight, with gh taken off PATH."""
    for script, argv in (
        (SHEPHERD_PR, [gh.repo, 1, "state"]),
        (SHEPHERD_STATUS, [gh.repo]),
    ):
        env = {"PATH": sandbox.path_without("gh")}
        result = run_script(script, *argv, env=env)
        record(
            script.name,
            "gh_is_not_on_path",
            gh.path,
            argv,
            {"PATH": "<a PATH with no gh on it>"},
            read_prs(gh),
            result,
            [],
        )


@pytest.mark.skipif(os.geteuid() == 0, reason="root can enter a directory with no permissions")
def test_capture_a_directory_that_cannot_be_entered(gh, run_script):
    closed = gh.path / "closed"
    closed.mkdir()
    closed.chmod(0o000)
    try:
        for script, argv in (
            (SHEPHERD_PR, [closed, 1, "state"]),
            (SHEPHERD_STATUS, [closed]),
        ):
            result = run_script(script, *argv)
            record(
                script.name,
                "a_directory_that_cannot_be_entered",
                gh.path,
                argv,
                {},
                read_prs(gh),
                result,
                [],
            )
    finally:
        closed.chmod(0o755)
```
