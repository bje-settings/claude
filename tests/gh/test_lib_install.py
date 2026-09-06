"""Direct tests for `lib/install.py`: one per lock-file detection arm.

pnpm, Yarn Berry, npm, none, and the precedence between them. The install tests
in `test_gh_sync_repo_edges.py` run the real managers and are skipped wherever
one is missing, so these are what hold the detection itself.
"""

from __future__ import annotations

import os
import stat

import pytest
from lib import install


def touch(directory, name):
    (directory / name).write_text("{}\n")


@pytest.mark.parametrize(
    ("lockfile", "expected"),
    [
        ("pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]),
        ("yarn.lock", ["yarn", "install", "--immutable"]),
        ("package-lock.json", ["npm", "ci"]),
    ],
)
def test_each_lock_file_selects_its_manager(tmp_path, lockfile, expected):
    touch(tmp_path, lockfile)
    assert install.install_command(str(tmp_path)) == expected


def test_no_lock_file_selects_nothing(tmp_path):
    assert install.install_command(str(tmp_path)) is None


def test_pnpm_wins_when_several_lock_files_are_present(tmp_path):
    """The order is the detection: pnpm is the house package manager."""
    for name in install.LOCKFILES:
        touch(tmp_path, name)
    assert install.install_command(str(tmp_path))[0] == "pnpm"


def test_install_deps_reports_no_lock_file_rather_than_failing(tmp_path):
    status, log = install.install_deps(str(tmp_path))
    assert status == install.NO_LOCKFILE
    assert log == ""


def test_install_deps_runs_the_manager(tmp_path, monkeypatch):
    """A stub npm, so the arm is exercised without a registry or a network."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "npm"
    stub.write_text("#!/bin/sh\necho installed\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ["PATH"])
    project = tmp_path / "project"
    project.mkdir()
    touch(project, "package-lock.json")
    status, log = install.install_deps(str(project))
    assert status == 0
    assert "installed" in log


def test_install_deps_reports_a_manager_that_is_not_installed(tmp_path, sandbox, monkeypatch):
    """A missing package manager has to reach the report, not raise."""
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    (tmp_path / "empty").mkdir()
    touch(tmp_path, "pnpm-lock.yaml")
    status, log = install.install_deps(str(tmp_path))
    assert status == 127
    assert "pnpm: command not found" in log


def test_install_deps_returns_the_managers_own_status(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "npm"
    stub.write_text("#!/bin/sh\necho 'nope' >&2\nexit 9\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ["PATH"])
    project = tmp_path / "project"
    project.mkdir()
    touch(project, "package-lock.json")
    status, log = install.install_deps(str(project))
    assert status == 9
    assert "nope" in log


def test_install_deps_reports_a_manager_that_cannot_be_run(tmp_path, monkeypatch):
    """Present but unrunnable is not "command not found".

    A lock file whose manager is on PATH without the execute bit fails with a
    different errno, and reporting it as missing sends the reader looking for an
    install that is already there. 126 rather than 127, which is the pair of
    statuses a shell uses for exactly this distinction.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "npm"
    stub.write_text("#!/bin/sh\necho installed\n")
    stub.chmod(0o644)
    monkeypatch.setenv("PATH", str(bin_dir))
    project = tmp_path / "project"
    project.mkdir()
    touch(project, "package-lock.json")
    status, log = install.install_deps(str(project))
    assert status == 126
    assert log.startswith("npm: ")
    assert "command not found" not in log
