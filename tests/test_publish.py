"""scripts/publish-plugin.py -- mirroring one plugin into a downstream repo.

The script deletes and overwrites, so every arm here comes in a pair: it acts
when it should, and it refuses when it should. Both halves assert against real
git repositories built in the sandbox, never against mocked git, for the reason
`tests/gh/README.md` gives -- a mock would agree with whatever the code believed.

TWO WAYS OF DRIVING IT, on purpose:

`invoke` loads the real script by path and calls `main` in-process with its ROOT
pointed at a fixture marketplace. That is what most examples use, because the
script derives its source repository from its own `__file__`: a copy placed in a
fixture would be a different file, and coverage.py -- whose `source` entries are
relative and re-resolved in every measured child -- would not count it.

`run_script` drives a copy as its own process, the way Claude Code runs it, for
the handful of contracts that only exist at the process boundary: the exit
codes, a single-byte locale, and a reader that has gone away. Those runs are not
measured, which is precisely why the in-process examples carry the arms.

NEVER pass `cwd=` to `run_script` here. Coverage `source` entries are relative
and coverage.py re-reads its config in each measured child, so a child started
inside a fixture would resolve `plugins/` and `scripts/` against that fixture
rather than against the checkout.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "publish-plugin.py"

# The fixture plugin. Deliberately not a copy of a real one: it needs to be small
# enough to reason about, and it needs one executable file, one nested directory
# and one file that is neither, because those are the three shapes the mirror
# treats differently.
PLUGIN = "demo"
MANIFEST = {
    "name": PLUGIN,
    "description": "A fixture plugin.",
    "version": "1.0.0",
    "license": "MIT",
}
FILES = {
    ".claude-plugin/plugin.json": json.dumps(MANIFEST, indent=2) + "\n",
    "LICENSE": "MIT License\n\nCopyright (c) 2026 Example\n",
    "README.md": "# demo\n",
    "skills/thing/SKILL.md": "---\nname: thing\n---\n\nDo the thing.\n",
    "skills/thing/FLOW.md": "```mermaid\nflowchart TD\n    A --> B\n```\n",
}
EXECUTABLE = "scripts/run.py"
EXECUTABLE_BODY = "#!/usr/bin/env python3\nprint('hi')\n"


def git(repo, *args, check=True):
    """Run git in `repo` with an identity of its own.

    The sandbox moves HOME, and the checkout this suite runs from may have
    GIT_CONFIG_GLOBAL pointed somewhere by direnv, so nothing about the author's
    machine is allowed to decide whether a fixture commit succeeds.
    """
    done = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        capture_output=True,
        check=False,
    )
    if check and done.returncode != 0:
        raise AssertionError(
            "git {} failed in {}: {}".format(
                " ".join(args), repo, done.stderr.decode("utf-8", "replace")
            )
        )
    return done.stdout.decode("utf-8", "replace").strip()


def index_modes(repo, path):
    """The index mode git records for one path, or None."""
    listing = git(repo, "ls-files", "-s", "--", path)
    for line in listing.splitlines():
        if line.strip():
            return line.split()[0]
    return None


def make_repo(path, origin="https://github.com/example/upstream.git"):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    if origin is not None:
        git(path, "remote", "add", "origin", origin)
    return path


def write(path, text, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if executable:
        path.chmod(path.stat().st_mode | 0o111)


def commit_all(repo, message="fixture"):
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def tree(root):
    """Every file under `root` as {relative path: (bytes, is-executable)}.

    Walks `.git/` too, so this is a content assertion, never a before/after
    snapshot -- use `untouched()` for that.
    """
    found = {}
    for current, _, names in os.walk(str(root)):
        for name in names:
            path = Path(current) / name
            found[str(path.relative_to(root))] = (
                path.read_bytes(),
                bool(path.stat().st_mode & stat.S_IXUSR),
            )
    return found


def untouched(repo):
    """The property a refusal (or a no-op) actually promises: nothing written,
    nothing committed.

    `.git` is pruned from the walk on purpose. Git rewrites files under it --
    `.git/objects/maintenance.lock`, created and removed around auto-maintenance
    that an ordinary read-only command can trigger, is the case #140 hit -- so
    its bytes are git's own state, not the destination's content, and a
    before/after diff that includes them is racy under xdist. `git status` and
    `rev-parse HEAD` are what stand in for "nothing changed in git" instead.
    """
    found = {}
    for current, dirs, names in os.walk(str(repo)):
        if ".git" in dirs:
            dirs.remove(".git")
        for name in names:
            path = Path(current) / name
            found[str(path.relative_to(repo))] = (
                path.read_bytes(),
                bool(path.stat().st_mode & stat.S_IXUSR),
            )
    try:
        status = git(repo, "status", "--porcelain", "--untracked-files=all", check=False)
        head = git(repo, "rev-parse", "HEAD", check=False)
    except OSError:
        # A handful of examples deliberately remove git from PATH, or replace it
        # with a stub that always fails, to prove the script under test refuses
        # gracefully. Without git on PATH nothing could have written through it
        # either, so the file walk above is what the comparison rests on; a
        # failed git call is otherwise reported as an empty result (check=False)
        # rather than raised, so a consistently-failing git still compares equal
        # before and after.
        status, head = None, None
    return found, status, head


@pytest.fixture
def marketplace(sandbox):
    """A source repo shaped like this one: plugins/<name>/, an origin, a commit."""
    repo = make_repo(sandbox / "marketplace")
    for relative, body in FILES.items():
        write(repo / "plugins" / PLUGIN / relative, body)
    write(repo / "plugins" / PLUGIN / EXECUTABLE, EXECUTABLE_BODY, executable=True)
    write(repo / "README.md", "# marketplace\n")
    commit_all(repo, "add the demo plugin")
    return repo


@pytest.fixture
def downstream(sandbox):
    """A destination repo with a commit, and a neighbouring plugin it owns.

    The neighbour sits inside `plugins/` but outside `plugins/<name>/`, which is
    the boundary that matters: the destination is not a delivery vehicle for one
    plugin, and the mirror must leave everything beside its own directory alone.
    """
    repo = make_repo(sandbox / "downstream", origin="https://github.com/example/downstream.git")
    write(repo / "README.md", "# downstream\n")
    write(repo / "plugins" / "neighbour" / "keep.md", "a plugin this repo owns\n")
    commit_all(repo, "init")
    return repo


@pytest.fixture
def publish(marketplace):
    """The real script, loaded by path, with its ROOT pointed at the fixture.

    Loaded inside the fixture rather than at module scope, because CLAUDE.md is
    explicit that an in-process loader must not cache a script module across
    tests. Note this script has no `lib/` and no sys.path.insert by design, so
    the conftest's `lib` reset is not what makes this safe -- the fresh load is.
    """
    spec = importlib.util.spec_from_file_location("publish_plugin_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = marketplace
    return module


def invoke(publish, *argv, capsys=None):
    """`main(argv)`, returning (status, stdout, stderr)."""
    status = publish.main([str(arg) for arg in argv])
    captured = capsys.readouterr()
    return status, captured.out, captured.err


# --------------------------------------------------------------------------
# the fixtures' own claims
#
# Asserted here so that nothing below can pass for the wrong reason: a fixture
# that quietly stopped producing a git repo, an origin, or an executable file
# would make most of the refusal examples vacuous.
# --------------------------------------------------------------------------


def test_the_marketplace_fixture_is_a_git_repo_with_an_origin(marketplace):
    """builds a source repo with a committed plugin and an origin"""
    assert (marketplace / ".git").exists()
    assert git(marketplace, "remote", "get-url", "origin").endswith("upstream.git")
    assert git(marketplace, "status", "--porcelain") == ""
    tracked = git(marketplace, "ls-files", "--", "plugins/demo").splitlines()
    assert len(tracked) == len(FILES) + 1


def test_the_marketplace_fixture_tracks_the_executable_bit(marketplace):
    """records the executable file as 100755 in the index

    The mode is the thing several examples below turn on, and git is the only
    place it is authoritative.
    """
    listing = git(marketplace, "ls-files", "-s", "--", "plugins/demo")
    modes = dict(
        (line.split("\t")[1].split("plugins/demo/")[1], line.split()[0])
        for line in listing.splitlines()
    )
    assert modes[EXECUTABLE] == "100755"
    assert modes["README.md"] == "100644"


def test_the_downstream_fixture_has_a_neighbour_it_owns(downstream):
    """gives the destination a plugin of its own, outside the mirrored path

    The destination is not a delivery vehicle for one plugin; it has neighbours,
    and the mirror must never touch them.
    """
    assert (downstream / "plugins" / "neighbour" / "keep.md").is_file()
    assert git(downstream, "status", "--porcelain") == ""


def test_untouched_changes_when_the_working_tree_gains_a_file(downstream):
    """treats a new file in the working tree as a real change"""
    before = untouched(downstream)
    write(downstream / "plugins" / "neighbour" / "extra.md", "new content\n")
    assert untouched(downstream) != before


def test_untouched_changes_when_a_commit_moves_head(downstream):
    """treats a new commit as a real change, because HEAD moved"""
    before = untouched(downstream)
    write(downstream / "README.md", "# downstream, edited\n")
    commit_all(downstream, "edit")
    assert untouched(downstream) != before


def test_untouched_is_blind_to_a_file_written_and_removed_inside_git(downstream):
    """does not see a file created and removed inside .git/, the racy case #140 hit

    Git creates and removes files like `.git/objects/maintenance.lock` around
    auto-maintenance triggered by its own read-only commands. The property this
    helper checks -- working tree, `git status`, and `HEAD` -- must stay equal
    across that, in both directions: while the file exists, and after it is gone
    again.
    """
    before = untouched(downstream)
    lock = downstream / ".git" / "objects" / "maintenance.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("held\n", encoding="utf-8")
    try:
        assert untouched(downstream) == before
    finally:
        lock.unlink()
    assert untouched(downstream) == before


# --------------------------------------------------------------------------
# it acts when it should
# --------------------------------------------------------------------------


def test_first_publish_creates_the_copy(publish, downstream, capsys):
    """mirrors every tracked file into a destination that has none yet"""
    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK

    copy = downstream / "plugins" / PLUGIN
    assert sorted(tree(copy)) == sorted(list(FILES) + [EXECUTABLE, publish.PROVENANCE])
    for relative, body in FILES.items():
        assert (copy / relative).read_text(encoding="utf-8") == body
    assert "published plugins/demo" in out


def test_the_executable_bit_travels_with_the_file(publish, downstream, capsys):
    """preserves 100755 on the copy, and leaves every other file unexecutable"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    copy = downstream / "plugins" / PLUGIN
    assert tree(copy)[EXECUTABLE][1] is True
    assert tree(copy)["README.md"][1] is False


