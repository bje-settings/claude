"""Black-box tests for the gh plugin's SessionStart hook.

The port of `spec/gh/session_start_hook_spec.sh`. All twelve of its examples are
here, each carrying the `It` description it came from in its docstring; the rest
were added with the port, and say so.

Every run goes through `run_script`, so the hook is exercised as its own process
exactly as `hooks.json` runs it, against the real fixture repositories from
`conftest.py` and the real `gh-sync.py` for the fan-out branch. Nothing is
mocked: the hook's whole job is deciding what a repository's actual state is
worth saying, and a mock would decide that for it.

The examples that fall back to the process's own working directory chdir into
the sandbox first. Without it the fallback is the checkout pytest was started
in, which is a git repository on a branch that is usually not `main`, so the
hook would speak and the example would be asserting the wrong thing.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import runpy
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
HOOK_IO = ROOT / "plugins" / "gh" / "hooks" / "hook-io.py"
HOOKS_JSON = ROOT / "plugins" / "gh" / "hooks" / "hooks.json"


def payload(cwd):
    """The SessionStart payload Claude Code sends on stdin."""
    return json.dumps({"session_id": "s1", "cwd": str(cwd)})


def context_of(stdout):
    """The additionalContext of a SessionStart hook response.

    Doubles as the contract assertion: every example that expects the hook to
    speak goes through here, so the shape is checked everywhere rather than in
    one example that could pass while the others emitted something else. That
    includes `systemMessage`, the field the CLI renders directly regardless of
    whether the model ever takes a turn -- every spoken example must carry it,
    identical to `additionalContext`, not just the model-context field.
    """
    body = json.loads(stdout)
    output = body["hookSpecificOutput"]
    assert output["hookEventName"] == "SessionStart"
    assert isinstance(output["additionalContext"], str)
    assert output["additionalContext"].strip()
    assert body["systemMessage"] == output["additionalContext"]
    return output["additionalContext"]


@pytest.fixture
def hook(run_script, gh):
    """Run the hook's session-start mode against a fixture directory."""

    def run(cwd, **kwargs):
        return run_script(HOOK_IO, "session-start", stdin=payload(cwd), **kwargs)

    return run


# --- inside a git repository -------------------------------------------------


def test_stays_silent_on_the_default_branch(hook, gh):
    """stays silent on the default branch"""
    result = hook(gh.repo)
    assert result.status == 0
    assert result.stdout == ""


def test_asks_about_syncing_off_the_default_branch(hook, gh):
    """asks about syncing when HEAD is not on the default branch"""
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = hook(gh.repo)
    assert result.status == 0
    context = context_of(result.stdout)
    assert "side" in context
    assert "main" in context
    assert "/gh:sync" in context
    assert "Ask" in context


def test_emits_valid_json_carrying_the_session_start_contract(hook, gh):
    """emits valid JSON carrying the SessionStart contract"""
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = hook(gh.repo)
    assert result.status == 0
    # Named separately from the assertion above because it is a different claim:
    # that the response parses and carries the hook contract at all, not that it
    # says anything in particular.
    assert context_of(result.stdout)


def test_falls_back_to_a_local_main_without_a_cached_origin_head(hook, gh):
    """falls back to a local main when origin/HEAD is not cached

    A fresh clone of a repo whose origin/HEAD was never fetched still needs an
    answer, and asking the remote would mean going to the network.
    """
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = hook(gh.repo)
    assert result.status == 0
    context = context_of(result.stdout)
    assert "side" in context
    assert "main" in context


def test_falls_back_to_a_local_master_without_a_cached_origin_head(hook, gh):
    """Added with the port: the `master` half of the local fallback.

    Only `main` had an example, so the fallback could have been a single hard-
    coded name and the suite would not have noticed. A clone of a repository
    that never renamed its default branch still needs an answer.
    """
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "branch", "-m", "main", "master")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = hook(gh.repo)
    assert result.status == 0
    assert "master" in context_of(result.stdout)


