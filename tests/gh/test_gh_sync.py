"""Ported from `spec/gh/gh_sync_spec.sh`, one test per example.

Each ported test carries the `It` description it came from in its docstring.
`gh-sync.py` is the orchestrator: it decides the scope, runs `gh-sync-repo.py`
once per repository at most `-j N` at a time, and assembles the reports in
directory order. The report is a contract — the session-start hook greps it for
`would `, `✗` and `could not` — so `SCENARIOS` below is compared line for line
against what the shell version printed, captured in
`golden/bash-sync-output.json` before it was deleted.

The stand-in per-repo scripts (`orchestrator_copy`) are how the throttle, the
crashed job, and the wiring refusals are provoked: they make a job's timing and
exit status something the test states rather than something it hopes for.
"""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
from pathlib import Path

import pytest
from conftest import DISCOVER, SYNC, SYNC_REPO
from scenarios import normalise

GOLDEN_FILE = Path(__file__).resolve().parent / "golden" / "bash-sync-output.json"
GOLDEN = json.loads(GOLDEN_FILE.read_text())


# --- the scenarios whose whole report is compared with the shell version ------


def fan_out_two_repos(gh):
    gh.create_at(gh.path / "fan", "aaa")
    gh.create_at(gh.path / "fan", "bbb")
    return ["--dry-run", str(gh.path / "fan")]


def fan_out_pending_deletion(gh):
    work = gh.create_at(gh.path / "fan", "aaa")
    gh.branch_with_work(work, "gone")
    gh.merge_commit(work, "gone")
    return ["--dry-run", str(gh.path / "fan")]


def fan_out_dirty_neighbour(gh):
    gh.create_at(gh.path / "fan", "clean")
    dirty = gh.create_at(gh.path / "fan", "dirty")
    gh.dirty(dirty)
    return ["--dry-run", str(gh.path / "fan")]


def no_repositories(gh):
    (gh.path / "empty").mkdir()
    return ["--dry-run", str(gh.path / "empty")]


def not_recursive(gh):
    gh.create_at(gh.path / "deep" / "nested", "x")
    return ["--dry-run", str(gh.path / "deep")]


def bare_repository_only(gh):
    (gh.path / "bare").mkdir()
    gh.git(gh.path, "init", "-q", "--bare", str(gh.path / "bare" / "thing.git"))
    return ["--dry-run", str(gh.path / "bare")]


def single_repository(gh):
    return ["--dry-run", str(gh.repo)]


SCENARIOS = {
    "fan_out_two_repos": fan_out_two_repos,
    "fan_out_pending_deletion": fan_out_pending_deletion,
    "fan_out_dirty_neighbour": fan_out_dirty_neighbour,
    "no_repositories": no_repositories,
    "not_recursive": not_recursive,
    "bare_repository_only": bare_repository_only,
    "single_repository": single_repository,
}


# --- helpers ------------------------------------------------------------------

# A per-repo stand-in that records when it ran, so the throttle can be asserted
# from the outside rather than inferred from output order.
TIMED_JOB = """#!/usr/bin/env python3
import os, sys, time

log = os.path.join(os.environ["JOB_LOG"], os.path.basename(sys.argv[1]))
start = time.time()
time.sleep(0.3)
with open(log, "w") as handle:
    handle.write("%f %f\\n" % (start, time.time()))
print(os.path.basename(sys.argv[1]))
"""


def orchestrator_copy(gh, job=None, lib=True):
    """A copy of gh-sync.py in the sandbox, with the neighbours it is given.

    `gh-sync.py` resolves both the per-repo script and the discovery library
    relative to itself, so a copy with one of them missing is how the wiring
    refusals are reached, and a copy beside a stand-in job is how a crashed or a
    slow repository is arranged.
    """
    directory = gh.path / "copy"
    directory.mkdir(exist_ok=True)
    shutil.copy(SYNC, directory / "gh-sync.py")
    if lib:
        shutil.copytree(DISCOVER.parent, directory / "lib", dirs_exist_ok=True)
    if job == "real":
        shutil.copy(SYNC_REPO, directory / "gh-sync-repo.py")
    elif job is not None:
        (directory / "gh-sync-repo.py").write_text(job)
    return directory / "gh-sync.py"


def load_orchestrator():
    """gh-sync.py imported in-process, for the helpers with no reachable branch.

    Its name has a hyphen, so it is loaded by path rather than imported. Only the
    pure helpers are called this way; everything with an effect is driven
    black-box, as its own process, the way Claude Code runs it.
    """
    spec = importlib.util.spec_from_file_location("gh_sync", SYNC)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def intervals(log_dir):
    """{repo name: (start, end)} for every job the timed stand-in recorded."""
    out = {}
    for path in Path(log_dir).iterdir():
        start, end = path.read_text().split()
        out[path.name] = (float(start), float(end))
    return out