def test_the_license_is_copied_with_no_special_case(publish, downstream, capsys):
    """publishes LICENSE because it is committed, not because it is named"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    copied = (downstream / "plugins" / PLUGIN / "LICENSE").read_text(encoding="utf-8")
    assert copied == FILES["LICENSE"]


def test_provenance_records_where_the_content_came_from(publish, marketplace, downstream, capsys):
    """writes UPSTREAM.json with the source, plugin, version and commit"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    record = json.loads(
        (downstream / "plugins" / PLUGIN / publish.PROVENANCE).read_text(encoding="utf-8")
    )
    assert record["source"] == "example/upstream"
    assert record["plugin"] == PLUGIN
    assert record["version"] == "1.0.0"
    assert record["commit"] == git(marketplace, "log", "-1", "--format=%H", "--", "plugins/demo")
    assert len(record["published"]) == len("2026-09-09")


def test_the_recorded_commit_is_plugin_scoped_not_head(publish, marketplace, downstream, capsys):
    """records the last commit that touched the plugin, not the repo HEAD

    A commit elsewhere in the marketplace moves HEAD without changing a byte of
    the copy. Recording HEAD would put a meaningless diff in every sync.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    first = json.loads(
        (downstream / "plugins" / PLUGIN / publish.PROVENANCE).read_text(encoding="utf-8")
    )["commit"]

    write(marketplace / "README.md", "# marketplace, edited elsewhere\n")
    commit_all(marketplace, "unrelated work")
    assert git(marketplace, "rev-parse", "HEAD") != first

    status, _, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    second = json.loads(
        (downstream / "plugins" / PLUGIN / publish.PROVENANCE).read_text(encoding="utf-8")
    )["commit"]
    assert second == first


def test_republishing_unchanged_content_writes_nothing(publish, downstream, capsys):
    """is idempotent, so any diff downstream is real content

    This is what lets a reviewer downstream treat every sync diff as meaningful
    instead of learning to wave through a date bump.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    before = untouched(downstream)

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "already in sync" in out
    assert untouched(downstream) == before


def test_a_changed_file_propagates(publish, marketplace, downstream, capsys):
    """updates a file whose content moved upstream"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    write(marketplace / "plugins" / PLUGIN / "README.md", "# demo, revised\n")
    commit_all(marketplace, "revise the readme")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "update  README.md" in out
    assert (downstream / "plugins" / PLUGIN / "README.md").read_text(
        encoding="utf-8"
    ) == "# demo, revised\n"


def test_an_added_file_propagates(publish, marketplace, downstream, capsys):
    """adds a file that appeared upstream"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    write(marketplace / "plugins" / PLUGIN / "docs/note.md", "a note\n")
    commit_all(marketplace, "add a note")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "add     docs/note.md" in out
    assert (downstream / "plugins" / PLUGIN / "docs/note.md").is_file()


