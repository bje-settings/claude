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
from conftest import SHEPHERD_PR, SHEPHERD_STATUS
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
    assert status_module.gh_json(["repo", "view"]) is None
    assert status_module.resolve_repo() == (None, None)
    assert capsys.readouterr().err == ""


def test_pr_treats_a_gh_that_cannot_be_run_as_a_repository_it_cannot_read(pr_module, monkeypatch):
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    assert pr_module.resolve_repo() is None


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
    """127, the shell's own "could not execute": a watcher that told us nothing.

    The rollup is re-read afterwards in every case, so this is not a failure.
    """
    monkeypatch.setattr(pr_module.subprocess, "Popen", refuse_exec)
    assert pr_module.run_bounded(1, ["gh", "pr", "checks"]) == 127


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


def test_failed_log_is_empty_when_gh_cannot_be_run(pr_module, monkeypatch):
    worker = pr_module.Shepherd("acme/widgets", 1, "wait", 300, 60)
    monkeypatch.setattr(pr_module.subprocess, "run", refuse_exec)
    link = "https://github.com/acme/widgets/actions/runs/11/job/21"
    assert worker.failed_log([{"name": "build", "link": link}]) == ""


def test_failed_log_is_empty_when_gh_refuses_the_run(pr_module, monkeypatch):
    """A log gh will not hand over is no log, not a crash mid-report."""
    worker = pr_module.Shepherd("acme/widgets", 1, "wait", 300, 60)
    monkeypatch.setattr(
        pr_module.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess([], 1, b""),
    )
    link = "https://github.com/acme/widgets/actions/runs/11/job/21"
    assert worker.failed_log([{"name": "build", "link": link}]) == ""


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


def test_status_treats_malformed_json_as_a_repository_it_cannot_read(gh, shepherd_status, sandbox):
    path = nonsense_gh(sandbox, "print('not json at all')\n")
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr


def test_pr_treats_malformed_json_as_a_repository_it_cannot_read(gh, shepherd_pr, sandbox):
    path = nonsense_gh(sandbox, "print('not json at all')\n")
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr


def test_pr_treats_a_repo_view_that_is_not_an_object_as_unreadable(gh, shepherd_pr, sandbox):
    path = nonsense_gh(sandbox, "print('[1, 2]')\n")
    result = shepherd_pr(gh.repo, 1, "state", env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr


def test_status_refuses_a_repo_view_missing_the_default_branch(gh, shepherd_status, sandbox):
    """Half an answer is not an answer: the run list needs the branch name."""
    path = nonsense_gh(sandbox, 'print(\'{"nameWithOwner": "acme/widgets"}\')\n')
    result = shepherd_status(gh.repo, env={"PATH": path})
    assert result.status == 1
    assert "could not resolve the repository" in result.stderr


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
    assert "could not list pull requests for acme/widgets" in result.stderr


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
        assert shepherd_status(closed).status == 2
    finally:
        closed.chmod(0o755)


@pytest.mark.skipif(os.geteuid() == 0, reason="root can enter a directory with no permissions")
def test_pr_gives_up_on_a_directory_it_cannot_enter(gh, shepherd_pr):
    closed = gh.path / "closed"
    closed.mkdir()
    closed.chmod(0o000)
    try:
        assert shepherd_pr(closed, 1, "state").status == 2
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
    """The watcher returned and the re-read, which is the source of truth, failed."""
    gh.write_prs(gh.dep_pr(1, checks="pending"))
    monkeypatch.setenv("SHEPHERD_WAIT_BOUND", "5")
    after_call(call_log, "pr checks", (gh.path / "prs.json").unlink)
    report = document(shepherd_pr(gh.repo, 1, "wait"))
    assert report["ok"] is False
    assert "checks finished but the pull request could not be re-read" in report["detail"]


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


def test_a_poll_interval_that_is_not_a_number_falls_back_to_the_floor(pr_module, monkeypatch):
    """A stray value in the environment must not be what decides a run."""
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "soon")
    assert pr_module.poll_interval(400) == pr_module.POLL_FLOOR


def test_a_zero_poll_interval_still_terminates(pr_module, monkeypatch):
    """Zero would spin without ever reaching the bound. The shell version did."""
    monkeypatch.setenv("SHEPHERD_POLL_SECONDS", "0")
    assert pr_module.poll_interval(400) == 1


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
