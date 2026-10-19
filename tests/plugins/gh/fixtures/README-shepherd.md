# The shepherd captures

This is a second README, rather than new rows in `README.md`. #127 layer 3's file set allows NEW
files under `plugins/gh/src/fixtures/`, but no edits to what is already here. So this file
documents the two shepherd captures. `README.md` covers the four sync captures, and still states
the rule both sets live by: nobody edits a capture after the commit that made it.

| File | What it holds |
| --- | --- |
| `shepherd-pr-output.json` | 60 runs of `plugins/gh/scripts/gh-shepherd-pr.py`, one per case. #216 removed the 7 `skip` cases the script once captured; see "What #216 removed" below. |
| `shepherd-status-output.json` | 21 runs of `plugins/gh/scripts/gh-shepherd-status.py`. |

`subcommands/shepherd-pr.*.test.ts` and `subcommands/shepherd-status.test.ts` read both.

## How they were made

The team generated this from the Python at `5da7328` (this stack's layer 2 head), before anyone
wrote a line of the port. This way, the tests check the port against the Python, never against
itself. The capture script was a pytest module. The team copied it into `tests/gh/` for the run,
then deleted it afterwards. This file commits it as text, at the end, rather than as a file of its
own. That is because layer 4 deletes `tests/gh`, and a `.py` file under `plugins/gh/src/` would
outlive the interpreter that runs it. If you run it again from the same commit, it gives the same
bytes.

```bash
cp <the script below> tests/gh/test_capture_shepherd.py
SHEPHERD_CAPTURE=<a scratch directory> uv run --locked pytest tests/gh/test_capture_shepherd.py -q
rm tests/gh/test_capture_shepherd.py
```

That run writes one JSON object per example to `$SHEPHERD_CAPTURE/lines.jsonl`. The two files here
are that stream, regrouped. The regrouping is the whole of it, so this file writes out the rule,
rather than leaving it to a script nobody kept:

- the rule splits the rows by `script`: `gh-shepherd-pr.py`'s rows go into
  `shepherd-pr-output.json`, and `gh-shepherd-status.py`'s rows go into
  `shepherd-status-output.json`.
- within a file, each row becomes one entry under its own `name`, in the order the run produced
  them. The rule drops `script` and `name` themselves.
- the one key whose spelling changes is `gh_calls`. Here the file spells it `ghCalls`, because
  everything that reads these fixtures is TypeScript.
- every other key, and every byte of every value, is the capture's own.

This step normalises nothing. `normalise`, in the script below, is the only substitution the
process makes anywhere, and it runs before the script writes the row.

Every case runs through the same fixtures the Python's own tests use: the `gh` fixture from
`tests/gh/conftest.py` (a real git repository, a canned pull-request set, and the stub `gh` from
`tests/gh/bin/gh` on `PATH`), the row builders `dep_pr` and `write_prs`, and `run_script` from
`tests/conftest.py`, which runs the script as its own process. The states are the states those
tests build. Nobody hand-writes anything here.

## What each case records

| Key | What it is |
| --- | --- |
| `argv` | The script's arguments, with the sandbox path normalised. |
| `env` | The environment variables the case set, and nothing else. |
| `prs` | The canned pull-request set the stub `gh` answered from, whole, or `null` where the case wrote none. It is the input a test registers with `harness/gh.ts`'s server to reproduce the run. |
| `status` | The exit status. |
| `stdout` | Everything the script printed, normalised. For every action this is one JSON document, `json.dumps(..., indent=2, ensure_ascii=False)` with a trailing newline. |
| `stderr` | Everything the script printed on stderr, normalised. |
| `ghCalls` | Every invocation given to the stub `gh`, in order, one per line, as `GH_FIXTURE_CALL_LOG` recorded them. This is the argv side of the contract: which endpoints it called, with which filters, and in which order. |
| `note` | Present only where argv could not drive the case; it then says what did drive it instead. |

Normalisation is `tests/gh/scenarios.py`'s `normalise`, and nothing else. The sandbox directory
(and its realpath) become `<sandbox>`. Every run of 7 to 40 hex characters becomes `<sha>`. The
process makes no other substitution, so a captured string is the Python's own bytes.

## The measured fields

The capture records `waited` (both `wait` and `settle`) and `settle`'s `reads_ok` and
`read_failures` exactly as the Python printed them. This means they measure the machine the
capture ran on. For example, `settle_reports_open_when_auto_merge_never_fires` reads
`"waited": 3`, because there a 3 second bound with a 1 second poll took 3 seconds of real time. A
loaded machine would have written 4 instead. `wait` measured the same way until #460 (see "What
#460 changed").

The capture does NOT skip them, and there is no separate list of them for the parity test to keep
in step. The port takes its clock and its sleep as arguments, and the tests pass it a fake clock
that advances instantly. The tests set that injected clock to produce the same numbers the
Python's real one did; that is what an injected clock is for. The test then compares the whole
document byte for byte, like every other key. A field that a test can no longer reproduce turns
the comparison red, rather than quietly joining some list.

## What the port deliberately says instead

Every one of these is a sentence the Python owned that now belongs to `lib/gh.ts`, or a fact the
port reaches differently. The parity test knows about each. None is a silent rewrite.

The capture also records them AS DATA, in `divergences-shepherd.json`, beside this file. That
follows layer 2's rule (`README.md`, "a divergence stays countable"): the two parity blocks read,
out of that file rather than out of a literal, which cases they do not replay, and the two
sentences they assert. So a ninth divergence needs a row there. This sits in a separate file,
rather than a section of `divergences.json`, because that one is layer 2's, and this layer's file
set allows new files here, but no edits to what is already present. The table below is the same
set, at length.

| Case | The Python | The port |
| --- | --- | --- |
| `a_directory_that_cannot_be_entered` | `cannot enter <p>: [Errno 13] Permission denied: '<p>'` | `cannot enter <p>: `, then node's own account of the same refused access. Nothing in the port changes directory (several commands share one process). So the check is an access probe, not a `chdir` that failed. |
| `gh_is_not_on_path` | `gh is required`, from a `shutil.which` preflight | the same line, off the first `gh` call's start failure (status 127). #158 ports no preflight. |
| every case where `gh` answered something unreadable | `gh answered with something that is not JSON` | `gh answered gh pr view with something that is not JSON: ...`, which is `GhError.detail` and names the call that could not be read. |
| `wait_answers_failed_*` with a log `gh` refused | `could not read the failed job's log: <words>` for a refusal, and a bare `cannot run gh: ...` for a `gh` that never started | one prefix for both, because the two are one `GhError` now; to tell them apart would mean a branch on prose. |
| `help`, `usage_with_too_few_arguments`, `an_unknown_action` | the script's own docstring, which opens `gh-shepherd-pr.py — ...` and spells `gh-shepherd-pr.py <path> <number> <action>` | the command's own usage, which opens with the same sentence and spells `gh.ts shepherd-pr <path> <number> <action>`. The test compares the line in FRONT of the usage (`unknown action: dance`) against the Python's. It compares the usage itself against this command's, and asserts that the command accepts every action it advertises. |
| `an_internal_error` | `gh-shepherd-pr.py: internal error: <type>: <message>` | `gh.ts shepherd-pr: internal error: <name>: <message>`. The file is `scripts/gh.ts` for every command now, so the line names the command. The status, 3, and the rule that nothing reaches stdout are unchanged. |

## What #216 removed

#216 removes the `skip` action and the `dependencies`-only default. It is the one exception to the
rule that nobody edits a capture. The edits remove content and add none.

- **`skip`** is gone from `shepherd-pr`. #216 deleted its seven cases from
  `shepherd-pr-output.json`: `skip_cannot_read_an_unknown_pull_request`, `skip_posts_the_reason`,
  `skip_refuses_a_pull_request_that_is_not_open`, `skip_refuses_an_empty_reason_file`,
  `skip_reports_a_comment_it_could_not_post`, `skip_with_an_empty_reason_file_argument`, and
  `skip_without_a_reason_file`. It also deleted the `ARRANGEMENTS`, `REASONS`, and `PATHS` rows
  that only these cases used, from `shepherd-pr.test-support.ts`. `parity-1.test.ts`'s own check
  (`replayable.length + NOT_REPLAYED.size === Object.keys(CAPTURE).length`) still holds. The
  seven cases are in the history of this file at `3d70469`.
- **`skipped_no_automerge`** is gone from the `shepherd-status` report. `statusDocument` now gives
  `targets` only, and a pull request without auto-merge is left out. #216 removed this key from
  the `stdout` of each case in `shepherd-status-output.json` that had it. Nothing else in a case
  changed. The replay suite keeps every case, and sends `dependencies` as the label argument, so
  each case keeps its captured semantics. The `skippedNoAutomerge` entry in
  `divergences-shepherd.json` records the change once, with no case names, because its
  `sentences` array is shared with the `shepherd-pr` parity check.

## What #460 changed

#460 adds output, so it is another exception to the rule that nobody edits a capture. The
edits change the `stdout` of a case. Nothing else in a case changed, and no case was added or
removed.

- **`baseRefName`** is the last key of each pull request object. `PULL_REQUEST_FIELDS` asks gh
  for it, and `summary` carries it, because `shepherd-pr` compares the head with that base. Each
  `pr` object in `shepherd-pr-output.json` ends with the `baseRefName` of its row (`main`). So
  does each entry of `targets` in `shepherd-status-output.json`.
- **`behind`** follows it, in each `pr` that `state` and `wait` report from an open pull request:
  `state_*` and `wait_*` cases whose `ok` is true and whose `result` is not `merged`. The replay
  answers the compare with `ahead`, because no capture recorded one, so the value is `false`.
- **`wait` polls.** It no longer runs `gh pr checks --watch`, so `watcher_rc` is gone. Two
  `wait` answers come from the first read: merged, and no checks on a head that is not behind.
  Each other `wait` adds `waited`, `reads_ok`, `read_failures`, and `read_error` at the end, as
  `settle` does. In `wait_answers_passed_from_a_green_rollup` and the four
  `wait_answers_failed_*`, `wait_keeps_*` and `wait_walks_*` cases, these are `0`, `1`, `0` and
  `""`. The four pending cases now poll every 30 seconds until the bound, and the last sleep
  stops at the bound. So `waited` is the bound: 1 in `wait_reports_pending_when_its_bound_is_hit`,
  5 in `wait_reports_the_rollup_once_the_watcher_returns`, and 540 in
  `wait_clamps_the_bound_to_the_maximum` and `wait_says_a_bound_override_was_ignored`. `reads_ok`
  is 2, 2, 19 and 19, and each `detail` names the same `waited`. The case names keep the Python's
  words.
- **`rebase` polls** for a moved head (ruling 16 on #460). Each `rebase` report that follows a
  branch update adds `waited`, `reads_ok`, `read_failures`, and `read_error` at the end. A report
  from a successful last read also adds `result` before them. No capture has a failed last
  read. `rebase_moves_the_head` reads `moved`, with `0`, `1`, `0` and `""`.
  `rebase_reports_a_branch_that_was_already_up_to_date` reads `up_to_date`, with the same four
  values, and its `detail` now says that gh reported the branch up to date.
  `rebase_reports_an_update_that_has_only_been_queued` polls every 5 seconds to the 60 second
  bound. It reads `unmoved`, `waited` 60 and `reads_ok` 13, and its `detail` names the 60
  seconds.

One sentence deliberately did NOT change, though it names a script that is now a command:
`settle`'s `there is nothing to settle, and this script never enables it`. This sentence sits
inside the JSON document, which an agent copies into its report. So it is output, not prose, and
this layer keeps output byte for byte.

The capture records `ghCalls`, but the tests do NOT compare it. The port reaches `gh` through the
injected `GhClient`. So its argv belongs to `lib/gh.ts`, and that module's own suite pins it;
comparing the stub's gh argv against it would assert the client's translation twice. `ghCalls` was
the only record of what each WRITE asked to send. The tests assert that directly instead, against
the client's own request rather than against gh argv, in `subcommands/shepherd-pr.*.test.ts`: `asks for
a rebase of the pull request it was given, and never a merge`, and `posts the words Dependabot
answers, on the pull request it was given`. Each of those two also asserts the CLIENT the request
goes through, because `--repo` is not a field of any request here: it is a construction option.
So the tests assert the repository half of `gh_calls` as `{ cwd: <target>, repository: <resolved> }`,
rather than as argv. `subcommands/shepherd-status.test.ts` does the same for its two listings. The
capture keeps the field because it is the Python's record. Apart from the #216 removals and the
#460 additions above, and the #465 additions below, nobody edits the captures.

## What #465 changed

#465 adds output too, so it is one more exception to the rule. The edits change the `stdout` of
a case. Nothing else in a case changed, and no case was added or removed. No capture recorded a
review rule. So each replay answers `requiredReviews` with no `pull_request` rule.

- **`approval` and `threads`** follow `baseRefName` in each pull request object, before
  `behind`. In `shepherd-status-output.json`, each entry of `targets` reads `not_required` for
  both. The `state_*` cases read the same. `rebase_*`, `wait_*` and `settle_*` do not read the
  rules. So their `threads` is `null`, and their `approval` comes from `reviewDecision` alone:
  `null` for `""`, `met` in `settle_keeps_waiting_on_an_approved_review`, and `missing` in
  `settle_names_both_causes_when_both_are_blocking` and
  `settle_reports_blocked_naming_the_review_decision`.
- **`not_ready`** is the last key of each `shepherd-status` document. It is `[]` in every case,
  because no rule requires a review.

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