def test_a_deleted_file_is_removed_downstream(publish, marketplace, downstream, capsys):
    """deletes downstream what was deleted upstream

    The arm most easily missed: a mirror that only ever copies leaves a file
    behind forever, and downstream nobody knows it is gone.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert (downstream / "plugins" / PLUGIN / "README.md").is_file()

    git(marketplace, "rm", "-q", "plugins/demo/README.md")
    commit_all(marketplace, "drop the readme")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "remove  README.md" in out
    assert not (downstream / "plugins" / PLUGIN / "README.md").exists()


def test_an_emptied_directory_is_pruned(publish, marketplace, downstream, capsys):
    """removes a directory the delete sweep emptied

    git cannot track an empty directory, so one left behind is invisible to
    `git status` downstream and would make --check and git disagree forever.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    git(marketplace, "rm", "-q", "plugins/demo/skills/thing/SKILL.md")
    git(marketplace, "rm", "-q", "plugins/demo/skills/thing/FLOW.md")
    commit_all(marketplace, "drop the skill")

    invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert not (downstream / "plugins" / PLUGIN / "skills").exists()


def test_untracked_and_ignored_files_are_never_published(publish, marketplace, downstream, capsys):
    """publishes what is committed, so nothing generated can reach the copy

    Both categories, which are not the same: an untracked file is reported as
    not published, while an ignored one is invisible even to that report. The
    .gitignore is what makes the second case real -- without it every file here
    is merely untracked and the ignored arm is never reached.
    """
    source = marketplace / "plugins" / PLUGIN
    write(marketplace / ".gitignore", "__pycache__/\n.DS_Store\n")
    commit_all(marketplace, "ignore generated files")
    write(source / "__pycache__/run.cpython-39.pyc", "bytecode\n")
    write(source / ".DS_Store", "finder\n")
    write(source / "scratch.txt", "notes to self\n")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK

    copied = tree(downstream / "plugins" / PLUGIN)
    assert not [name for name in copied if "__pycache__" in name]
    assert ".DS_Store" not in copied
    assert "scratch.txt" not in copied
    assert "not published" in out and "scratch.txt" in out


def test_nothing_outside_the_plugin_directory_is_touched(publish, downstream, capsys):
    """writes only <dest>/plugins/<name>/, never a neighbour"""
    before = {
        name: value
        for name, value in tree(downstream).items()
        if not name.startswith(os.path.join("plugins", PLUGIN))
    }
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    after = {
        name: value
        for name, value in tree(downstream).items()
        if not name.startswith(os.path.join("plugins", PLUGIN))
    }
    assert after == before


def test_it_never_commits_downstream(publish, downstream, capsys):
    """leaves the copy unstaged, for a person to review and commit"""
    head = git(downstream, "rev-parse", "HEAD")
    invoke(publish, PLUGIN, downstream, capsys=capsys)

    assert git(downstream, "rev-parse", "HEAD") == head
    assert git(downstream, "diff", "--cached", "--name-only") == ""
    assert "plugins/demo/" in git(downstream, "status", "--porcelain")


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://github.com/example/upstream.git", "example/upstream"),
        ("git@github.com:example/upstream.git", "example/upstream"),
        ("https://github.com/example/upstream", "example/upstream"),
        ("ssh://git@git.example.com:2222/team/tools.git", "team/tools"),
        ("https://github.com/example/upstream.git/", "example/upstream"),
    ],
)
def test_the_origin_url_is_parsed_into_a_slug(publish, downstream, marketplace, url, expected):
    """reads owner/repo out of the SSH and HTTPS forms, on any host"""
    git(marketplace, "remote", "set-url", "origin", url)
    assert publish.parse_origin(url) == expected


# --------------------------------------------------------------------------
# it refuses when it should
#
# Every example here asserts the exit status AND that the destination is
# byte-for-byte what it was. A refusal that had already written something would
# be the worst of both.
# --------------------------------------------------------------------------


def refuses(publish, downstream, capsys, *argv):
    before = untouched(downstream)
    status, _, err = invoke(publish, *argv, capsys=capsys)
    assert status == publish.EXIT_REFUSED
    assert err.startswith("refused:")
    assert untouched(downstream) == before
    return err


def test_refuses_an_unknown_plugin(publish, downstream, capsys):
    """refuses a plugin name that is not there"""
    err = refuses(publish, downstream, capsys, "nosuch", downstream)
    assert "no plugin named" in err


def test_refuses_a_directory_that_is_not_a_plugin(publish, marketplace, downstream, capsys):
    """refuses a directory under plugins/ with no manifest"""
    write(marketplace / "plugins" / "bare" / "README.md", "not a plugin\n")
    commit_all(marketplace, "add a bare directory")
    err = refuses(publish, downstream, capsys, "bare", downstream)
    assert "plugin.json" in err


def test_refuses_a_modified_source(publish, marketplace, downstream, capsys):
    """refuses when the source plugin has uncommitted changes

    A publish copies what is committed, so a dirty source means the operator is
    about to ship something different from what they think they reviewed.
    """
    write(marketplace / "plugins" / PLUGIN / "README.md", "# uncommitted\n")
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "uncommitted changes" in err


def test_refuses_a_staged_source(publish, marketplace, downstream, capsys):
    """refuses when the source plugin has staged but uncommitted changes"""
    write(marketplace / "plugins" / PLUGIN / "README.md", "# staged\n")
    git(marketplace, "add", "plugins/demo/README.md")
    refuses(publish, downstream, capsys, PLUGIN, downstream)


def test_refuses_a_symlink_in_the_source(publish, marketplace, downstream, capsys):
    """refuses to publish a symlink rather than guessing what it means

    Following one would inline foreign content into a repo another team reads;
    preserving one could point outside the destination.
    """
    link = marketplace / "plugins" / PLUGIN / "elsewhere.md"
    link.symlink_to("../../README.md")
    commit_all(marketplace, "add a symlink")
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "symlink" in err


def test_refuses_a_destination_that_does_not_exist(publish, downstream, capsys, sandbox):
    """refuses a destination path that is not there"""
    err = refuses(publish, downstream, capsys, PLUGIN, sandbox / "absent")
    assert "does not exist" in err


def test_refuses_a_destination_that_is_a_file(publish, downstream, capsys, sandbox):
    """refuses a destination that is not a directory"""
    target = sandbox / "a-file"
    write(target, "not a repo\n")
    err = refuses(publish, downstream, capsys, PLUGIN, target)
    assert "not a directory" in err