def overlapping(spans):
    """Do any two of these (start, end) spans overlap in time?"""
    ordered = sorted(spans)
    return any(ordered[i][1] > ordered[i + 1][0] for i in range(len(ordered) - 1))


# --- argument handling --------------------------------------------------------


def test_rejects_a_zero_jobs_value(gh, sync):
    """rejects a zero -j rather than spinning forever"""
    result = sync("-j", "0", str(gh.path))
    assert result.status == 2
    assert "invalid -j value: 0" in result.stderr


def test_rejects_a_non_numeric_jobs_value(gh, sync):
    """rejects a non-numeric -j"""
    result = sync("-j", "four", str(gh.path))
    assert result.status == 2
    assert "invalid -j value: four" in result.stderr


def test_rejects_an_unknown_flag(gh, sync):
    """rejects an unknown flag"""
    result = sync("--nope", str(gh.path))
    assert result.status == 2
    assert "unknown flag" in result.stderr


def test_accepts_the_attached_jobs_form(gh, sync):
    """accepts the attached -j4 form as well as -j 4"""
    gh.create_at(gh.path / "fan", "a")
    result = sync("--dry-run", "-j2", str(gh.path / "fan"))
    assert result.status == 0
    assert "(1 repos)" in result.stdout


def test_a_trailing_jobs_flag_falls_back_to_the_default(gh, sync):
    """A bare -j at the end names no value, and must not become an invalid one."""
    gh.create_at(gh.path / "fan", "a")
    result = sync("--dry-run", str(gh.path / "fan"), "-j")
    assert result.status == 0
    assert "(1 repos)" in result.stdout


def test_prints_usage_for_help(gh, sync):
    """prints usage for --help without leaking code"""
    result = sync("--help")
    assert result.status == 0
    assert "Usage:" in result.stdout
    assert "sys.path.insert" not in result.stdout


def test_rejects_a_target_that_is_not_a_directory(gh, sync):
    """rejects a target that is not a directory"""
    result = sync(str(gh.path / "nothing-here"))
    assert result.status == 2
    assert "not a directory" in result.stderr


def test_defaults_to_the_current_directory(gh, sync, monkeypatch):
    """With no target the scope is the working directory, as the shell version had it."""
    gh.create_at(gh.path / "fan", "a")
    monkeypatch.chdir(gh.path / "fan")
    result = sync("--dry-run")
    assert result.status == 0
    assert "(1 repos)" in result.stdout


# --- scope detection ----------------------------------------------------------


def test_syncs_the_current_repository(gh, sync):
    """syncs the current repository when the target is a git repo"""
    result = sync("--dry-run", str(gh.repo))
    assert result.status == 0
    assert "already up to date" in result.stdout
    # No header: a single repository runs in the foreground and reports for itself.
    assert "repos)" not in result.stdout


def test_fans_out_over_immediate_subdirectories(gh, sync):
    """fans out over immediate subdirectories that are git repos"""
    gh.create_at(gh.path / "fan", "a")
    gh.create_at(gh.path / "fan", "b")
    result = sync("--dry-run", str(gh.path / "fan"))
    assert result.status == 0
    assert "(2 repos)" in result.stdout
    assert "already up to date" in result.stdout


def test_does_not_recurse(gh, sync):
    """does not recurse: a repo two levels down is out of scope"""
    gh.create_at(gh.path / "deep" / "nested", "x")
    result = sync("--dry-run", str(gh.path / "deep"))
    assert result.status == 0
    assert "No git repositories directly inside" in result.stdout


def test_says_so_when_a_directory_holds_no_repositories(gh, sync):
    """says so when a directory holds no git repositories"""
    (gh.path / "empty").mkdir()
    result = sync("--dry-run", str(gh.path / "empty"))
    assert result.status == 0
    assert "No git repositories directly inside" in result.stdout


def test_ignores_a_bare_repository(gh, sync):
    """ignores a bare repository, which has no work tree to sync"""
    (gh.path / "bare").mkdir()
    gh.git(gh.path, "init", "-q", "--bare", str(gh.path / "bare" / "thing.git"))
    result = sync("--dry-run", str(gh.path / "bare"))
    assert result.status == 0
    assert "No git repositories directly inside" in result.stdout


# --- reporting ----------------------------------------------------------------


