"""The shepherd paths a normal run never reaches.

Two kinds. The ones a fixture can arrange -- a `gh` that refuses one call, a
pull request that leaves OPEN for a state nobody recognises -- are driven
black-box like everything else. The rest are guards against a `gh` that cannot
be executed at all, or a reader that left mid-report, which no arrangement on
disk produces for one call and not the others; those are driven in-process, the
way `test_gh_sync.py` reaches the orchestrator's spawn failure.
"""

from __future__ import annotations

import builtins
import errno
import importlib.util
import json
import os
import subprocess

import pytest
from conftest import SHEPHERD_PR, SHEPHERD_STATUS, STUB_BIN
from test_shepherd_pr import after_call, after_comment, call_log, comments, document, set_pr

__all__ = ["call_log"]  # re-exported so the fixture resolves in this module


def load(path, name, without_lib=False, monkeypatch=None):
    """One shepherd script imported in-process.

    Their names have hyphens, so they are loaded by path rather than imported.
    `without_lib` makes the `from lib import ...` at the top fail, which is the
    only way to reach the wiring refusal against the tracked file: provoking it
    with a copy of the script in a sandbox works too, but coverage records the
    copy's path and the branch reads as untested.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    if without_lib:
        real_import = builtins.__import__

        def refuse_lib(imported, *args, **kwargs):
            if imported == "lib":
                raise ImportError("no lib here")
            return real_import(imported, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", refuse_lib)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def status_module():
    return load(SHEPHERD_STATUS, "gh_shepherd_status")


@pytest.fixture
def pr_module():
    return load(SHEPHERD_PR, "gh_shepherd_pr")


# --- the wiring refusal --------------------------------------------------------


def test_status_refuses_in_process_when_its_library_will_not_import(monkeypatch, capsys):
    module = load(SHEPHERD_STATUS, "status_no_lib", without_lib=True, monkeypatch=monkeypatch)
    assert module.shepherd is None
    assert module.streams is None
    assert module.main([]) == 2
    assert "missing" in capsys.readouterr().err


def test_pr_refuses_in_process_when_its_library_will_not_import(monkeypatch, capsys):
    module = load(SHEPHERD_PR, "pr_no_lib", without_lib=True, monkeypatch=monkeypatch)
    assert module.shepherd is None
    assert module.main([]) == 2
    assert "missing" in capsys.readouterr().err


# --- gh that cannot be run at all ---------------------------------------------


def refuse_exec(*args, **kwargs):
    """What a `gh` that resolves on PATH and cannot be exec'd raises.

    A partial install: `shutil.which` says yes and the first call fails. It
    cannot be arranged on PATH, because execvp keeps searching past a file it
    cannot execute and finds the next `gh` instead, so the guard is provoked
    where it lives.
    """
    raise OSError(errno.ENOEXEC, "Exec format error")


def test_status_treats_a_gh_that_cannot_be_run_as_a_repository_it_cannot_read(
    status_module, monkeypatch, capsys
):
    monkeypatch.setattr(status_module.subprocess, "run", refuse_exec)
    assert status_module.gh_json(["repo", "view"]) == (
        None,
        "cannot run gh: [Errno 8] Exec format error",
    )
    name, branch, problem = status_module.resolve_repo()
    assert (name, branch) == (None, None)
    assert "cannot run gh" in problem
    assert capsys.readouterr().err == ""


def test_pr_treats_a_gh_that_cannot_be_run_as_a_repository_it_cannot_read(pr_module, monkeypatch):
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    name, problem = pr_module.resolve_repo()
    assert name is None
    assert "cannot run gh" in problem


def test_read_pr_reports_a_gh_that_cannot_be_run_rather_than_raising(pr_module, monkeypatch):
    """The repository resolved and the next call could not start.

    The read is then unreadable, and the reason travels on `read_err` so a
    recreate poll can say why rather than reporting the silence as a fact.
    """
    worker = pr_module.Shepherd("acme/widgets", 1, "state", 300, 60)
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    assert worker.read_pr() is None
    assert "cannot run gh" in worker.last_read_error()


def test_gh_text_reports_a_gh_that_cannot_be_run(pr_module, monkeypatch):
    worker = pr_module.Shepherd("acme/widgets", 1, "rebase", 300, 60)
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    ok, out = worker.gh_text(["pr", "comment", "1"])
    assert ok is False
    assert "cannot run gh" in out


def test_run_bounded_reports_a_watcher_it_could_not_start(pr_module, monkeypatch):
    """127, the shell's own "could not execute", with the reason beside it.

    Outside WATCHER_CODES on purpose: a watcher that never ran said nothing
    about the checks, and `wait` refuses rather than reading the rollup as if
    one had.
    """
    monkeypatch.setattr(pr_module.subprocess, "Popen", refuse_exec)
    code, problem, waited = pr_module.run_bounded(1, ["gh", "pr", "checks"])
    assert code == 127
    assert code not in pr_module.WATCHER_CODES
    assert "cannot run gh" in problem
    assert waited == 0


def test_kill_group_falls_back_to_the_child_when_it_has_no_group(pr_module, monkeypatch):
    """A child that is already gone has no process group left to signal."""
    killed = []

    class Child:
        pid = 4242

        def kill(self):
            killed.append(True)

    monkeypatch.setattr(pr_module.os, "getpgid", lambda pid: (_ for _ in ()).throw(OSError()))
    pr_module.kill_group(Child())
    assert killed == [True]


def test_failed_log_says_gh_could_not_be_run_rather_than_reporting_no_log(pr_module, monkeypatch):
    worker = pr_module.Shepherd("acme/widgets", 1, "wait", 300, 60)
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    link = "https://github.com/acme/widgets/actions/runs/11/job/21"
    tail, problem = worker.failed_log([{"name": "build", "link": link}])
    assert tail == ""
    assert "cannot run gh" in problem


def test_failed_log_says_gh_refused_the_run_rather_than_reporting_no_log(pr_module, monkeypatch):
    """A log gh will not hand over is not the same as a job that printed nothing.

    Not a crash mid-report either: the failure is still reported, with the
    reason the agent needs to decide whether the classification can be trusted.
    """
    worker = pr_module.Shepherd("acme/widgets", 1, "wait", 300, 60)
    monkeypatch.setattr(
        pr_module.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess([], 1, b""),
    )
    link = "https://github.com/acme/widgets/actions/runs/11/job/21"
    tail, problem = worker.failed_log([{"name": "build", "link": link}])
    assert tail == ""
    assert problem == "could not read the failed job's log: gh exited 1"


def test_failed_log_walks_past_a_failing_row_that_is_not_an_actions_job(pr_module, monkeypatch):
    """A StatusContext links to its own service, which has no run log to fetch.

    One ahead of a failing Actions job must not end the search: the log the
    agent classifies from belongs to the job further down the list.
    """
    worker = pr_module.Shepherd("acme/widgets", 1, "wait", 300, 60)
    monkeypatch.setattr(
        pr_module.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess([], 0, b"the failing step\n", b""),
    )
    tail, problem = worker.failed_log(
        [
            {"name": "ci/legacy", "link": "https://ci.example/1"},
            {"name": "build", "link": "https://github.com/acme/widgets/actions/runs/11/job/21"},
        ]
    )
    assert tail == "the failing step"
    assert problem == ""


# --- gh answering with something that is not an answer ------------------------


# What a working `gh repo view --json nameWithOwner,defaultBranchRef` answers,
# for the stand-ins below that have to get past the repository resolution.
REPO_VIEW = '{"nameWithOwner": "acme/widgets", "defaultBranchRef": {"name": "main"}}'


def nonsense_gh(sandbox, script):
    """A PATH whose `gh` is the given Python source."""
    directory = sandbox.path / "odd-bin"
    directory.mkdir(exist_ok=True)
    binary = directory / "gh"
    binary.write_text("#!/usr/bin/env python3\n" + script)
    binary.chmod(0o755)
    return str(directory) + os.pathsep + os.environ["PATH"]


def wrapper_gh(sandbox, command, status, message, stdout=""):
    """A PATH whose `gh` fails one command and delegates every other to the stub.

    The stub answers from one canned set, so it cannot fail a single call and
    keep answering the rest; a wrapper in front of it can, which is what a real
    gh that reaches GitHub for `pr checks` and not for `pr view` looks like.
    """
    directory = sandbox.path / "wrap-bin"
    directory.mkdir(exist_ok=True)
    stub = str(STUB_BIN / "gh")
    binary = directory / "gh"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        f"if ' '.join(sys.argv[1:3]) == {command!r}:\n"
        f"    sys.stdout.write({stdout!r})\n"
        f"    sys.stderr.write({message!r})\n"
        f"    raise SystemExit({status})\n"
        f"os.execv({stub!r}, [{stub!r}] + sys.argv[1:])\n"
    )
    binary.chmod(0o755)
    return str(directory) + os.pathsep + os.environ["PATH"]


def test_status_treats_malformed_json_as_a_repository_it_cannot_read(gh, shepherd_status, sandbox):
    path = nonsense_gh(sandbox, "print('not json at all')\n")
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr
    assert "gh answered with something that is not JSON" in result.stderr


def test_pr_treats_malformed_json_as_a_repository_it_cannot_read(gh, shepherd_pr, sandbox):
    path = nonsense_gh(sandbox, "print('not json at all')\n")
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr
    assert "gh answered with something that is not JSON" in result.stderr


def test_pr_treats_a_repo_view_that_is_not_an_object_as_unreadable(gh, shepherd_pr, sandbox):
    path = nonsense_gh(sandbox, "print('[1, 2]')\n")
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": path})
    assert result.status == 1
    assert "gh answered with no repository object" in result.stderr


def test_pr_refuses_a_repo_view_without_a_name(gh, shepherd_pr, sandbox):
    path = nonsense_gh(sandbox, "print('{}')\n")
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": path})
    assert result.status == 1
    assert "gh answered without nameWithOwner" in result.stderr


def test_status_refuses_a_repo_view_missing_the_default_branch(gh, shepherd_status, sandbox):
    """Half an answer is not an answer: the run list needs the branch name."""
    path = nonsense_gh(sandbox, 'print(\'{"nameWithOwner": "acme/widgets"}\')\n')
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository with gh: gh answered without a default branch" in (
        result.stderr
    )


def test_status_refuses_a_repo_view_missing_the_name(gh, shepherd_status, sandbox):
    """The other half of the same answer: a branch with no repository to read it in."""
    path = nonsense_gh(sandbox, 'print(\'{"defaultBranchRef": {"name": "main"}}\')\n')
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository with gh: gh answered without nameWithOwner" in (
        result.stderr
    )


def test_status_puts_ghs_words_on_one_line_whether_they_arrive_as_bytes_or_text(status_module):
    """A multi-line message has to fit in a one-line refusal without its newlines."""
    assert status_module.one_line(b"HTTP 502\n  Bad gateway\n") == "HTTP 502 Bad gateway"
    assert status_module.one_line("HTTP 502\n  Bad gateway\n") == "HTTP 502 Bad gateway"
    assert status_module.one_line(None) == ""


def test_status_fails_closed_when_the_pull_request_listing_cannot_be_read(
    gh, shepherd_status, sandbox
):
    """The repository resolves and the listing does not: not "no pull requests"."""
    path = nonsense_gh(
        sandbox,
        f"import sys\nif sys.argv[1:3] == ['pr', 'list']:\n    sys.exit(1)\nprint({REPO_VIEW!r})\n",
    )
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not list pull requests for acme/widgets: gh exited 1" in result.stderr


def test_status_carries_ghs_own_words_when_the_listing_fails(gh, shepherd_status, sandbox):
    """A reason gh gave and a bare exit code call for different next steps."""
    path = wrapper_gh(sandbox, "pr list", 1, "HTTP 502: Bad gateway\n")
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not list pull requests for acme/widgets: HTTP 502: Bad gateway" in result.stderr


def test_status_falls_back_when_the_run_listing_is_not_a_list(gh, shepherd_status, sandbox):
    """A repo without Actions is normal; the loop only needs a wait bound."""
    path = nonsense_gh(
        sandbox,
        "import sys\n"
        "if sys.argv[1:3] == ['pr', 'list']:\n"
        "    print('[]')\n"
        "elif sys.argv[1:3] == ['run', 'list']:\n"
        "    print('null')\n"
        "else:\n"
        f"    print({REPO_VIEW!r})\n",
    )
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 0
    assert json.loads(result.stdout)["ci_seconds"] == 300


def test_read_pr_treats_a_payload_that_is_not_an_object_as_unreadable(pr_module, monkeypatch):
    """gh answering with a list where a pull request was asked for."""
    worker = pr_module.Shepherd("acme/widgets", 1, "state", 300, 60)
    monkeypatch.setattr(
        pr_module.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess([], 0, b"[]", b""),
    )
    assert worker.read_pr() is None


def test_read_pr_treats_malformed_json_as_unreadable(pr_module, monkeypatch):
    worker = pr_module.Shepherd("acme/widgets", 1, "state", 300, 60)
    monkeypatch.setattr(
        pr_module.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess([], 0, b"not json", b""),
    )
    assert worker.read_pr() is None


# --- a directory that cannot be entered ---------------------------------------


@pytest.mark.skipif(os.geteuid() == 0, reason="root can enter a directory with no permissions")
def test_status_gives_up_on_a_directory_it_cannot_enter(gh, shepherd_status):
    closed = gh.path / "closed"
    closed.mkdir()
    closed.chmod(0o000)
    try:
        result = shepherd_status(closed)
        assert result.status == 2
        assert f"cannot enter {closed}" in result.stderr
    finally:
        closed.chmod(0o755)


@pytest.mark.skipif(os.geteuid() == 0, reason="root can enter a directory with no permissions")
def test_pr_gives_up_on_a_directory_it_cannot_enter(gh, shepherd_pr):
    closed = gh.path / "closed"
    closed.mkdir()
    closed.chmod(0o000)
    try:
        result = shepherd_pr(closed, 1, "state")
        assert result.status == 2
        assert f"cannot enter {closed}" in result.stderr
    finally:
        closed.chmod(0o755)


# --- gh refusing one call -----------------------------------------------------


def test_recreate_reports_a_comment_it_could_not_post(gh, shepherd_pr, monkeypatch):
    """Nothing was asked of Dependabot, so there is nothing to poll for."""
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("GH_FIXTURE_FAIL_COMMENT", "1")
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "could not post the recreate comment" in report["detail"]
    assert comments(gh) == "NONE"


def test_skip_reports_a_comment_it_could_not_post(gh, shepherd_pr, monkeypatch):
    gh.write_prs(gh.dep_pr(1))
    reason = gh.path / "reason.md"
    reason.write_text("not mechanical\n")
    monkeypatch.setenv("GH_FIXTURE_FAIL_COMMENT", "1")
    report = document(shepherd_pr(gh.repo, 1, "skip", reason))
    assert report["ok"] is False
    assert "could not post the skip comment" in report["detail"]


def test_recreate_reports_a_pull_request_it_cannot_read_at_all(gh, shepherd_pr):
    report = document(shepherd_pr(gh.repo, 99, "recreate"))
    assert report["ok"] is False
    assert "could not read pull request #99" in report["detail"]
    assert comments(gh) == "NONE"


def test_recreate_refuses_a_state_it_does_not_recognise(gh, shepherd_pr, monkeypatch):
    """Not OPEN, not MERGED, not CLOSED: report it rather than guess at it."""
    gh.write_prs(gh.dep_pr(1, merge="DIRTY"))
    monkeypatch.setenv("SHEPHERD_CI_SECONDS", "4")
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")
    after_comment(gh, lambda: set_pr(gh, lambda row: row.update(state="ZOMBIE")))
    report = document(shepherd_pr(gh.repo, 1, "recreate"))
    assert report["ok"] is False
    assert "unexpected pull request state after recreate: 'ZOMBIE'" in report["detail"]


def test_wait_reports_a_pull_request_that_became_unreadable_during_the_watch(
    gh, shepherd_pr, call_log, monkeypatch
):
    """The watcher returned and the re-read, which is the source of truth, failed.

    The watcher is made to hang and bounded at a second, so the pull request is
    guaranteed to disappear while it is running. Gated on the call log alone the
    example raced: a watcher that returns the moment it is called can reach the
    re-read before the background thread has noticed the log line at all.
    """
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("GH_FIXTURE_WATCH_HANG", "1")
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "1")
    after_call(call_log, "pr checks", (gh.path / "prs.json").unlink)
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["ok"] is False
    assert "checks finished but the pull request could not be re-read" in report["detail"]
    assert "Could not resolve to a PullRequest" in report["detail"]


# --- poll_interval ------------------------------------------------------------


def test_a_derived_poll_interval_is_a_quarter_of_the_ci_cycle(pr_module, monkeypatch):
    monkeypatch.delenv("SHEPHERD_POLL_SECONDS", raising=False)
    assert pr_module.poll_interval(400) == 100


def test_a_derived_poll_interval_is_floored(pr_module, monkeypatch):
    """A fast repository is not polled every second just because its CI is quick."""
    monkeypatch.delenv("SHEPHERD_POLL_SECONDS", raising=False)
    assert pr_module.poll_interval(8) == pr_module.POLL_FLOOR


def test_a_given_poll_interval_is_honoured_below_the_floor(pr_module, monkeypatch):
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "1")
    assert pr_module.poll_interval(400) == 1


def test_a_poll_interval_that_is_not_a_number_falls_back_to_the_floor_and_says_so(
    pr_module, monkeypatch, capsys
):
    """A stray value in the environment must not be what decides a run.

    Nor may it do so quietly: someone set it meaning to change something.
    """
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "soon")
    assert pr_module.poll_interval(400) == pr_module.POLL_FLOOR
    assert "SHEPHERD_POLL_SECONDS=soon ignored; using 15" in capsys.readouterr().err


def test_a_zero_poll_interval_still_terminates(pr_module, monkeypatch):
    """Zero would spin without ever reaching the bound. The shell version did."""
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "0")
    assert pr_module.poll_interval(400) == 1


# --- a watcher that could not answer ------------------------------------------


def test_wait_refuses_when_the_watcher_failed_for_a_reason_of_its_own(
    gh, shepherd_pr, sandbox, monkeypatch
):
    """gh exiting outside its check codes said nothing about the checks.

    Reported as `pending` -- which is what an unread exit code came out as --
    the caller waits out an expired token or a 502 one CI cycle at a time,
    forever, and the transcript never says why.
    """
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "5")
    path = wrapper_gh(sandbox, "pr checks", 4, "HTTP 502: Bad gateway\n")
    report = document(shepherd_pr(gh.repo, 1, "wait", env={"PATH": path}))
    assert report["ok"] is False
    assert report["detail"] == "watcher failed after 0s: HTTP 502: Bad gateway"
    assert report["watcher_rc"] == 4
    assert "result" not in report


def test_wait_still_decides_from_the_rollup_when_the_watcher_reports_a_failed_check(
    gh, shepherd_pr, sandbox, monkeypatch
):
    """Exit 1 is gh's "a check failed", not gh failing, so the rollup still decides.

    It is the code a real `gh pr checks` uses for both, which is why it is in
    the set the wait reads through rather than refuses on.
    """
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "5")
    path = wrapper_gh(sandbox, "pr checks", 1, "some check failed\n")
    report = document(shepherd_pr(gh.repo, 1, "wait", env={"PATH": path}))
    assert report["ok"] is True
    assert report["result"] == "pending"
    assert report["watcher_rc"] == 1


def test_wait_reports_a_log_gh_would_not_hand_over(gh, shepherd_pr, sandbox):
    """An empty tail and a tail gh refused are not the same evidence.

    The agent classifies the failure from this text and decides between a fix
    and a skip; "the job printed nothing" would send it the wrong way.
    """
    gh.write_prs(gh.dep_pr(1, checks="failed"))
    path = wrapper_gh(sandbox, "run view", 1, "HTTP 502: Bad gateway\n")
    report = document(shepherd_pr(gh.repo, 1, "wait", env={"PATH": path}))
    assert report["result"] == "failed"
    assert report["log_tail"] == ""
    assert report["log_error"] == "could not read the failed job's log: HTTP 502: Bad gateway"


# --- a read that failed, and why ----------------------------------------------


def test_pr_carries_ghs_own_words_when_the_pull_request_cannot_be_read(gh, shepherd_pr, sandbox):
    """The repository resolves and the pull request read does not."""
    gh.write_prs(gh.dep_pr(1))
    path = wrapper_gh(sandbox, "pr view", 1, "HTTP 502: Bad gateway\n")
    report = document(shepherd_pr(gh.repo, 1, "state", env={"PATH": path}))
    assert report["ok"] is False
    assert report["detail"] == "could not read pull request #1: HTTP 502: Bad gateway"


def test_pr_says_gh_answered_with_something_that_is_not_json(gh, shepherd_pr, sandbox):
    gh.write_prs(gh.dep_pr(1))
    path = wrapper_gh(sandbox, "pr view", 0, "", stdout="not json at all\n")
    report = document(shepherd_pr(gh.repo, 1, "state", env={"PATH": path}))
    assert report["ok"] is False
    assert "gh answered with something that is not JSON" in report["detail"]


def test_pr_falls_back_to_a_reason_when_gh_failed_without_saying_anything(gh, shepherd_pr, sandbox):
    """A non-zero exit and an empty stderr still has to name something."""
    gh.write_prs(gh.dep_pr(1))
    path = wrapper_gh(sandbox, "pr view", 3, "")
    report = document(shepherd_pr(gh.repo, 1, "state", env={"PATH": path}))
    assert report["detail"] == "could not read pull request #1: gh exited 3"


def test_rebase_reports_an_update_that_worked_and_a_read_that_did_not(gh, shepherd_pr, sandbox):
    """The branch update happened; only the confirmation of it did not.

    `ok: false` here would have the caller decide again and rebase a second
    time, which costs another CI run for a read that failed.
    """
    gh.write_prs(gh.dep_pr(1, merge="BEHIND"))
    marker = gh.path / "answered"
    stub = str(STUB_BIN / "gh")
    directory = sandbox.path / "half-bin"
    directory.mkdir(exist_ok=True)
    binary = directory / "gh"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import os, subprocess, sys\n"
        "argv = sys.argv[1:]\n"
        "command = ' '.join(argv[:2])\n"
        f"if command == 'pr view' and os.path.exists({str(marker)!r}):\n"
        "    sys.stderr.write('HTTP 502: Bad gateway\\n')\n"
        "    raise SystemExit(1)\n"
        f"code = subprocess.call([{stub!r}] + argv)\n"
        "if command == 'pr update-branch':\n"
        f"    open({str(marker)!r}, 'w').close()\n"
        "raise SystemExit(code)\n"
    )
    binary.chmod(0o755)
    path = str(directory) + os.pathsep + os.environ["PATH"]
    report = document(shepherd_pr(gh.repo, 1, "rebase", env={"PATH": path}))
    assert report["ok"] is True
    assert "could not be re-read: HTTP 502: Bad gateway" in report["detail"]
    assert report["after"] == ""
    assert report["pr"] is None
    assert json.loads((gh.path / "prs.json").read_text())[0]["headRefOid"] == "rebased-sha1"


# --- an internal error ---------------------------------------------------------


def boom(*args, **kwargs):
    raise RuntimeError("boom")


def test_pr_reports_an_internal_error_rather_than_a_traceback(gh, pr_module, monkeypatch, capsys):
    """Exit 3, outside the documented set, so a crash is never read as an answer."""
    monkeypatch.setattr(pr_module.os.path, "isdir", boom)
    assert pr_module.main([str(gh.repo), "1", "state"]) == 3
    assert "gh-shepherd-pr.py: internal error: RuntimeError: boom" in capsys.readouterr().err


def test_status_reports_an_internal_error_rather_than_a_traceback(
    gh, status_module, monkeypatch, capsys
):
    monkeypatch.setattr(status_module.os.path, "isdir", boom)
    assert status_module.main([str(gh.repo)]) == 3
    assert "gh-shepherd-status.py: internal error: RuntimeError: boom" in capsys.readouterr().err


# --- the report going quiet ---------------------------------------------------


def test_emit_says_nothing_more_once_the_reader_has_gone(pr_module, capsys):
    """The first BrokenPipeError silences the report; the action carries on.

    Each action emits once, so this second call cannot happen from the outside;
    it is the guard that keeps a future two-part report from writing to a
    descriptor that has already been pointed at devnull.
    """
    worker = pr_module.Shepherd("acme/widgets", 1, "state", 300, 60)
    worker.quiet = True
    worker.emit(True, "read")
    assert capsys.readouterr().out == ""