def test_refuses_a_destination_that_is_not_a_git_repo(publish, downstream, capsys, sandbox):
    """refuses a destination git cannot revert, since the copy must be reviewable"""
    plain = sandbox / "plain"
    plain.mkdir()
    err = refuses(publish, downstream, capsys, PLUGIN, plain)
    assert "not a git repository" in err


def test_refuses_a_symlinked_destination(publish, downstream, capsys, sandbox):
    """refuses a symlinked destination, whose writes would land somewhere else

    is_dir() follows a symlink, so without this check every other guard passes
    and the mirror writes outside the repository it was pointed at.
    """
    link = sandbox / "linked-downstream"
    link.symlink_to(str(downstream))
    err = refuses(publish, downstream, capsys, PLUGIN, link)
    assert "symlink" in err


def test_refuses_a_worktree_of_the_source(publish, marketplace, downstream, capsys, sandbox):
    """refuses a destination sharing an object store with the source

    Not hypothetical: this repo keeps worktrees of itself under
    .claude/worktrees/, each with its own plugins/, and every other guard on the
    list passes for them. Publishing into one would overwrite the plugin with
    itself.
    """
    worktree = sandbox / "a-worktree"
    git(marketplace, "worktree", "add", "-q", str(worktree), "-b", "side")
    err = refuses(publish, downstream, capsys, PLUGIN, worktree)
    assert "shares a git object store" in err


def test_refuses_the_source_checkout_itself(publish, marketplace, downstream, capsys):
    """refuses the source repository as its own destination"""
    err = refuses(publish, downstream, capsys, PLUGIN, marketplace)
    assert "shares a git object store" in err


def test_refuses_a_dirty_destination(publish, downstream, capsys):
    """refuses when the copy downstream has uncommitted tracked changes"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    commit_all(downstream, "take the copy")
    write(downstream / "plugins" / PLUGIN / "README.md", "# edited downstream\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "uncommitted changes in the destination" in err


def test_refuses_to_destroy_untracked_work_in_a_copy_it_does_not_own(publish, downstream, capsys):
    """refuses to delete untracked files from a directory it has never stamped

    The dangerous case, and the one worth being strict about: a first publish
    into a `plugins/<name>/` somebody else created and populated. Without the
    tool's own UPSTREAM.json there is nothing saying this directory is a mirror,
    so an untracked file in it is someone's work and git cannot bring it back.
    """
    squatter = downstream / "plugins" / PLUGIN
    write(squatter / "notes.md", "work in progress\n")
    write(squatter / "draft/plan.md", "a plan\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "overwrite or delete" in err
    assert "notes.md" in err
    assert (squatter / "notes.md").is_file()


def test_a_stamp_naming_another_plugin_is_not_a_licence_to_delete(publish, downstream, capsys):
    """refuses when the provenance found belongs to a different mirror"""
    squatter = downstream / "plugins" / PLUGIN
    write(squatter / "notes.md", "work in progress\n")
    write(
        squatter / publish.PROVENANCE,
        json.dumps({"plugin": "other", "source": "someone/else"}) + "\n",
    )

    refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert (squatter / "notes.md").is_file()


def test_it_republishes_over_its_own_uncommitted_output(publish, downstream, capsys):
    """re-runs against a copy it wrote but nobody has committed yet

    After any publish and before the reviewer commits, every file downstream is
    untracked. A blanket refusal would deadlock the second run and every run
    after it, and would also refuse to propagate an upstream deletion.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert git(downstream, "status", "--porcelain")

    status, _, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK


def test_a_stray_in_a_managed_copy_is_removed_and_reported(publish, downstream, capsys):
    """sweeps a local file out of a copy it owns, and says that it did

    The copy is a read-only mirror and the destination's own rule says so, so
    enforcing that is the point rather than a side effect. It is never silent:
    --check names the file first, and the publish reports the removal.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    commit_all(downstream, "take the copy")
    stray = downstream / "plugins" / PLUGIN / "local-note.md"
    write(stray, "someone edited the read-only copy\n")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "remove  local-note.md" in out
    assert not stray.exists()


def test_refuses_to_write_through_a_symlinked_subdirectory(publish, downstream, capsys, sandbox):
    """refuses when a directory inside the copy points somewhere else

    The confinement promise is "nothing outside <dest>/plugins/<name>/", and the
    top-level symlink guards do not reach this: `plugins/demo/scripts` pointing
    elsewhere passes all of them, and then the copy writes straight through it.
    os.walk does not follow symlinked directories, so the sweep cannot find it
    either.
    """
    escape = sandbox / "somewhere-else"
    escape.mkdir()
    write(escape / "victim.txt", "not ours to overwrite\n")

    copy = downstream / "plugins" / PLUGIN
    copy.mkdir(parents=True)
    (copy / "scripts").symlink_to(str(escape))

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "outside" in err
    assert (escape / "victim.txt").read_text(encoding="utf-8") == "not ours to overwrite\n"
    assert not (escape / "run.py").exists()


def test_refuses_when_the_origin_cannot_be_parsed(publish, marketplace, downstream, capsys):
    """refuses rather than writing provenance it cannot vouch for

    A wrong `source` in the copy is worse than a missing one, because it reads
    like an answer.
    """
    git(marketplace, "remote", "set-url", "origin", "not-a-url")
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "origin URL" in err


def test_refuses_when_there_is_no_origin(publish, marketplace, downstream, capsys):
    """refuses when the source has no origin to derive provenance from"""
    git(marketplace, "remote", "remove", "origin")
    refuses(publish, downstream, capsys, PLUGIN, downstream)


# --------------------------------------------------------------------------
# --check
# --------------------------------------------------------------------------


def test_check_reports_in_sync_and_writes_nothing(publish, downstream, capsys):
    """exits 0 on a current copy, touching nothing"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    before = untouched(downstream)

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_OK
    assert "in sync" in out
    assert untouched(downstream) == before


@pytest.mark.parametrize("kind", ["changed", "added", "removed"])
def test_check_reports_content_drift_and_writes_nothing(
    publish, marketplace, downstream, capsys, kind
):
    """exits 1 on a copy that is behind, naming what moved, touching nothing"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    if kind == "changed":
        write(marketplace / "plugins" / PLUGIN / "README.md", "# moved on\n")
    elif kind == "added":
        write(marketplace / "plugins" / PLUGIN / "docs/new.md", "new\n")
    else:
        git(marketplace, "rm", "-q", "plugins/demo/README.md")
    commit_all(marketplace, "upstream moves")
    before = untouched(downstream)

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert "drift against" in out
    assert untouched(downstream) == before


def test_check_catches_a_mode_only_difference(publish, downstream, capsys):
    """exits 1 when only the executable bit differs

    A bytes-only comparison would call this in sync while git reported a
    permanent `old mode 100755 / new mode 100644` diff downstream that
    re-running the tool could never clear.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    copied = downstream / "plugins" / PLUGIN / EXECUTABLE
    copied.chmod(copied.stat().st_mode & ~0o111)

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert EXECUTABLE in out


