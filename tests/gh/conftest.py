"""Fixtures for the gh plugin: real git repositories in known states.

The port of `fixtures/gh/fixtures.sh`. Every fixture is a real repository with a
real (local, bare) origin, so `git fetch`, `git merge --ff-only`, and worktree
operations all behave exactly as they do in production. Nothing here touches the
network.

`/gh:sync` deletes branches and removes worktrees, so its behaviour is asserted
against real repositories rather than mocks. See `tests/gh/README.md`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
GH_SCRIPTS = ROOT / "plugins" / "gh" / "scripts"
SYNC = GH_SCRIPTS / "gh-sync.py"
SYNC_REPO = GH_SCRIPTS / "gh-sync-repo.py"
SHEPHERD_STATUS = GH_SCRIPTS / "gh-shepherd-status.py"
SHEPHERD_PR = GH_SCRIPTS / "gh-shepherd-pr.py"
DISCOVER = GH_SCRIPTS / "lib" / "discover.py"
STUB_BIN = Path(__file__).resolve().parent / "bin"

DEFAULT_BRANCH = "main"

# Yarn Berry is selected per project through package.json's packageManager field,
# which corepack honours, so these fixtures do not depend on which yarn happens
# to be on PATH. Yarn 1 and bun are out of scope for /gh:sync.
YARN_VERSION = "4.5.3"


# Corepack keeps the package-manager binaries it has downloaded under HOME, and
# the sandbox moves HOME. Without carrying the real cache in, a corepack shim
# starts every install example with an empty cache and reaches the registry to
# refill it, which is slow and, when the network is unavailable, a failure rather
# than a skip (seen locally as a ConnectTimeoutError). Resolved at import time,
# before any fixture has moved HOME. An explicit COREPACK_HOME wins; otherwise
# this is corepack's own per-platform default.
def _real_corepack_home():
    explicit = os.environ.get("COREPACK_HOME")
    if explicit:
        return explicit
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Caches", "node", "corepack")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", home), "node", "corepack")
    cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    return os.path.join(cache, "node", "corepack")


COREPACK_HOME = _real_corepack_home()

LOCKFILE_NAMES = {
    "pnpm": "pnpm-lock.yaml",
    "yarn": "yarn.lock",
    "npm": "package-lock.json",
}

# Written without --lockfile-only for yarn because Berry turns immutable installs
# on by itself whenever CI is set, and an immutable install refuses to create the
# lock file these fixtures exist to write (YN0028). The code under test still
# runs a plain --immutable install; only the fixture opts out.
INSTALL_ARGS = {
    "pnpm": ("pnpm", "install", "--lockfile-only", "--silent"),
    "yarn": ("yarn", "install", "--no-immutable"),
    "npm": ("npm", "install", "--package-lock-only", "--silent"),
}

# A shim that forwards to the real git except for the subcommands it is told to
# fail, so the branches guarding an unreadable ref or worktree list can be
# provoked without corrupting a repository.
GIT_SHIM = """#!/usr/bin/env python3
import os, sys

real = {real!r}
args = sys.argv[1:]
index = 0
while index < len(args):
    if args[index] in ("-C", "-c"):
        index += 2
    elif args[index].startswith("-"):
        index += 1
    else:
        break
tail = args[index:]
for failing in os.environ.get("GIT_STUB_FAIL", "").split(","):
    if failing and " ".join(tail[: len(failing.split())]) == failing:
        sys.stderr.write("git stub: refusing " + failing + "\\n")
        sys.exit(1)