def test_prefers_a_local_main_over_a_local_master(hook, gh):
    """Added with the port: both fallback names present, and the order matters.

    A repository that renamed `master` to `main` and kept the old branch around
    has both, and the proposal has to be the one it actually uses now.
    """
    gh.forget_origin_head(gh.repo)
    gh.git(gh.repo, "branch", "master", "main")
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    result = hook(gh.repo)
    assert result.status == 0
    context = context_of(result.stdout)
    assert "'main'" in context
    assert "master" not in context


def test_prefers_a_cached_origin_head_over_a_local_main(hook, gh):
    """Added with the port: origin/HEAD wins, even where `main` exists locally.

    The fallback is for a clone that never fetched one, not a second opinion: a
    repository whose default branch on the remote is something else must be
    reported as that, or the hook proposes moving to the wrong branch.
    """
    gh.git(gh.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    result = hook(gh.repo)
    assert result.status == 0
    context = context_of(result.stdout)
    assert "'trunk'" in context
    assert "'main'" in context


def test_does_not_reach_the_network_for_the_in_repo_check(hook, gh):
    """does not reach the network for the in-repo check

    Proven by breaking the remote: a fetch would fail and change the report.
    """
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    gh.break_origin(gh.repo)
    result = hook(gh.repo)
    assert result.status == 0
    assert "side" in context_of(result.stdout)


def test_stays_silent_on_a_detached_head(hook, gh):
    """Added with the port: a detached HEAD has no branch to compare.

    `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" there, and
    proposing a move away from "HEAD" would be nonsense.
    """
    gh.git(gh.repo, "checkout", "-q", "--detach")
    result = hook(gh.repo)
    assert result.status == 0
    assert result.stdout == ""


def test_stays_silent_when_no_default_branch_resolves(hook, gh):
    """Added with the port: neither origin/HEAD nor a local main or master.

    The last arm of the resolution, reachable only once every remote-tracking
    ref and the default branch itself are gone. There is nothing to propose
    moving to, so the hook says nothing rather than guessing.
    """
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    # All three, and in this order: origin/HEAD is a symbolic ref and keeps
    # resolving after its target is deleted, so dropping the remote-tracking
    # branches alone leaves the first arm still answering "main".
    gh.forget_origin_head(gh.repo)
    gh.drop_remote_branches(gh.repo)
    gh.git(gh.repo, "branch", "-D", "main")
    result = hook(gh.repo)
    assert result.status == 0
    assert result.stdout == ""


# --- outside a git repository ------------------------------------------------


def test_stays_silent_without_repositories_to_report_on(hook, gh):
    """stays silent when there are no repositories to report on"""
    empty = gh.path / "empty"
    empty.mkdir()
    result = hook(empty)
    assert result.status == 0
    assert result.stdout == ""


def test_stays_silent_when_every_repository_is_in_order(hook, gh):
    """stays silent when every repository is already in order"""
    gh.create_at(gh.path / "fan", "a")
    result = hook(gh.path / "fan")
    assert result.status == 0
    assert result.stdout == ""


def test_reports_prunable_work_and_changes_nothing(hook, gh):
    """reports when a repository has prunable work, and changes nothing"""
    work = gh.create_at(gh.path / "fan", "a")
    gh.branch_with_work(work, "gone")
    gh.merge_commit(work, "gone")
    before = gh.branches(work)
    result = hook(gh.path / "fan")
    assert result.status == 0
    assert "would delete gone" in context_of(result.stdout)
    assert gh.branches(work) == before


def test_speaks_up_when_the_merge_lookups_were_degraded(hook, gh):
    """speaks up when the merge lookups were degraded rather than reporting silence

    Nothing is actionable here, but nothing could be checked either, and silence
    would read as "everything is in order".
    """
    work = gh.create_at(gh.path / "fan", "a")
    gh.branch_with_work(work, "wip")
    result = hook(gh.path / "fan", env={"GH_FIXTURE_FAIL": "1"})
    assert result.status == 0
    assert "could not read merged pull requests" in context_of(result.stdout)


def test_reports_a_repository_whose_fetch_failed(hook, gh):
    """Added with the port: the `✗` arm of the actionable filter.

    The other two markers, "would " and "could not", have an example each above;
    without this one the filter could drop `✗` and the suite would not notice.
    """
    work = gh.create_at(gh.path / "fan", "a")
    gh.break_origin(work)
    result = hook(gh.path / "fan")
    assert result.status == 0
    assert "✗ fetch failed" in context_of(result.stdout)


def test_stays_silent_when_gh_sync_is_missing(run_script, gh, tmp_path):
    """Added with the port: an install whose scripts directory is not there.

    The hook is copied out on its own, so `../scripts/gh-sync.py` does not
    resolve. A broken install must cost the check and nothing else -- and leave
    one line where `claude --debug` will show it, because the alternative is a
    check that has silently not run since the day it was installed.
    """
    lonely = tmp_path / "lonely-hooks"
    lonely.mkdir()
    copy = lonely / "hook-io.py"
    shutil.copy(str(HOOK_IO), str(copy))
    empty = gh.path / "elsewhere"
    empty.mkdir()
    result = run_script(copy, "session-start", stdin=payload(empty))
    assert result.status == 0
    assert result.stdout == ""
    assert result.stderr.strip() == "missing " + str(lonely.parent / "scripts" / "gh-sync.py")


def test_reports_a_fan_out_that_failed(hook, gh):
    """Added with the port: a `gh-sync.py` that ran and exited non-zero.

    The old shell discarded the child's stderr and stayed silent, so a fan-out
    that had stopped working looked exactly like one with nothing to say. A
    directory the user cannot open is the real case: `gh-sync.py` refuses it
    with `could not read <dir>` and exit 2 rather than reporting no
    repositories. The whole of stderr goes where the debug log will have it; the
    session gets its last line, because that is the one a person reads.
    """
    fan = gh.path / "fan"
    gh.create_at(fan, "a")
    fan.chmod(0o000)
    try:
        result = hook(fan)
    finally:
        # Restored before anything else can trip over it, including pytest's own
        # tidying of temp directories from earlier runs.
        fan.chmod(0o755)
    assert result.status == 0
    assert f"could not run the sync check: could not read {fan}" in context_of(result.stdout)
    assert str(fan) in result.stderr


def test_reports_a_fan_out_that_ran_out_of_time(hook, gh, sandbox):
    """Added with the port: the 50 second bound on the fan-out.

    One `gh` lookup per repository against a remote that is answering slowly is
    what runs over, and the hook's own budget is 60 seconds: without a bound of
    its own the check is killed with nothing said at all. A `gh` that never
    answers is that remote; the bound is overridden so the example does not
    spend the real one waiting for it.
    """
    fan = gh.path / "fan"
    work = gh.create_at(fan, "a")
    gh.branch_with_work(work, "wip")
    slow = gh.path / "slow-bin"
    slow.mkdir()
    stub = slow / "gh"
    stub.write_text("#!/bin/sh\nsleep 120\n")
    stub.chmod(0o755)
    sandbox.stub_path(slow)
    result = hook(fan, env={"GH_HOOK_SYNC_TIMEOUT": "0.5"})
    assert result.status == 0
    context = context_of(result.stdout)
    assert "could not finish the sync check within 0.5 s" in context
    assert f"(1 repositories under {fan})" in context


def test_stays_silent_when_git_is_not_on_path(hook, gh, sandbox):
    """Added with the port: no git at all.

    Both branches need git: the in-repo check cannot ask what branch this is,
    and `gh-sync.py` refuses outright. Neither is something to tell the user
    about at session start, so the hook stays quiet and exits 0.
    """
    gh.create_at(gh.path / "fan", "a")
    result = hook(gh.path / "fan", env={"PATH": sandbox.path_without("git")})
    assert result.status == 0
    assert result.stdout == ""
    assert result.stderr.strip() == "git is not on PATH"


# --- robustness, because a hook must never block a session --------------------


@pytest.fixture
def outside_a_repo(gh, monkeypatch):
    """Put the process's own working directory somewhere with nothing to report.

    The payload examples below fall back to it, and the fallback has to be a
    directory the hook has nothing to say about, or they would pass or fail on
    the state of the checkout the suite happens to be running in.
    """
    elsewhere = gh.path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    return elsewhere


def test_exits_cleanly_on_a_malformed_payload(run_script, outside_a_repo):
    """exits cleanly on a malformed payload"""
    result = run_script(HOOK_IO, "session-start", stdin="not json at all")
    assert result.status == 0
    assert result.stdout == ""


def test_exits_cleanly_on_an_empty_payload(run_script, outside_a_repo):
    """exits cleanly on an empty payload"""
    result = run_script(HOOK_IO, "session-start", stdin="")
    assert result.status == 0
    assert result.stdout == ""


def test_exits_cleanly_when_cwd_does_not_exist(run_script, gh, outside_a_repo):
    """exits cleanly when cwd names a directory that does not exist"""
    result = run_script(HOOK_IO, "session-start", stdin=payload(gh.path / "gone"))
    assert result.status == 0
    assert result.stdout == ""


def test_falls_back_to_the_process_cwd_and_still_speaks(run_script, gh, monkeypatch):
    """Added with the port: the fallback answering, not just staying quiet.

    Every other fallback example lands somewhere with nothing to say, so the
    fallback could have been "give up" and they would all still pass. Here the
    process is inside a repository on a branch worth mentioning and the payload
    carries no cwd at all, so only the fallback can produce the message.
    """
    gh.git(gh.repo, "checkout", "-q", "-b", "side")
    monkeypatch.chdir(gh.repo)
    result = run_script(HOOK_IO, "session-start", stdin='{"session_id":"s1"}')
    assert result.status == 0
    assert "side" in context_of(result.stdout)


def test_exits_cleanly_when_cwd_is_not_a_string(run_script, outside_a_repo):
    """Added with the port: a cwd that is not a path at all.

    Treated as absent rather than coerced. `os.path.isdir` reads an integer as a
    file descriptor, so a payload carrying one would otherwise be answered about
    whatever fd 3 happened to be.
    """
    result = run_script(HOOK_IO, "session-start", stdin='{"session_id":"s1","cwd":3}')
    assert result.status == 0
    assert result.stdout == ""


def test_prints_nothing_on_stdout_for_a_missing_subcommand(run_script, gh):
    """Added with the port: the silence guarantee for a wiring mistake.

    A typo in hooks.json still gets the usage message and exit 2, so it is
    diagnosable, but nothing reaches stdout, so the session gains no context
    from a hook that never ran its check. `hooks.json`'s `; exit 0` keeps the
    status from surfacing as a hook failure.
    """
    result = run_script(HOOK_IO)
    assert result.status == 2
    assert result.stdout == ""
    assert "usage:" in result.stderr


def test_prints_nothing_on_stdout_for_an_unknown_subcommand(run_script, gh):
    """Added with the port: the same guarantee for a subcommand that is not one."""
    result = run_script(HOOK_IO, "session_start")
    assert result.status == 2
    assert result.stdout == ""
    assert "usage:" in result.stderr


def test_survives_a_reader_that_closed_the_pipe(run_with_closed_reader, gh):
    """Added with the port: Claude Code stopped reading the response.

    Nothing here changes state, so there is nothing left to finish; the point is
    only that the interpreter's shutdown flush does not turn it into a traceback
    on stderr, which the debug log would then carry as a hook failure.
    """
    status, stderr = run_with_closed_reader(HOOK_IO, "branch", "side", "main")
    assert status == 0
    assert "Traceback" not in stderr
    assert "BrokenPipeError" not in stderr


def test_leaves_a_traceback_and_exits_0_when_nothing_else_caught_it(run_script, gh, monkeypatch):
    """Added with the port: the outermost never-fail wrapper, reached for real.

    A process whose own working directory has been deleted cannot answer
    `os.getcwd()`, and the payload carries no cwd to use instead, so the
    fallback raises before any of the hook's own guards are in play. That is the
    shape the wrapper exists for: unforeseen, so nothing below it can be asked to
    handle it, and still not a reason a session stops. The traceback goes to
    stderr, where the debug log keeps it, and the status is 0 all the same.
    """
    doomed = gh.path / "doomed"
    doomed.mkdir()
    monkeypatch.chdir(doomed)
    doomed.rmdir()
    result = run_script(HOOK_IO, "session-start", stdin='{"session_id":"s1"}')
    assert result.status == 0
    assert result.stdout == ""
    assert "Traceback" in result.stderr


def test_runs_under_a_single_byte_locale(hook, gh):
    """Added with the port: the report carries ✗, ✓ and ·.

    Under LC_ALL=en_US.ISO8859-1 an unreconfigured stdout raises
    UnicodeEncodeError on the first line that holds one. What this run proves is
    the child's handling of them, not the hook's stdout: the hook answers in
    `ensure_ascii` JSON, which no single-byte locale can trip over. The
    characters come from `gh-sync-repo.py`'s own source, so asserting them here
    is safe on both macOS and Linux.
    """
    work = gh.create_at(gh.path / "fan", "a")
    gh.break_origin(work)
    result = hook(
        gh.path / "fan",
        env={"LC_ALL": "en_US.ISO8859-1", "PYTHONIOENCODING": "ascii"},
    )
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert "✗ fetch failed" in context_of(result.stdout)


# --- the wiring hooks.json actually carries -----------------------------------


def test_hooks_json_runs_the_python_hook():
    """Added with the port: the only caller, checked as one.

    The `; exit 0` is the outermost guarantee that a session starts even when
    this file is never reached at all -- no python3 on PATH, or a hooks
    directory it was not installed into -- and no test inside the hook can prove
    it, because it lives outside the hook.
    """
    config = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    entries = config["hooks"]["SessionStart"]
    assert len(entries) == 1
    assert entries[0]["matcher"] == "startup"
    commands = [item["command"] for item in entries[0]["hooks"]]
    assert commands == [
        'command -v python3 >/dev/null 2>&1 && python3 "${CLAUDE_PLUGIN_ROOT}/hooks/hook-io.py"'
        " session-start; exit 0"
    ]


# --- the arms a black-box run cannot honestly reach ---------------------------
#
# Two decisions sit behind a git or a subprocess call that a real fixture cannot
# be made to produce: a symbolic origin/HEAD pointing outside refs/remotes/origin/,
# and a `gh-sync.py` that cannot be launched at all. They are unit tests on the
# module rather than black-box runs, so the arms are named rather than inferred.


@pytest.fixture(scope="module")
def hook_io():
    """The hook imported as a module. Its name has a dash, so importlib does it."""
    spec = importlib.util.spec_from_file_location("gh_hook_io", HOOK_IO)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_branch_passes_through_a_ref_outside_the_origin_namespace(hook_io, monkeypatch):
    """A hand-set origin/HEAD is used as it stands rather than mangled.

    `symbolic-ref` answers whatever the ref points at, and a repository whose
    origin/HEAD was pointed somewhere else by hand is still answering the
    question. The bash version stripped a prefix that was not there and got the
    same result; this keeps that.
    """
    monkeypatch.setattr(hook_io, "git", lambda cwd, *args: "refs/heads/trunk")
    assert hook_io.default_branch("/anywhere") == "refs/heads/trunk"


def test_report_message_is_none_when_gh_sync_cannot_be_launched(hook_io, monkeypatch):
    """An unlaunchable child costs the check and nothing else.

    `os.access` said the file is readable and the exec still failed: a partial
    install, or a machine out of processes. There is nothing to tell the user at
    session start, and certainly not a traceback. The two degraded runs that do
    speak -- a non-zero exit and a timeout -- are black-box examples above,
    because both can be produced by a real child.
    """

    def refuse(*args, **kwargs):
        raise OSError("cannot exec")

    monkeypatch.setattr(hook_io.subprocess, "Popen", refuse)
    assert hook_io.report_message("/anywhere") is None


def test_sync_timeout_ignores_an_unusable_override(hook_io, monkeypatch):
    """A stray value in the environment falls back to the real bound.

    The override exists for the tests; it is read from the environment of
    whatever session started, so "50" has to be the answer to anything that is
    not a positive number rather than a crash or an instant timeout.
    """
    monkeypatch.delenv(hook_io.SYNC_TIMEOUT_ENV, raising=False)
    assert hook_io.sync_timeout() == hook_io.SYNC_TIMEOUT
    for value in ("", "soon", "0", "-3"):
        monkeypatch.setenv(hook_io.SYNC_TIMEOUT_ENV, value)
        assert hook_io.sync_timeout() == hook_io.SYNC_TIMEOUT
    monkeypatch.setenv(hook_io.SYNC_TIMEOUT_ENV, "1.5")
    assert hook_io.sync_timeout() == 1.5


def test_kill_group_falls_back_to_the_child_alone(hook_io, monkeypatch):
    """A group that cannot be signalled still costs the child its life.

    The group is the point -- `gh-sync.py` spawns one child per repository, and
    those are what would carry on fetching -- but a child that has already died
    between the timeout and the signal has no group left, and that must not
    become an exception inside the handler for a timeout.
    """

    class Child:
        pid = -1

        def __init__(self):
            self.killed = False

        def kill(self):
            self.killed = True

    def gone(pid):
        raise ProcessLookupError("no such process")

    monkeypatch.setattr(hook_io.os, "getpgid", gone)
    child = Child()
    hook_io.kill_group(child)
    assert child.killed


def test_last_line_of_a_child_that_said_nothing(hook_io):
    """A child that failed without a word still has to produce a message.

    `run_sync` falls back to the exit status there; this is the half of that
    which decides there is nothing to quote.
    """
    assert hook_io.last_line("") == ""
    assert hook_io.last_line("\n   \n") == ""
    assert hook_io.last_line("first\nlast\n\n") == "last"


def test_main_module_exits_0_when_something_unforeseen_escapes(hook_io, monkeypatch, capsys):
    """The outermost wrapper, run in-process so the coverage report can see it.

    `test_leaves_a_traceback_and_exits_0_when_nothing_else_caught_it` is the
    real shape of this, black-box, with a working directory that has genuinely
    been deleted; a child in that state cannot write a coverage data file, so
    the arm it proves is measured by nothing. This runs the file as `__main__`
    with the same failure injected, and asserts the same two things.
    """

    def gone():
        raise RuntimeError("the working directory is gone")

    monkeypatch.setattr(os, "getcwd", gone)
    monkeypatch.setattr(sys, "argv", [str(HOOK_IO), "session-start"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_path(str(HOOK_IO), run_name="__main__")
    assert exit_info.value.code == 0
    assert "Traceback" in capsys.readouterr().err


def test_repo_count_is_zero_when_discovery_cannot_answer(hook_io, monkeypatch):
    """The count in the timeout message never becomes a second failure.

    It is one detail inside a message about a fan-out that already ran out of
    time; a discovery that raises there would lose the message itself.
    """
    assert hook_io.repo_count("/does/not/exist") == 0
    monkeypatch.setattr(hook_io, "discover", None)
    assert hook_io.repo_count("/anywhere") == 0