def test_a_mode_only_difference_is_repaired_by_a_publish(publish, downstream, capsys):
    """restores the executable bit rather than only reporting it"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    copied = downstream / "plugins" / PLUGIN / EXECUTABLE
    copied.chmod(copied.stat().st_mode & ~0o111)

    invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert copied.stat().st_mode & stat.S_IXUSR


def test_check_reports_a_stray_file_rather_than_refusing(publish, downstream, capsys):
    """names an untracked stray as drift, because --check destroys nothing"""
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    commit_all(downstream, "take the copy")
    write(downstream / "plugins" / PLUGIN / "stray.txt", "scratch\n")

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert "remove  stray.txt" in out


@pytest.mark.parametrize("state", ["absent", "malformed", "not-an-object"])
def test_check_treats_broken_provenance_as_drift(publish, downstream, capsys, state):
    """exits 1 when UPSTREAM.json is missing or unreadable

    Provenance is the one thing the destination cannot derive, so a copy without
    it is not in the state this tool produces, however well the tree matches.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    record = downstream / "plugins" / PLUGIN / publish.PROVENANCE
    if state == "absent":
        record.unlink()
    elif state == "malformed":
        record.write_text("{not json", encoding="utf-8")
    else:
        record.write_text('"a string"', encoding="utf-8")

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert publish.PROVENANCE in out


def test_check_catches_provenance_disagreeing_with_the_copied_manifest(publish, downstream, capsys):
    """exits 1 when the recorded version is not the copied one

    The signature of a hand-edit or an apply that died partway.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    record = downstream / "plugins" / PLUGIN / publish.PROVENANCE
    loaded = json.loads(record.read_text(encoding="utf-8"))
    loaded["version"] = "9.9.9"
    record.write_text(json.dumps(loaded, indent=2) + "\n", encoding="utf-8")

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert "9.9.9" in out


def test_a_stale_commit_alone_is_not_drift(publish, marketplace, downstream, capsys):
    """exits 0 on content that matches, and prints both commits

    A revert-and-recommit upstream moves the SHA without changing a byte. Making
    it decide the exit status would report drift that does not exist -- but the
    recorded value is printed on every run, so it is never invisible either.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    record = downstream / "plugins" / PLUGIN / publish.PROVENANCE
    loaded = json.loads(record.read_text(encoding="utf-8"))
    loaded["commit"] = "0" * 40
    record.write_text(json.dumps(loaded, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_OK
    assert "0" * 40 in out
    assert git(marketplace, "log", "-1", "--format=%H", "--", "plugins/demo") in out


def test_check_refuses_on_a_bad_destination_too(publish, downstream, capsys, sandbox):
    """refuses under --check for the same reasons it refuses under apply"""
    refuses(publish, downstream, capsys, PLUGIN, sandbox / "absent", "--check")


# --------------------------------------------------------------------------
# the process contract
#
# Driven as a real subprocess: these are the guarantees that only exist at the
# process boundary, and they are what would catch the inlined stream helpers
# drifting from plugins/gh/scripts/lib/streams.py.
# --------------------------------------------------------------------------


@pytest.fixture
def script_copy(marketplace):
    """The script placed in the fixture marketplace, so its ROOT is that repo."""
    destination = marketplace / "scripts" / "publish-plugin.py"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(SCRIPT), str(destination))
    return destination


@pytest.mark.parametrize(
    ("env", "why"),
    [
        ({"PYTHONIOENCODING": "ascii"}, "a single-byte stdout"),
        ({"LC_ALL": "en_US.ISO8859-1"}, "a single-byte locale"),
    ],
)
def test_it_survives_a_single_byte_locale(script_copy, downstream, run_script, sandbox, env, why):
    """runs clean under a locale that cannot encode its own output"""
    result = run_script(script_copy, PLUGIN, str(downstream), env=env)
    assert result.status == 0, why
    assert "Traceback" not in result.stderr


def test_it_finishes_the_mirror_before_it_reports(script_copy, downstream, run_with_closed_reader):
    """completes every side effect when the reader has already gone away

    The rule in .claude/rules/type-py.md: a script that changes state finishes
    its work before it worries about output.
    """
    status, stderr = run_with_closed_reader(script_copy, PLUGIN, str(downstream))
    assert status == 0
    assert "Traceback" not in stderr
    copied = tree(downstream / "plugins" / PLUGIN)
    assert sorted(copied) == sorted(list(FILES) + [EXECUTABLE, "UPSTREAM.json"])


def test_it_finishes_the_mirror_with_an_unbuffered_closed_reader(
    script_copy, downstream, run_with_closed_reader
):
    """same, with every line its own flush, so the break lands mid-run"""
    status, stderr = run_with_closed_reader(script_copy, PLUGIN, str(downstream), unbuffered=True)
    assert status == 0
    assert "Traceback" not in stderr
    assert (downstream / "plugins" / PLUGIN / "UPSTREAM.json").is_file()


def test_it_reports_nothing_when_stdout_is_closed_outright(script_copy, downstream, sandbox):
    """binds devnull when fd 1 is gone, so the work still happens

    Started with stdout closed, Python sets sys.stdout to None and every write
    is an AttributeError. The first write here is the report header, before the
    mirror is made, so without this the publish would not happen at all and the
    caller would see a traceback instead of a status.
    """
    done = subprocess.run(
        [
            "sh",
            "-c",
            'exec 1>&- ; "$0" "$1" "$2" "$3"',
            sys.executable,
            str(script_copy),
            PLUGIN,
            str(downstream),
        ],
        capture_output=True,
        check=False,
    )
    assert done.returncode == 0
    assert b"Traceback" not in done.stderr
    assert (downstream / "plugins" / PLUGIN / "UPSTREAM.json").is_file()


@pytest.mark.parametrize(
    ("argv", "why"),
    [
        ([], "no arguments at all"),
        ([PLUGIN], "a plugin with no destination"),
        ([PLUGIN, "somewhere", "--nope"], "an unknown flag"),
    ],
)
def test_it_rejects_a_bad_command_line(script_copy, run_script, argv, why):
    """exits 2 on a usage error, as argparse does"""
    result = run_script(script_copy, *argv)
    assert result.status == 2, why


def test_the_exit_codes_are_what_the_callers_read(script_copy, downstream, run_script):
    """applies with 0, reports drift with 1, refuses with 2"""
    assert run_script(script_copy, PLUGIN, str(downstream)).status == 0
    assert run_script(script_copy, PLUGIN, str(downstream), "--check").status == 0

    (downstream / "plugins" / PLUGIN / "README.md").write_text("# moved\n", encoding="utf-8")
    assert run_script(script_copy, PLUGIN, str(downstream), "--check").status == 1

    assert run_script(script_copy, "nosuch", str(downstream)).status == 2


def test_it_refuses_without_git_on_path(script_copy, downstream, run_script, sandbox):
    """refuses rather than crashing when git is not installed"""
    result = run_script(
        script_copy,
        PLUGIN,
        str(downstream),
        env={"PATH": sandbox.path_without("git")},
    )
    assert result.status == 2
    assert "git is not on PATH" in result.stderr


def test_an_unexpected_failure_is_not_mistaken_for_drift(script_copy, downstream, run_script):
    """exits 3, not 1, when something unforeseen goes wrong

    Python exits 1 on an uncaught traceback, and 1 already means "there is work
    to do". Without a top-level handler a caller would loop on a crash.
    """
    broken = script_copy.parent / "broken-publish.py"
    body = script_copy.read_text(encoding="utf-8").replace(
        "        status = run(args)",
        "        raise RuntimeError('provoked')\n        status = run(args)",
    )
    assert "provoked" in body, "the injection point moved; this example proves nothing"
    broken.write_text(body, encoding="utf-8")
    broken.chmod(broken.stat().st_mode | 0o111)

    result = run_script(broken, PLUGIN, str(downstream))
    assert result.status == 3
    assert "unexpected failure" in result.stderr


# --------------------------------------------------------------------------
# arms that are awkward to reach from the outside
#
# Unit tests, per .claude/rules/type-py.md: "decision logic that is awkward to
# provoke from the outside gets direct unit tests beside that". Several of these
# are refusal arms that a black-box run can only reach with an elaborate fixture,
# and one group is the stream handling inlined from
# plugins/gh/scripts/lib/streams.py, whose whole risk is drifting from the
# canonical copy unnoticed.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "not-a-url",
        "https://github.com/",
        # One path segment: the host is not an owner, however much it looks like
        # one to a pattern anchored at the end of the string.
        "https://github.com/only-one-part",
        "git@github.com:",
    ],
)
def test_an_unusable_origin_url_yields_no_slug(publish, url):
    """reads no owner/repo out of a URL it does not understand

    Returning None rather than guessing is the point: a wrong `source` in the
    copy's provenance reads like an answer, which is worse than a refusal.
    """
    assert publish.parse_origin(url) is None