os.execv(real, [real] + args)
"""


class Fixtures:
    """Builders for repositories, pull-request sets, and package-manager projects."""

    def __init__(self, sandbox):
        self.sandbox = sandbox
        self.path = sandbox.path
        self.prs_file = self.path / "prs.json"

    # ------------------------------------------------------------- git ---

    def git(self, directory, *args, **kwargs):
        """git in `directory`, isolated from the developer's real git config.

        It may set a different default branch, sign commits, or install hooks,
        any of which would change what a fixture actually produces.
        """
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(directory),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                *[str(arg) for arg in args],
            ],
            capture_output=True,
        )
        if kwargs.get("check", True) and completed.returncode != 0:
            raise AssertionError(
                "git {} failed in {}: {}".format(
                    " ".join(str(a) for a in args),
                    directory,
                    completed.stderr.decode("utf-8", "replace"),
                )
            )
        return completed.stdout.decode("utf-8", "replace").strip()

    # ---------------------------------------------------- constructors ---

    def _seed(self, bare, work):
        if subprocess.run(
            ["git", "init", "-q", "--bare", "--initial-branch=" + DEFAULT_BRANCH, str(bare)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode:
            subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
        subprocess.run(
            ["git", "clone", "-q", str(bare), str(work)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        self.git(work, "checkout", "-q", "-B", DEFAULT_BRANCH)
        (Path(work) / "file.txt").write_text("base\n")
        self.git(work, "add", "-A")
        self.git(work, "commit", "-qm", "base")
        self.git(work, "push", "-q", "-u", "origin", DEFAULT_BRANCH)
        self.git(work, "remote", "set-head", "origin", "--auto", check=False)
        return Path(work)

    def create(self, root):
        """The work tree at <root>/work, with the bare origin at <root>/origin.git.

        Use it for single-repo tests.
        """
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        return self._seed(root / "origin.git", root / "work")

    def create_at(self, parent, name):
        """The work tree at <parent>/<name>, with the origin in <parent>/.origins.

        Use it for fan-out tests, where the scanned directory must contain work
        trees and nothing else. The origins directory is hidden, so the
        non-recursive scan skips it.
        """
        parent = Path(parent)
        (parent / ".origins").mkdir(parents=True, exist_ok=True)
        return self._seed(parent / ".origins" / (name + ".git"), parent / name)

    # ------------------------------------------------------- primitives ---

    def commit(self, work, message, file="file.txt", content=None):
        with open(Path(work) / file, "a", encoding="utf-8") as handle:
            handle.write((message if content is None else content) + "\n")
        self.git(work, "add", "-A")
        self.git(work, "commit", "-qm", message)

    def push(self, work, branch=DEFAULT_BRANCH):
        self.git(work, "push", "-q", "origin", branch)

    def branch(self, work, name, start=DEFAULT_BRANCH):
        """Create the branch and leave the checkout on the default branch."""
        self.git(work, "branch", name, start)

    def branch_with_work(self, work, name):
        """A branch carrying one real commit."""
        self.git(work, "checkout", "-q", "-b", name)
        self.commit(work, "work on " + name, name + ".txt", name)
        self.git(work, "checkout", "-q", DEFAULT_BRANCH)

    def merge_ff(self, work, name):
        """Fast-forward into the default branch, leaving the branch AT the tip.

        Ancestry finds it, but the tip guard takes over before ancestry matters.
        """
        self.git(work, "merge", "-q", "--ff-only", name)
        self.push(work)

    def merge_commit(self, work, name):
        """Merge with a merge commit, leaving the branch strictly BEHIND the tip.

        This is what a pull request merged with the "merge commit" strategy
        leaves behind, and it is the state in which ancestry is the interesting
        signal.
        """
        self.git(work, "merge", "-q", "--no-ff", "-m", "Merge " + name, name)
        self.push(work)

    def merge_squash(self, work, name):
        """Squash into the default branch, leaving NO ancestry.

        Only a pull-request signal can prove this one.
        """
        self.git(work, "merge", "-q", "--squash", name)
        self.git(work, "commit", "-qm", "squash " + name)
        self.push(work)

    def dirty(self, work, file="file.txt"):
        """An uncommitted change to a TRACKED file, which blocks a sync."""
        with open(Path(work) / file, "a", encoding="utf-8") as handle:
            handle.write("dirty\n")

    def untracked(self, work, file="untracked.txt"):
        """An untracked file, which must NOT block a sync."""
        (Path(work) / file).write_text("untracked\n")

    def corrupt_index(self, work):
        """git status then exits non-zero with empty stdout.

        Resolves the real git dir rather than assuming <work>/.git is a
        directory, which it is not in a linked worktree.
        """
        gitdir = self.git(work, "rev-parse", "--absolute-git-dir")
        (Path(gitdir) / "index").write_text("GARBAGE")

    def in_progress(self, work, marker):
        """Leave a git operation marker, e.g. rebase-merge or MERGE_HEAD."""
        gitdir = Path(self.git(work, "rev-parse", "--absolute-git-dir"))
        if "-" in marker:
            (gitdir / marker).mkdir(parents=True, exist_ok=True)
        else:
            (gitdir / marker).write_text(self.git(work, "rev-parse", "HEAD") + "\n")

    def worktree(self, work, path, branch):
        self.git(work, "worktree", "add", "-q", str(path), branch)

    def diverge(self, work):
        """A local-only commit plus an origin-only commit, so no fast-forward."""
        clone = self._clone_origin(work)
        self.commit(clone, "origin side")
        self.push(clone)
        shutil.rmtree(clone.parent)
        self.commit(work, "local side", "local.txt", "local")

    def lockfile(self, work, name, content='{"lockfileVersion":3}'):
        """Commit a lock file and push it."""
        (Path(work) / name).write_text(content + "\n")
        (Path(work) / "package.json").write_text('{"name":"fixture"}\n')
        self.git(work, "add", "-A")
        self.git(work, "commit", "-qm", "add " + name)
        self.push(work)

    def remote_advance(self, work, file="file.txt"):
        """Origin gains a commit the clone lacks, so the branch can fast-forward."""
        clone = self._clone_origin(work)
        self.commit(clone, "remote advance", file, "advanced")
        self.push(clone)
        shutil.rmtree(clone.parent)

    def remove_origin(self, work):
        self.git(work, "remote", "remove", "origin")

    def lock_index(self, work):
        """An index lock: tolerated by git status, refused by anything updating refs.

        Lets a mid-run git failure be provoked without corrupting anything.
        """
        gitdir = self.git(work, "rev-parse", "--absolute-git-dir")
        (Path(gitdir) / "index.lock").write_text("")

    def break_origin(self, work):
        """The remote exists but is unreachable, so fetch fails and preflight passes."""
        self.git(work, "remote", "set-url", "origin", "/nonexistent/gone.git")

    def forget_origin_head(self, work):
        """Drop the cached origin/HEAD, forcing the later resolution strategies.

        It is a *symbolic* ref, so it has to be deleted as one; `update-ref -d`
        leaves it resolvable and the resolution never falls through.
        """
        self.git(work, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD", check=False)

    def drop_remote_branches(self, work):
        """Remove every remote-tracking branch, so no default branch resolves."""
        refs = self.git(work, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/")
        for ref in refs.split("\n"):
            if ref:
                self.git(work, "update-ref", "-d", ref)

    def sha(self, work, rev):
        return self.git(work, "rev-parse", rev)

    def _clone_origin(self, work):
        origin = self.git(work, "remote", "get-url", "origin")
        scratch = Path(self.sandbox.path) / (f"scratch-{next(_counter)}")
        scratch.mkdir()
        subprocess.run(
            ["git", "clone", "-q", origin, str(scratch / "c")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return scratch / "c"

    def git_shim(self, *failing):
        """A PATH whose git refuses the named subcommands and forwards the rest."""
        directory = Path(self.sandbox.path) / (f"git-shim-{next(_counter)}")
        directory.mkdir()
        (directory / "git").write_text(GIT_SHIM.format(real=shutil.which("git")))
        (directory / "git").chmod(0o755)
        return str(directory), ",".join(failing)

    # ------------------------------------------------ package managers ---

    def lockfile_name(self, manager):
        return LOCKFILE_NAMES[manager]

    def _write_package_json(self, directory, manager, name):
        """Berry is pinned per project through packageManager, which corepack honours."""
        if manager == "yarn":
            body = {"name": name, "version": "1.0.0", "packageManager": "yarn@" + YARN_VERSION}
        else:
            body = {"name": name, "version": "1.0.0"}
        (Path(directory) / "package.json").write_text(json.dumps(body) + "\n")

    def _install(self, directory, manager):
        """Write the lock file without fetching anything.

        Reports the package manager's own output on failure rather than
        swallowing it: a silent failure here surfaces as an unexplained
        assertion much later.

        The developer's own ~/.npmrc is kept out of it: it may reference
        registries or auth tokens that are unavailable, which would make an
        offline install fail for reasons that have nothing to do with the code
        under test.
        """
        env = dict(os.environ)
        env["NPM_CONFIG_USERCONFIG"] = "/dev/null"
        env["npm_config_userconfig"] = "/dev/null"
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        env["COREPACK_HOME"] = COREPACK_HOME
        completed = subprocess.run(
            list(INSTALL_ARGS[manager]),
            cwd=str(directory),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
        )
        if completed.returncode:
            output = completed.stdout.decode("utf-8", "replace")
            raise AssertionError(
                "fixture: {} install failed in {} (exit {})\n{}".format(
                    manager, directory, completed.returncode, "\n".join(output.splitlines()[-20:])
                )
            )

    def _require_lock(self, directory, manager):
        """Fail loudly if no lock file was written.

        A package manager that cannot satisfy its pinned version may print
        guidance and still exit 0.
        """
        lock = LOCKFILE_NAMES[manager]
        if not (Path(directory) / lock).is_file():
            raise AssertionError(f"fixture: {manager} produced no {lock} in {directory}")

    def js_project(self, work, manager="pnpm"):
        """A package.json and lock file with no dependencies, installable offline.

        pnpm is the default: it is the house package manager and the branch
        gh-sync-repo.py checks first. Yarn means Berry; yarn 1 and bun are out of
        scope for /gh:sync and have no fixtures.
        """
        self._write_package_json(work, manager, "fixture")
        if manager == "yarn":
            # Berry writes a PnP bundle and a cache directory beside the lock
            # file. Neither belongs in the fixture's history.
            (Path(work) / ".gitignore").write_text(".yarn/\n.pnp.*\n")
        self._install(work, manager)
        self._require_lock(work, manager)
        self.git(work, "add", "-A")
        self.git(work, "commit", "-qm", f"add {manager} project")
        self.push(work)

    def remote_update_lock(self, work, manager="pnpm"):
        """Origin legitimately regenerates the lock file.

        The change is a dependency on a directory inside the repo. Every manager
        records a real dependency, and a file: path resolves without the network,
        so one mechanism covers all three. Perturbing manager-specific fields
        does not survive: pnpm 10 records an override for a package nothing
        depends on and pnpm 11 drops it, which passed locally and failed in CI.
        Appending to a lock file, as remote_advance would, corrupts it instead.
        """
        clone = self._clone_origin(work)
        (clone / "local-dep").mkdir()
        (clone / "local-dep" / "package.json").write_text(
            '{"name":"local-dep","version":"1.0.0"}\n'
        )
        manifest = json.loads((clone / "package.json").read_text())
        manifest["dependencies"] = {"local-dep": "file:./local-dep"}
        (clone / "package.json").write_text(json.dumps(manifest) + "\n")
        self._install(clone, manager)
        self._require_lock(clone, manager)
        self.git(clone, "add", "-A")
        self.git(clone, "commit", "-qm", "add a local dependency")
        self.push(clone)
        shutil.rmtree(clone.parent)

    def remote_break_lock(self, work, lock="pnpm-lock.yaml"):
        """Origin pushes a lock file that cannot be parsed, so the install fails."""
        clone = self._clone_origin(work)
        (clone / lock).write_text("not: [valid\n")
        self.git(clone, "add", "-A")
        self.git(clone, "commit", "-qm", "break the lock file")
        self.push(clone)
        shutil.rmtree(clone.parent)

    def remote_drop_lockfile(self, work, lock="pnpm-lock.yaml"):
        """Origin deletes the lock file: a lock change with nothing left to install."""
        clone = self._clone_origin(work)
        (clone / lock).unlink()
        self.git(clone, "add", "-A")
        self.git(clone, "commit", "-qm", "drop lock file")
        self.push(clone)
        shutil.rmtree(clone.parent)

    # ------------------------------------------------- pull-request sets ---

    def pr(self, head_ref, head_oid, base=DEFAULT_BRANCH, cross=False):
        """One merged pull request, for composing a canned set."""
        return {
            "headRefName": head_ref,
            "headRefOid": head_oid,
            "baseRefName": base,
            "isCrossRepository": cross,
            "state": "MERGED",
        }

    def write_prs(self, *pulls):
        self.prs_file.write_text(json.dumps(list(pulls)) + "\n")

    def no_prs(self):
        self.write_prs()

    def many_prs(self, count, *pulls):
        """`count` filler pull requests, followed by any given explicitly.

        When `count` is at least the script's bulk lookup limit, anything
        appended is past the window: invisible to the bulk query and reachable
        only by asking about that branch directly. With a smaller count the
        appended entries are visible to both, so the limit has to be passed
        deliberately to exercise the fallback.
        """
        filler = [self.pr(f"old-{i}", str(i)) for i in range(count)]
        self.write_prs(*(filler + list(pulls)))

    def dep_pr(self, number, **keys):
        """One `dependencies` pull request as the shepherd scripts see it.

        Keys and defaults:
          state=OPEN          OPEN | MERGED | CLOSED
          merge=CLEAN         mergeStateStatus: CLEAN | BEHIND | DIRTY | BLOCKED
          checks=passed       passed | failed | pending | none | mixed (one of each)
                              | neutral (NEUTRAL and SKIPPED conclusions only)
                              | cancelled (a CANCELLED run beside a success)
                              | null-conclusion (COMPLETED with conclusion null)
                              | status-failed | status-pending | status-passed
                                (StatusContext rows, the older commit-status shape)
          auto=True           auto-merge enabled
          bot=True            authored by app/dependabot; False gives a human
          draft=False
          risk=               merge-risk band label to add: low | medium | high
          created=            createdAt; defaults to 2026-01-<number>T00:00:00Z
          head=               headRefOid; defaults to sha<number>
        """
        known = {
            "state": "OPEN",
            "merge": "CLEAN",
            "checks": "passed",
            "auto": True,
            "bot": True,
            "draft": False,
            "risk": "",
            "created": "",
            "head": "",
        }
        for key, value in keys.items():
            if key not in known:
                raise ValueError(f"unknown key {key}={value}")
            known[key] = value
        created = known["created"] or f"2026-01-{number:02d}T00:00:00Z"
        head = known["head"] or f"sha{number}"
        labels = [{"name": "dependencies"}]
        if known["risk"]:
            labels.append({"name": "merge-risk:" + known["risk"]})
        return {
            "number": number,
            "title": f"build(deps): bump dep-{number}",
            "state": known["state"],
            "isDraft": known["draft"],
            "author": (
                {"login": "app/dependabot", "is_bot": True}
                if known["bot"]
                else {"login": "someone", "is_bot": False}
            ),
            "labels": labels,
            "autoMergeRequest": {"mergeMethod": "MERGE"} if known["auto"] else None,
            "mergeStateStatus": known["merge"],
            "mergeable": "CONFLICTING" if known["merge"] == "DIRTY" else "MERGEABLE",
            "headRefOid": head,
            "headRefName": f"dependabot/npm/dep-{number}",
            "baseRefName": "main",
            "createdAt": created,
            "mergeCommit": ({"oid": f"merged{number}"} if known["state"] == "MERGED" else None),
            "statusCheckRollup": _rollup(number, known["checks"]),
        }

    # ------------------------------------------------------ assertions ---

    def branches(self, work):
        return self.git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split()

    def head_sha(self, work):
        return self.git(work, "rev-parse", "HEAD")

    def current_branch(self, work):
        return self.git(work, "rev-parse", "--abbrev-ref", "HEAD")


def _check_run(number, name, status, conclusion):
    return {
        "__typename": "CheckRun",
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "detailsUrl": f"https://github.com/acme/widgets/actions/runs/1{number}/job/2{number}",
    }


def _status_context(state):
    return {
        "__typename": "StatusContext",
        "context": "ci/legacy",
        "state": state,
        "targetUrl": "https://ci.example/1",
    }


# One entry per arm the stub's check-state fold can take. Values that share an
# arm share a shape; what needs its own shape is each arm.
ROLLUP_SHAPES = {
    "passed": (("test", "COMPLETED", "SUCCESS"), ("lint", "COMPLETED", "SKIPPED")),
    "failed": (("test", "COMPLETED", "SUCCESS"), ("build", "COMPLETED", "FAILURE")),
    "pending": (("test", "COMPLETED", "SUCCESS"), ("build", "IN_PROGRESS", None)),
    "mixed": (("test", "IN_PROGRESS", None), ("build", "COMPLETED", "FAILURE")),
    "neutral": (("lint", "COMPLETED", "NEUTRAL"), ("docs", "COMPLETED", "SKIPPED")),
    "cancelled": (("test", "COMPLETED", "SUCCESS"), ("build", "COMPLETED", "CANCELLED")),
    "null-conclusion": (("test", "COMPLETED", "SUCCESS"), ("build", "COMPLETED", None)),
}

# The older commit-status shape, which the fold reads by .state rather than by
# .status and .conclusion.
STATUS_SHAPES = {
    "status-failed": "FAILURE",
    "status-pending": "PENDING",
    "status-passed": "SUCCESS",
}


def _rollup(number, checks):
    """The statusCheckRollup for one named check shape."""
    if checks in STATUS_SHAPES:
        return [_status_context(STATUS_SHAPES[checks])]
    return [_check_run(number, *shape) for shape in ROLLUP_SHAPES.get(checks, ())]


def _counter_gen():
    value = 0
    while True:
        value += 1
        yield value


_counter = _counter_gen()


@pytest.fixture
def gh(sandbox, monkeypatch):
    """A sandbox holding one repository, an empty canned PR set, and the stub gh.

    The counterpart of `setup_sandbox` in `spec/spec_helper.sh`.
    """
    fixtures = Fixtures(sandbox)
    fixtures.no_prs()
    monkeypatch.setenv("GH_FIXTURE_PRS", str(fixtures.prs_file))
    monkeypatch.delenv("GH_FIXTURE_FAIL", raising=False)
    monkeypatch.delenv("GH_FIXTURE_FAIL_HEAD", raising=False)
    monkeypatch.delenv("GH_FIXTURE_FAIL_REBASE", raising=False)
    monkeypatch.delenv("GH_FIXTURE_FAIL_COMMENT", raising=False)
    monkeypatch.delenv("GH_FIXTURE_WATCH_HANG", raising=False)
    monkeypatch.delenv("GH_FIXTURE_RUNS", raising=False)
    monkeypatch.delenv("GH_FIXTURE_RUN_LOG", raising=False)
    monkeypatch.delenv("GH_FIXTURE_CALL_LOG", raising=False)
    monkeypatch.delenv("GH_SYNC_DRY_RUN", raising=False)
    monkeypatch.delenv("GH_SYNC_NO_INSTALL", raising=False)
    # Corepack asks before downloading a package manager it does not have, which
    # would hang a run rather than fail it. Set for the whole example, so the
    # install the code under test performs inherits it too.
    monkeypatch.setenv("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
    sandbox.stub_path(STUB_BIN)
    fixtures.repo = fixtures.create(sandbox.path / "r")
    return fixtures


@pytest.fixture(autouse=True)
def corepack_cache(request, monkeypatch):
    """The developer's real corepack cache, for the examples marked `slow`.

    The sandbox HOME has no corepack cache, so without this a corepack shim
    downloads a package manager over the network on every install example. Only
    those examples run one, so only they get it: reading the developer's real
    cache is a dependency on the machine, and an example that does not need a
    package manager must not quietly acquire one.
    """
    if request.node.get_closest_marker("slow") is not None:
        monkeypatch.setenv("COREPACK_HOME", COREPACK_HOME)


@pytest.fixture
def sync_repo(run_script, gh):
    """Run gh-sync-repo.py against a fixture repository."""

    def run(*args, **kwargs):
        return run_script(SYNC_REPO, *args, **kwargs)

    return run


@pytest.fixture
def sync(run_script, gh):
    """Run gh-sync.py, the orchestrator, against a fixture directory."""

    def run(*args, **kwargs):
        return run_script(SYNC, *args, **kwargs)

    return run


@pytest.fixture
def shepherd_status(run_script, gh):
    """Run gh-shepherd-status.py against a fixture repository."""

    def run(*args, **kwargs):
        return run_script(SHEPHERD_STATUS, *args, **kwargs)

    return run


@pytest.fixture
def shepherd_pr(run_script, gh):
    """Run gh-shepherd-pr.py against a fixture repository."""

    def run(*args, **kwargs):
        return run_script(SHEPHERD_PR, *args, **kwargs)

    return run


def probe_env():
    """The environment the probes run under: the same corepack cache the tests use.

    A probe that resolved against a different cache would answer a question the
    examples never ask, and a manager could pass the probe and then download.
    """
    env = dict(os.environ)
    env["COREPACK_HOME"] = COREPACK_HOME
    env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
    return env


def has_working(manager):
    """Is this package manager both installed and actually able to run?

    A corepack shim for a Node version it does not support resolves fine and then
    fails, which would surface as a confusing test failure rather than a skip.
    """
    if shutil.which(manager) is None:
        return False
    completed = subprocess.run(
        [manager, "--version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=probe_env(),
    )
    return completed.returncode == 0


def has_yarn_berry(tmp_path):
    """Berry is resolved from packageManager, which only the corepack shim honours.

    A globally installed yarn 1 ignores that field and would fail the test rather
    than skip it, so probe what yarn actually resolves to in a project that asks
    for Berry.
    """
    if shutil.which("yarn") is None:
        return False
    probe = Path(tmp_path) / "yarn-probe"
    probe.mkdir(parents=True, exist_ok=True)
    (probe / "package.json").write_text(
        json.dumps({"name": "probe", "version": "1.0.0", "packageManager": "yarn@" + YARN_VERSION})
        + "\n"
    )
    completed = subprocess.run(
        ["yarn", "--version"],
        cwd=str(probe),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=probe_env(),
    )
    if completed.returncode:
        return False
    version = completed.stdout.decode("utf-8", "replace").strip()
    major = version.split(".")[0]
    return major.isdigit() and int(major) >= 2


sys.path.insert(0, str(GH_SCRIPTS))
