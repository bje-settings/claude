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
import json
import shutil
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
    one example that could pass while the others emitted something else.
    """
    body = json.loads(stdout)
    output = body["hookSpecificOutput"]
    assert output["hookEventName"] == "SessionStart"
    assert isinstance(output["additionalContext"], str)
    assert output["additionalContext"].strip()
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
    resolve. A broken install must cost the check and nothing else.
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


# --- robustness, because a hook must never block a session --------------------


@pytest.fixture
def outside_a_repo(gh, monkeypatch):
    """Put the process's own working directory somewhere with nothing to report.

    The three payload examples below all fall back to it, and the fallback has to
    be a directory the hook has nothing to say about, or they would pass or fail
    on the state of the checkout the suite happens to be running in.
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


def test_runs_under_a_single_byte_locale(hook, gh):
    """Added with the port: the report carries ✗, ✓ and ·.

    Under LC_ALL=en_US.ISO8859-1 an unreconfigured stdout raises
    UnicodeEncodeError on the first line that holds one. The characters come
    from `gh-sync-repo.py`'s own source, so asserting them here is safe on both
    macOS and Linux.
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
    session start, and certainly not a traceback.
    """

    def refuse(*args, **kwargs):
        raise OSError("cannot exec")

    monkeypatch.setattr(hook_io.subprocess, "run", refuse)
    assert hook_io.report_message("/anywhere") is None