def test_binding_closed_streams_replaces_a_missing_stdout(publish, monkeypatch):
    """gives the script somewhere to write when a descriptor is gone outright

    Started with fd 1 closed, Python sets sys.stdout to None and every later
    write is an AttributeError. In this script the first one would land on the
    report header, before the mirror is made.
    """
    monkeypatch.setattr(publish.sys, "stdout", None)
    monkeypatch.setattr(publish.sys, "stderr", None)
    publish.bind_closed_streams()
    assert publish.sys.stdout is not None
    publish.sys.stdout.write("swallowed")


def test_use_utf8_leaves_a_stream_it_cannot_reconfigure(publish):
    """does not raise on a stream with no reconfigure, or a detached one

    The fallback is the original, loud UnicodeEncodeError, never a silent one.
    """

    class NoReconfigure:
        pass

    class Detached:
        def reconfigure(self, **kwargs):
            raise ValueError("underlying buffer has been detached")

    publish.use_utf8(NoReconfigure())
    publish.use_utf8(Detached())


def test_write_goes_quiet_once_the_reader_has_gone(publish, monkeypatch):
    """stops writing, and does not raise, after a broken pipe"""
    silenced = []

    class Gone:
        def write(self, text):
            raise BrokenPipeError(32, "Broken pipe")

    monkeypatch.setattr(publish.sys, "stdout", Gone())
    monkeypatch.setattr(publish, "silence_output", lambda **kwargs: silenced.append(kwargs))
    publish.write("anything\n")
    assert silenced == [{"include_stderr": False}]


def test_it_refuses_in_process_without_git(publish, downstream, capsys, monkeypatch, sandbox):
    """refuses with git's absence named, rather than raising FileNotFoundError"""
    monkeypatch.setenv("PATH", sandbox.path_without("git"))
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "git is not on PATH" in err


def test_refuses_a_plugin_with_nothing_committed(publish, marketplace, downstream, capsys):
    """refuses a plugin directory git tracks no files under

    A manifest on disk is not enough: the mirror publishes the index, so a
    wholly untracked plugin would publish as an empty directory.
    """
    write(
        marketplace / "plugins" / "ghost" / ".claude-plugin" / "plugin.json",
        json.dumps({"name": "ghost", "version": "0.0.1"}) + "\n",
    )
    err = refuses(publish, downstream, capsys, "ghost", downstream)
    assert "tracks no files" in err


def add_gitlink(repo, path):
    """Record `path` in the index as a submodule, without needing a real one.

    git refuses a null sha for a gitlink, so it is given a real commit: the
    fixture repo's own HEAD, not this checkout's. Nothing reads through the
    pointer; what matters is that the index reports mode 160000 for that path,
    which is asserted below rather than assumed.
    """
    sha = git(repo, "rev-parse", "HEAD")
    # The working tree needs a git directory at that path too, or git reports the
    # gitlink as deleted and the dirty-source guard is what refuses instead.
    nested = repo / path
    nested.mkdir(parents=True, exist_ok=True)
    git(nested, "init", "-q", "-b", "main")
    git(repo, "update-index", "--add", "--cacheinfo", f"160000,{sha},{path}")
    assert index_modes(repo, path) == "160000", "the fixture did not produce a gitlink"


def test_refuses_a_submodule_in_the_source(publish, marketplace, downstream, capsys):
    """refuses to publish a submodule, which is a pointer rather than content

    Committed, not merely staged: the uncommitted-source refusal is checked
    first and would otherwise be what this example proved.
    """
    add_gitlink(marketplace, "plugins/demo/vendored")
    git(marketplace, "commit", "-q", "-m", "vendor something")
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "submodule" in err


def test_refuses_a_submodule_in_the_destination(publish, downstream, capsys):
    """refuses a destination copy that is itself a submodule

    Deleting into a gitlink breaks the submodule and leaves .gitmodules stale.
    """
    add_gitlink(downstream, "plugins/demo")
    (downstream / "plugins" / PLUGIN).mkdir(parents=True, exist_ok=True)
    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "submodule" in err


def test_refuses_a_symlinked_plugin_directory(publish, downstream, capsys, sandbox):
    """refuses when the copy's own directory points somewhere else"""
    elsewhere = sandbox / "elsewhere"
    elsewhere.mkdir()
    (downstream / "plugins").mkdir(parents=True, exist_ok=True)
    (downstream / "plugins" / PLUGIN).symlink_to(str(elsewhere))

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "symlink" in err