def test_reports_in_directory_order(gh, sync):
    """reports each repository in directory order regardless of finish order"""
    for name in ("aaa", "bbb", "ccc"):
        gh.create_at(gh.path / "fan", name)
    result = sync("--dry-run", "-j", "3", str(gh.path / "fan"))
    assert result.status == 0
    assert "(3 repos)" in result.stdout
    positions = [result.stdout.index(name) for name in ("aaa", "bbb", "ccc")]
    assert positions == sorted(positions)


def test_reports_do_not_interleave_when_jobs_run_concurrently(gh, sync):
    """Four repositories, two at a time: every repository's lines stay together.

    Each repository is given a branch named after itself, so a line can be traced
    back to the job that wrote it. Two jobs run at once, so an orchestrator that
    let their output through as it arrived would split a report in half.
    """
    names = ("aaa", "bbb", "ccc", "ddd")
    for name in names:
        work = gh.create_at(gh.path / "fan", name)
        gh.branch_with_work(work, "gone-" + name)
        gh.merge_commit(work, "gone-" + name)

    result = sync("--dry-run", "-j", "2", str(gh.path / "fan"))
    assert result.status == 0
    assert "(4 repos)" in result.stdout

    lines = result.stdout.splitlines()
    # The header of each repository's section, and the line only that repository
    # can have produced. Every one of the latter must sit inside its own section.
    for index, name in enumerate(names):
        start = lines.index(name)
        end = lines.index(names[index + 1]) if index + 1 < len(names) else len(lines)
        section = lines[start:end]
        assert any("would delete gone-" + name in line for line in section)
        others = [other for other in names if other != name]
        assert not any("gone-" + other in line for other in others for line in section)


def test_surfaces_a_job_that_exited_abnormally(gh, sync, run_script):
    """surfaces a job that exited abnormally instead of reporting silence"""
    orchestrator = orchestrator_copy(gh, job="import sys\nsys.exit(7)\n")
    gh.create_at(gh.path / "fan", "a")
    result = run_script(orchestrator, str(gh.path / "fan"))
    assert result.status == 0
    assert "exited with status 7" in result.stdout


def test_a_job_that_wrote_nothing_still_gets_its_status_reported(gh, sync, run_script):
    """A silent job and a crashed one are different answers, and read differently."""
    orchestrator = orchestrator_copy(gh, job="import sys\nsys.exit(0)\n")
    gh.create_at(gh.path / "fan", "a")
    result = run_script(orchestrator, str(gh.path / "fan"))
    assert result.status == 0
    assert "exited with status" not in result.stdout


# --- wiring -------------------------------------------------------------------


def test_refuses_when_the_per_repo_script_is_missing(gh, run_script):
    """refuses to run when the per-repo script is missing"""
    orchestrator = orchestrator_copy(gh)
    result = run_script(orchestrator, str(gh.path))
    assert result.status == 2
    assert "missing" in result.stderr
    assert "gh-sync-repo.py" in result.stderr


def test_refuses_when_the_discovery_library_is_missing(gh, run_script):
    """refuses to run when the discovery library is missing"""
    orchestrator = orchestrator_copy(gh, job="real", lib=False)
    result = run_script(orchestrator, str(gh.path))
    assert result.status == 2
    assert "missing" in result.stderr
    assert "discover.py" in result.stderr


def test_throttles_to_one_job_at_a_time(gh, run_script):
    """throttles to the requested number of jobs"""
    orchestrator = orchestrator_copy(gh, job=TIMED_JOB)
    log = gh.path / "jobs"
    log.mkdir()
    for name in ("a", "b", "c"):
        gh.create_at(gh.path / "fan", name)
    result = run_script(orchestrator, "-j", "1", str(gh.path / "fan"), env={"JOB_LOG": str(log)})
    assert result.status == 0
    spans = intervals(log)
    assert sorted(spans) == ["a", "b", "c"]
    assert not overlapping(spans.values())


def test_runs_jobs_concurrently_when_allowed(gh, run_script):
    """The counterpart: -j 3 is a throttle, not a queue, and must actually overlap."""
    orchestrator = orchestrator_copy(gh, job=TIMED_JOB)
    log = gh.path / "jobs"
    log.mkdir()
    for name in ("a", "b", "c"):
        gh.create_at(gh.path / "fan", name)
    result = run_script(orchestrator, "-j", "3", str(gh.path / "fan"), env={"JOB_LOG": str(log)})
    assert result.status == 0
    assert overlapping(intervals(log).values())


# --- fan-out safety -----------------------------------------------------------