def test_refuses_when_the_destination_path_is_a_file(publish, downstream, capsys):
    """refuses when something that is not a directory is already in the way"""
    (downstream / "plugins").mkdir(parents=True, exist_ok=True)
    write(downstream / "plugins" / PLUGIN, "a file, not a plugin\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "not a directory" in err


def test_a_write_that_fails_partway_says_how_to_recover(publish, downstream, capsys, monkeypatch):
    """reports the git commands that undo a half-written copy

    Copy-then-delete means a crash leaves a superset rather than a hole, and the
    destination is required to be a git repo precisely so this is recoverable.
    """

    def explode(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(publish.shutil, "copy2", explode)
    status, _, err = invoke(publish, PLUGIN, downstream, capsys=capsys)

    # Exit 3, not 2: exit 2 promises the destination is untouched, and by here
    # it is not. On stderr, because write() has gone quiet if the reader left
    # and this is the one message that must arrive.
    assert status == publish.EXIT_CRASH
    assert "failed partway" in err
    assert "git -C" in err and "clean -fd" in err


def test_an_unreadable_manifest_in_the_copy_is_drift(publish, downstream, capsys):
    """exits 1 when the copied manifest cannot be parsed

    The version comparison is how a half-finished apply is caught, so a manifest
    that cannot be read is itself the signal rather than a reason to skip it.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    write(downstream / "plugins" / PLUGIN / ".claude-plugin" / "plugin.json", "{not json")

    status, out, _ = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    assert status == publish.EXIT_DRIFT
    assert "cannot be read" in out


def test_refuses_when_a_symlinked_parent_aims_back_at_the_source(
    publish, marketplace, downstream, capsys
):
    """refuses a destination whose plugins/ points at the source's own

    The subtlest way to end up overwriting the plugin with itself, and it slips
    past every guard above: the destination is a genuinely different repository
    with a different object store, neither it nor `plugins/demo` is a symlink,
    and yet `<dest>/plugins/demo` and `<source>/plugins/demo` are one directory,
    because `<dest>/plugins` is the symlink.
    """
    plugins = downstream / "plugins"
    shutil.rmtree(str(plugins))
    plugins.symlink_to(str(marketplace / "plugins"))

    before = untouched(marketplace)
    status, _, err = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_REFUSED
    assert "same directory" in err
    assert untouched(marketplace) == before


# --------------------------------------------------------------------------
# arms a mutation survey found unpinned
#
# Each of these corresponds to a mutation that left the suite green, or to a bug
# a review reproduced. The pattern to watch for is a guard whose promise is
# stated in prose and checked against only one of the states that can break it.
# --------------------------------------------------------------------------


def test_refuses_to_overwrite_untracked_work_at_a_colliding_path(publish, downstream, capsys):
    """refuses to write over an untracked file, not only to delete one

    Overwriting destroys an untracked file exactly as completely as unlinking
    it, and git can restore neither. A guard that looked only at what the sweep
    would REMOVE let the first publish into somebody's directory clobber every
    path that happened to collide with an upstream name, reporting it as an
    ordinary `update`.
    """
    squatter = downstream / "plugins" / PLUGIN
    write(squatter / "README.md", "HANDWRITTEN, NOT OURS\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "overwrite or delete" in err
    assert (squatter / "README.md").read_text(encoding="utf-8") == "HANDWRITTEN, NOT OURS\n"


def test_an_ignored_destination_directory_does_not_disable_the_guard(publish, downstream, capsys):
    """still refuses when the destination's .gitignore covers the copy

    `git ls-files --others` with --exclude-standard reports nothing for an
    ignored path, so asking that way made a destination whose .gitignore covered
    plugins/<name>/ look as though it held no untracked files at all, and the
    sweep deleted a stranger's work with exit 0. "Can git give this file back"
    is the real question, and for an ignored file the answer is no.
    """
    write(downstream / ".gitignore", "plugins/demo/\n")
    commit_all(downstream, "ignore the copy")
    write(downstream / "plugins" / PLUGIN / "notes.md", "work in progress\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "notes.md" in err
    assert (downstream / "plugins" / PLUGIN / "notes.md").is_file()


def test_a_case_only_rename_upstream_does_not_delete_the_file(
    publish, marketplace, downstream, capsys
):
    """publishes a case-only rename without dropping the file

    On a case-insensitive filesystem -- APFS by default, so every Mac this runs
    on -- the old on-disk name still matches the new content, so the copy is not
    an `add`; compared case-sensitively the on-disk name is then absent from the
    keep set and the sweep deletes the file that was just published.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    git(marketplace, "mv", "plugins/demo/README.md", "plugins/demo/Readme.md")
    commit_all(marketplace, "rename by case")

    status, _, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    copied = tree(downstream / "plugins" / PLUGIN)
    assert [name for name in copied if name.lower() == "readme.md"]


def test_an_apply_repairs_provenance_that_check_calls_drift(publish, downstream, capsys):
    """rewrites a corrupted UPSTREAM.json even though the tree matches

    --check and the apply path have to agree about what "in sync" means. If the
    apply short-circuits on the file tree alone, --check keeps reporting drift
    that a publish will not fix, and the skill reading those two exit codes
    loops forever.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    (downstream / "plugins" / PLUGIN / publish.PROVENANCE).write_text("{broken", encoding="utf-8")

    assert invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)[0] == publish.EXIT_DRIFT
    assert invoke(publish, PLUGIN, downstream, capsys=capsys)[0] == publish.EXIT_OK
    assert invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)[0] == publish.EXIT_OK


@pytest.mark.parametrize(
    ("field", "value"),
    [("plugin", "somebody-elses"), ("source", "another/repo")],
)
def test_each_half_of_the_stamp_is_checked_on_its_own(publish, downstream, capsys, field, value):
    """treats a stamp wrong in either field as not ours

    The docstring claims both halves matter. Tested together, either one alone
    would still refuse and the claim would be unasserted.
    """
    squatter = downstream / "plugins" / PLUGIN
    write(squatter / "notes.md", "work in progress\n")
    record = {"plugin": PLUGIN, "source": "example/upstream"}
    record[field] = value
    write(squatter / publish.PROVENANCE, json.dumps(record) + "\n")

    refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert (squatter / "notes.md").is_file()


def test_confinement_does_not_accept_a_sibling_that_shares_a_prefix(publish, sandbox):
    """keeps `demo-vendor` from passing as though it were inside `demo`

    A prefix test without the separator would let any sibling whose name starts
    with the target's pass, which is how a path outside the copy gets written.
    """
    target = sandbox / "plugins" / PLUGIN
    target.mkdir(parents=True)
    sibling = sandbox / "plugins" / (PLUGIN + "-vendor")
    sibling.mkdir()

    publish.confine(target, target / "inside.md")
    with pytest.raises(publish.Refused):
        publish.confine(target, sibling / "outside.md")


def test_confinement_reaches_a_stale_symlinked_directory(publish, downstream, capsys, sandbox):
    """refuses a symlinked directory left over from an older version of the copy

    The per-entry pass only covers paths the source still has. A directory the
    plugin used to ship, now replaced downstream by a symlink, is reachable only
    by walking what is actually there.
    """
    escape = sandbox / "escape"
    escape.mkdir()
    copy = downstream / "plugins" / PLUGIN
    copy.mkdir(parents=True)
    (copy / "old-skills").symlink_to(str(escape))

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "outside" in err


def test_refuses_a_directory_where_the_source_has_a_file(publish, downstream, capsys):
    """refuses rather than copying a file into a directory of the same name

    shutil.copy2 onto a directory writes *inside* it, and the mode fix-up then
    strips the execute bit off the directory, leaving a tree neither git nor rm
    can traverse -- damage this tool caused and cannot undo.
    """
    blocking = downstream / "plugins" / PLUGIN / "README.md"
    write(blocking / "inside.md", "git cannot commit an empty directory\n")
    commit_all(downstream, "a directory in the way")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "not a regular file" in err
    assert blocking.is_dir()


def test_refuses_a_symlinked_file_inside_the_copy(publish, downstream, capsys):
    """refuses a symlink where a regular file belongs

    Copying through it corrupts whatever it points at and leaves the link in
    place, so the copy never converges and reports the same add forever.
    """
    copy = downstream / "plugins" / PLUGIN
    copy.mkdir(parents=True)
    write(copy / "LICENSE", "a real file\n")
    (copy / "README.md").symlink_to("LICENSE")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "not a regular file" in err
    assert (copy / "LICENSE").read_text(encoding="utf-8") == "a real file\n"


def test_a_non_ascii_filename_publishes_rather_than_crashing(
    publish, marketplace, downstream, capsys
):
    """handles a tracked filename git would quote

    With core.quotePath on by default, `git ls-files` returns
    `"plugins/demo/caf\\303\\251.md"`, quotes included, which a line-based reader
    cannot turn back into a path. Reading the listing NUL-separated is what makes
    the name ordinary.
    """
    write(marketplace / "plugins" / PLUGIN / "café.md", "accented\n")
    commit_all(marketplace, "add an accented filename")

    status, _, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert (downstream / "plugins" / PLUGIN / "café.md").read_text(encoding="utf-8") == "accented\n"


def test_a_newline_in_a_filename_does_not_defeat_the_deletion_guard(publish, downstream, capsys):
    """counts a file whose name contains a newline as one path, not two

    Split on newlines, the leading fragment can still look like a legitimate
    relative path, so the guard compares real files against a name that matches
    nothing and lets the sweep delete something it was asked to protect.
    """
    copy = downstream / "plugins" / PLUGIN
    copy.mkdir(parents=True)
    write(copy / "two\nlines.md", "not ours\n")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "lines.md" in err
    assert (copy / "two\nlines.md").is_file()


def test_an_unreadable_destination_directory_is_not_reported_as_in_sync(
    publish, downstream, capsys
):
    """refuses when part of the copy cannot be listed

    os.walk discards scandir errors by default, so an unreadable directory
    yields nothing and is indistinguishable from an empty one. Every walk here
    answers a question where those two have opposite consequences.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    locked = downstream / "plugins" / PLUGIN / "skills"
    original = locked.stat().st_mode
    locked.chmod(0o300)
    try:
        status, _, err = invoke(publish, PLUGIN, downstream, "--check", capsys=capsys)
    finally:
        locked.chmod(original)
    assert status == publish.EXIT_REFUSED
    assert "could not read" in err


def test_the_published_date_survives_a_no_op_republish(publish, downstream, capsys):
    """keeps the recorded date when nothing else changed

    Run twice in the same second, a regenerated date is identical to a carried
    one and the test proves nothing. Backdating the recorded date is what makes
    the difference visible, and the difference is the whole basis for telling a
    downstream reviewer that any diff at all is real content.
    """
    invoke(publish, PLUGIN, downstream, capsys=capsys)
    record = downstream / "plugins" / PLUGIN / publish.PROVENANCE
    loaded = json.loads(record.read_text(encoding="utf-8"))
    loaded["published"] = "2020-01-01"
    record.write_text(json.dumps(loaded, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    status, out, _ = invoke(publish, PLUGIN, downstream, capsys=capsys)
    assert status == publish.EXIT_OK
    assert "already in sync" in out
    assert json.loads(record.read_text(encoding="utf-8"))["published"] == "2020-01-01"


def test_refuses_a_manifest_with_no_version(publish, marketplace, downstream, capsys):
    """refuses rather than recording a null version in the copy

    Downstream the version is how one copy is told from another, and it is what
    the drift check compares, so a null would sit there forever comparing equal
    to itself.
    """
    manifest = marketplace / "plugins" / PLUGIN / ".claude-plugin" / "plugin.json"
    write(manifest, json.dumps({"name": PLUGIN, "description": "no version"}) + "\n")
    commit_all(marketplace, "drop the version")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "no version" in err


def test_refuses_an_unreadable_source_manifest(publish, marketplace, downstream, capsys):
    """names the file rather than exiting 3 on a malformed manifest"""
    write(marketplace / "plugins" / PLUGIN / ".claude-plugin" / "plugin.json", "{not json")
    commit_all(marketplace, "break the manifest")

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "plugin.json" in err


def test_a_git_failure_is_not_reported_as_not_a_repository(publish, downstream, capsys, sandbox):
    """carries git's own words when git refuses to look

    The realistic case is `detected dubious ownership`, which happens whenever
    the destination is owned by another user. Reported as "not a git
    repository", it sends someone off to re-clone a repository that is fine.
    """
    hostile = sandbox / "hostile"
    hostile.mkdir()
    write(hostile / "git", "#!/bin/sh\necho 'fatal: detected dubious ownership' >&2\nexit 128\n")
    (hostile / "git").chmod(0o755)
    sandbox.stub_path(hostile)

    err = refuses(publish, downstream, capsys, PLUGIN, downstream)
    assert "dubious ownership" in err


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/owner/repo/tree/main",
        "~/Code/@org/@team/repo",
        "../mirrors/org-claude",
        "/absolute/path/repo",
    ],
)
def test_a_plausible_looking_wrong_slug_is_refused(publish, url):
    """returns nothing for shapes that would parse into a wrong-but-credible slug

    These are worse than an obvious failure: a browser URL yields `tree/main`
    and a local path yields the last two directories, either of which reads like
    a real answer in the copy's provenance.
    """
    assert publish.parse_origin(url) is None