def test_mutates_nothing_in_dry_run(gh, sync):
    """mutates nothing in --dry-run"""
    work = gh.create_at(gh.path / "fan", "a")
    gh.branch_with_work(work, "gone")
    gh.merge_commit(work, "gone")
    before = gh.branches(work)
    result = sync("--dry-run", str(gh.path / "fan"))
    assert result.status == 0
    assert "would delete gone" in result.stdout
    assert gh.branches(work) == before


def test_skips_a_dirty_repository_but_syncs_its_neighbours(gh, sync):
    """skips a dirty repository but still syncs its clean neighbours"""
    gh.create_at(gh.path / "fan", "clean")
    dirty = gh.create_at(gh.path / "fan", "dirty")
    gh.dirty(dirty)
    result = sync("--dry-run", str(gh.path / "fan"))
    assert result.status == 0
    assert "skipped: uncommitted changes" in result.stdout
    assert "already up to date" in result.stdout


def test_passes_no_install_through_to_the_jobs(gh, sync):
    """--no-install reaches the per-repo jobs, which read it as GH_SYNC_NO_INSTALL."""
    work = gh.create_at(gh.path / "fan", "a")
    gh.lockfile(work, "package-lock.json")
    gh.remote_advance(work, "package-lock.json")
    result = sync("--dry-run", "--no-install", str(gh.path / "fan"))
    assert result.status == 0
    assert "lock file changed" not in result.stdout


def test_the_same_state_does_report_an_install_without_the_flag(gh, sync):
    """The other half: without --no-install the same repository says the lock moved."""
    work = gh.create_at(gh.path / "fan", "a")
    gh.lockfile(work, "package-lock.json")
    gh.remote_advance(work, "package-lock.json")
    result = sync("--dry-run", str(gh.path / "fan"))
    assert result.status == 0
    assert "lock file changed" in result.stdout


# --- the environment the report has to survive --------------------------------


def test_prints_under_a_single_byte_locale(gh, run_script):
    """The ✗ in the orchestrator's own status line must not kill the run.

    Only characters this script itself writes are asserted: a repository path
    decodes differently under a single-byte locale on Linux than on macOS, and a
    test that asserted one would be asserting the platform.
    """
    orchestrator = orchestrator_copy(gh, job="import sys\nsys.exit(7)\n")
    gh.create_at(gh.path / "fan", "a")
    result = run_script(
        orchestrator,
        str(gh.path / "fan"),
        env={"LC_ALL": "en_US.ISO8859-1", "PYTHONIOENCODING": "ascii"},
    )
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert "✗ sync script exited with status 7" in result.stdout


def test_a_closed_reader_stops_the_report_not_the_sync(gh, run_with_closed_reader):
    """The report is the reader's business; the branch deletion is not.

    `gh-sync.py <dir> | head` leaves nothing to write to. The prune has already
    run by then, and abandoning the rest would only lose the account of it.
    """
    work = gh.create_at(gh.path / "fan", "a")
    gh.branch_with_work(work, "gone")
    gh.merge_commit(work, "gone")
    status, stderr = run_with_closed_reader(SYNC, str(gh.path / "fan"), unbuffered=True)
    assert status == 0
    assert "Traceback" not in stderr
    assert "gone" not in gh.branches(work)


def test_a_block_buffered_report_fails_at_the_final_flush(gh, run_with_closed_reader):
    """The other closed-reader shape: nothing is written until the run is over.

    A pipe is block buffered, so a report this size reaches the descriptor only at
    the final flush. That is the handler around the flush, not the one in `write`,
    and both have to leave the run exit 0 with nothing on stderr.
    """
    gh.create_at(gh.path / "fan", "a")
    status, stderr = run_with_closed_reader(SYNC, str(gh.path / "fan"))
    assert status == 0
    assert "Traceback" not in stderr


def test_use_utf8_leaves_a_stream_it_cannot_reconfigure_alone():
    """A replaced or detached stdout must not turn one crash into another.

    The two shapes the guard names: an object with no `reconfigure` at all, and a
    real wrapper whose buffer has been taken away, which raises ValueError.
    """
    module = load_orchestrator()
    module.use_utf8(io.StringIO())
    detached = io.TextIOWrapper(io.BytesIO())
    detached.detach()
    module.use_utf8(detached)


# --- parity with the shell version --------------------------------------------


def test_every_scenario_has_a_captured_report():
    """A scenario with no golden would silently assert nothing."""
    assert sorted(SCENARIOS) == sorted(GOLDEN)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_matches_the_shell_report(name, gh, sync):
    """The port prints, byte for byte, what gh-sync.sh printed for this state."""
    argv = SCENARIOS[name](gh)
    result = sync(*argv)
    assert result.status == GOLDEN[name]["status"]
    assert normalise(result.stdout, gh.path) == GOLDEN[name]["stdout"]
