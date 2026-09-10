#!/usr/bin/env python3
"""publish-plugin.py -- mirror one plugin into a downstream repo as a read-only copy.

Usage:
  publish-plugin.py <plugin-name> <dest-repo-path> [--check]

This is repo tooling, not a plugin. It exists because `bje-settings/claude` is
internal to the bje enterprise: a team that cannot read this repo cannot install
from it either, so until the repo is published, one plugin at a time is copied
into a repo that team can read. The destination supplies its own marketplace
manifest; all this writes is `<dest>/plugins/<name>/`.

WHAT GETS PUBLISHED IS WHAT IS COMMITTED. The file list comes from
`git ls-files -s -- plugins/<name>`, never from walking the directory, so what
reaches another team's repository is what someone committed here. Nothing
untracked or generated can ride along: no __pycache__, no .venv, no stray .env,
no .DS_Store. The index carries the mode as well as the path, so the executable
bit travels with the file.

Exit codes are a contract; the callers are a skill and a person reading a report:

    0  applied, or --check found the copy in sync
    1  --check found drift
    2  refused: a precondition did not hold and NOTHING was written
    3  an unexpected exception, or a write that failed partway

3 exists because Python exits 1 on an uncaught traceback. Without a top-level
handler an internal bug would be indistinguishable from drift, and a caller that
treats 1 as "there is work to do" would loop on a crash. A write that dies
partway is 3 rather than 2 for the same reason in reverse: 2 promises the
destination is untouched, and by then it is not. That case prints recovery
commands on stderr.

THE UNTRACKED ASYMMETRY. Untracked files in the SOURCE are reported and do not
block: publishing only reads the source, so an untracked file there is not at
risk and is simply not published, which is the reasoning `/gh:sync` gives for not
blocking on them either.

In the DESTINATION the question is what would be DESTROYED. A tracked file is
recoverable with `git checkout --`, so changing or removing one is reviewable
like any other diff; an untracked file is not, and overwriting it destroys it as
completely as deleting it. So a publish refuses when it would write over or
delete an untracked file there -- unless the copy already carries this tool's own
UPSTREAM.json naming this plugin and this source, which makes it a mirror we
manage, whose uncommitted files are our own previous output. See `unrecoverable`.

Nothing here commits, pushes, or touches a path outside `<dest>/plugins/<name>/`.
"""

from __future__ import annotations

import argparse
import datetime
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# The repo this script belongs to, from its own location rather than the working
# directory: the skill that runs it may be invoked from anywhere, and the source
# of a publish is never "wherever the caller happened to be".
ROOT = Path(__file__).resolve().parent.parent

# Written into the copy, and only into the copy, so the tree comparison has to
# exempt it or --check would forever report it as an extraneous file to delete.
PROVENANCE = "UPSTREAM.json"

# git's index modes. A regular file is 100644, an executable one 100755; a
# symlink is 120000 and a submodule 160000, and both of those are refused rather
# than guessed at.
MODE_FILE = "100644"
MODE_EXEC = "100755"
MODE_SYMLINK = "120000"
MODE_GITLINK = "160000"

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_REFUSED = 2
EXIT_CRASH = 3


class Refused(Exception):
    """A precondition did not hold. Nothing has been written; exit 2.

    The one place that invariant is qualified is `apply_mirror`, which can raise
    this from inside the copy or the sweep. `run` catches it there and exits 3
    with recovery instructions, precisely so that exit 2 keeps meaning "the
    destination is as you left it".
    """


# --------------------------------------------------------------------------
# stdout and stderr
#
# Inlined from plugins/gh/scripts/lib/streams.py, which is the canonical copy and
# carries the full reasoning for each function. It is not imported: a plugin's
# lib/ is reached with sys.path.insert, and the root tests/conftest.py only
# strips leftover sys.path entries whose parent parts contain "plugins", so a
# root scripts/ entry would linger between tests and could shadow a plugin's own
# lib. streams.py's own docstring records that three copies of this code drifted
# once; the locale and closed-reader tests in tests/test_publish.py are what
# catch a fourth.
# --------------------------------------------------------------------------


def bind_closed_streams():
    """Give the script something to write to when a descriptor is gone outright."""
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            setattr(sys, name, open(os.devnull, "w"))


def use_utf8(stream):
    """Make `stream` write UTF-8, replacing anything it cannot handle."""
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        # Left as it is on purpose: no reconfigure, or a detached stream. The
        # fallback is the original, loud UnicodeEncodeError, never a silent one.
        pass


def silence_output(include_stderr=True):
    """Send stdout, and by default stderr too, to devnull for a reader that left."""
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stdout.fileno())
        if include_stderr:
            os.dup2(devnull, sys.stderr.fileno())
    finally:
        os.close(devnull)


def flush_quietly():
    """Push buffered stdout out before writing to stderr, ignoring a gone reader.

    stderr is unbuffered and stdout is not, so without this a failure report
    overtakes the run's own output and the two read in the wrong order.
    """
    try:
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        # Swallowed on purpose, and only these two. This runs on the way to
        # reporting a failure on stderr, so it must not become the failure: a
        # reader that has gone away (BrokenPipeError) or a stream already closed
        # or detached (ValueError) are both states where there is nothing left to
        # flush and nothing anyone can do about it. The message that matters is
        # the one printed to stderr immediately after.
        pass


def write(text):
    """Print, and go quiet for the rest of the run once the reader has gone.

    stderr is left alone: the pipe is the reader's business, but a refusal or a
    crash after this point still has to be able to reach a terminal.
    """
    try:
        sys.stdout.write(text)
    except BrokenPipeError:
        silence_output(include_stderr=False)


# --------------------------------------------------------------------------
# git
# --------------------------------------------------------------------------


def run_git(repo, *args):
    """Run one git command in `repo`, returning (returncode, stdout, stderr).

    Raises Refused only when git itself is missing. A non-zero exit is handed
    back rather than raised, because a couple of callers need to tell one kind
    of failure from another; `git` is the wrapper for everyone else.
    """
    try:
        done = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        raise Refused("git is not on PATH") from None
    return (
        done.returncode,
        done.stdout.decode("utf-8", "replace"),
        done.stderr.decode("utf-8", "replace").strip(),
    )


def git(repo, *args):
    """One git command's stdout, stripped, or a refusal carrying git's own words.

    Never a summary of them: a caller reading the refusal needs to know what git
    actually said, and this repo's rule is that nothing reports a silence as a
    fact.
    """
    status, out, err = run_git(repo, *args)
    if status != 0:
        raise Refused(f"git {' '.join(args)} failed in {repo}: {err}")
    return out.strip()


def git_lines(repo, *args):
    """Records of a `-z` git listing, which is the only NUL-safe way to read one.

    The caller passes `-z` itself, in its correct position: appending it here
    would put it after the `--`, where git reads it as a pathspec rather than a
    flag and hands back one enormous unsplit record.

    Without `-z`, git applies `core.quotePath` (on by default) and hands back
    `"plugins/gh/caf\303\251.md"`, quotes included, for any non-ASCII name --
    and splits nothing at all for a name containing a newline, so a line-based
    reader sees two paths where there is one. The first case crashes; the second
    is worse, because a fragment can look like a legitimate relative path and
    then fail to match a real file, which in the delete sweep means walking past
    something it was asked to protect.
    """
    return [chunk for chunk in git(repo, *args).split("\0") if chunk]


def is_git_repo(path):
    """Whether `path` is inside a git repository.

    False only for git's own "not a repository" answer. Any other failure --
    `detected dubious ownership`, an unreadable .git, a corrupt one -- is a
    refusal carrying git's words, because telling someone their repository is
    not a repository sends them to re-clone something that is fine.
    """
    status, _, err = run_git(path, "rev-parse", "--git-dir")
    if status == 0:
        return True
    if "not a git repository" in err.lower():
        return False
    raise Refused(f"git could not read {path}: {err}")


def common_dir(repo):
    """The shared object store behind `repo`, canonicalised.

    A worktree has its own git dir but the same common dir as the checkout it
    came from, which is the only thing that distinguishes "another repo" from
    "another view of this one".

    realpath because git does not canonicalise symlinks here: on macOS /tmp is a
    symlink to /private/tmp, so the same object store reached by two names would
    compare unequal and the worktree guard would not fire.
    """
    return os.path.realpath(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))


def index_entries(repo, relative):
    """`{path: mode}` for everything git tracks under `relative`.

    Paths are relative to `relative` itself, so they are directly usable as
    destination paths.
    """
    entries = {}
    for chunk in git_lines(repo, "ls-files", "-s", "-z", "--", str(relative)):
        # "<mode> <sha> <stage>\t<path>"
        meta, _, path = chunk.partition("\t")
        fields = meta.split()
        if not fields or not path:
            raise Refused(f"could not read git's index listing for {relative}: {chunk!r}")
        entries[str(Path(path).relative_to(relative))] = fields[0]
    return entries


def parse_origin(url):
    """`owner/repo` from an origin URL, or None if it is not a shape we know.

    Handles the SSH form (git@host:owner/repo.git), the HTTPS form, and any host,
    since a fork of this repo may well not be on github.com. Returning None
    rather than guessing is deliberate: a malformed `source` in the copy's
    provenance is worse than a refusal, because it looks like an answer.
    """
    url = url.strip()
    if not url:
        return None

    # Peeled apart rather than matched in one go, because a single trailing
    # pattern cannot tell a host from an owner: "https://host/repo" would hand
    # back "host/repo", which looks exactly like a real answer and is wrong.
    stripped = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", "", url, count=1)
    had_scheme = stripped != url
    remainder = stripped
    # Userinfo only exists in a URL or the scp-like SSH form, both of which have
    # a host. Splitting on "@" unconditionally would eat the host of anything
    # else: a local path like ~/Code/@org/@team/repo would come back as
    # "@team/repo", which is not a slug but looks exactly like one.
    if had_scheme or re.match(r"^[^/]*@[^/]*:", remainder):
        remainder = remainder.split("@", 1)[-1]
    elif remainder.startswith((".", "/", "~")) or os.sep in remainder and ":" not in remainder:
        # A filesystem path, not a remote. Nothing here is an owner or a repo.
        return None
    # The host, then the separator the two forms differ on: ':' for the scp-like
    # SSH form, '/' for a URL. An optional port belongs to the host either way.
    match = re.match(r"^[^/:]+(?::\d+)?[:/](.+)$", remainder)
    if not match:
        return None

    path = match.group(1).strip("/")
    if path.endswith(".git"):
        path = path[: -len(".git")]
    parts = [part for part in path.split("/") if part and part not in (".", "..")]
    if len(parts) != 2:
        # Exactly two, not "the last two". A nested-group URL and a browser URL
        # such as .../owner/repo/tree/main are indistinguishable here, and the
        # second would yield "tree/main" -- wrong, and plausible enough that
        # nobody would question it in the copy's provenance.
        return None
    return "/".join(parts)


# --------------------------------------------------------------------------
# preflight
# --------------------------------------------------------------------------


def check_source(plugin):
    """The source plugin directory, once it is safe to publish from.

    Returns (source_path, index_entries, untracked_paths). Untracked files are
    handed back to be reported, not to block: see the module docstring.
    """
    source = ROOT / "plugins" / plugin
    relative = Path("plugins") / plugin
    if not source.is_dir():
        raise Refused("no plugin named {!r} in {}".format(plugin, ROOT / "plugins"))
    if not (source / ".claude-plugin" / "plugin.json").is_file():
        raise Refused(f"{source} has no .claude-plugin/plugin.json; it is not a plugin")

    dirty = git(ROOT, "status", "--porcelain", "--untracked-files=no", "--", str(relative))
    if dirty:
        raise Refused(
            f"{relative} has uncommitted changes; commit or revert them first, because a "
            f"publish copies what is committed:\n{dirty}"
        )

    entries = index_entries(ROOT, relative)
    if not entries:
        raise Refused(f"git tracks no files under {relative}")
    for path, mode in sorted(entries.items()):
        if mode == MODE_SYMLINK:
            raise Refused(
                f"{relative}/{path} is a symlink, which this does not publish: following it would "
                "inline foreign content into the copy, and preserving it could point "
                "outside the destination"
            )
        if mode == MODE_GITLINK:
            raise Refused(f"{relative}/{path} is a submodule, which this does not publish")

    untracked = git(ROOT, "ls-files", "--others", "--exclude-standard", "--", str(relative))
    return source, entries, [line for line in untracked.splitlines() if line.strip()]


def check_destination(dest_repo, plugin):
    """The destination plugin directory, once it is a legitimate place to write.

    The directory not existing yet is fine: that is the first publish. What the
    write would DESTROY is a separate question, decided in `run` once the plan
    is known; see `unrecoverable`.
    """
    if os.path.islink(str(dest_repo)):
        raise Refused(
            f"{dest_repo} is a symlink; refusing, because the writes would land outside the "
            "repository it appears to be"
        )
    if not dest_repo.exists():
        raise Refused(f"{dest_repo} does not exist")
    if not dest_repo.is_dir():
        raise Refused(f"{dest_repo} is not a directory")
    if not is_git_repo(dest_repo):
        raise Refused(
            f"{dest_repo} is not a git repository; the copy has to be reviewable and "
            "revertable there"
        )

    if common_dir(dest_repo) == common_dir(ROOT):
        raise Refused(
            f"{dest_repo} shares a git object store with {ROOT}, so it is this same repository "
            "(a worktree of it, or the checkout itself). Publishing into it would "
            "overwrite the plugin with itself."
        )

    relative = Path("plugins") / plugin
    target = dest_repo / relative
    if os.path.islink(str(target)):
        raise Refused(f"{target} is a symlink; refusing to write through it")
    if target.exists() and not target.is_dir():
        raise Refused(f"{target} exists and is not a directory")

    resolved_source = (ROOT / relative).resolve()
    resolved_target = target.resolve() if target.exists() else target.parent.resolve() / plugin
    if resolved_source == resolved_target:
        raise Refused(f"source and destination are the same directory: {resolved_source}")

    if target.exists():
        if MODE_GITLINK in index_entries(dest_repo, relative).values():
            raise Refused(f"{target} is a submodule in the destination")

        dirty = git(dest_repo, "status", "--porcelain", "--untracked-files=no", "--", str(relative))
        if dirty:
            raise Refused(
                f"{relative} has uncommitted changes in the destination; a publish would "
                f"overwrite them:\n{dirty}"
            )
    return target


def untracked_in(dest_repo, relative):
    """Paths under `relative` that git does not track, relative to `relative`.

    Deliberately WITHOUT --exclude-standard. The question here is "could git
    give this file back", and for an ignored file the answer is no, exactly as
    for any other untracked one. Asking with --exclude-standard means a
    destination whose .gitignore happens to cover plugins/<name>/ reports
    nothing untracked at all, and the guard built on it silently permits the
    sweep to delete a stranger's work.
    """
    return {
        str(Path(line).relative_to(relative))
        for line in git_lines(
            dest_repo,
            "ls-files",
            "--others",
            "-z",
            "--",
            str(relative),
        )
    }


def unrecoverable(dest_repo, relative, touched, managed):
    """Of the files this publish would write over or delete, the ones git cannot restore.

    A tracked file is recoverable downstream with `git checkout --`, so changing
    or removing one is reviewable like any other diff. An untracked file is not:
    git cannot restore something it never tracked. Overwriting destroys it every
    bit as completely as unlinking it, which is why `touched` is every path the
    publish would add, change OR remove, and not just the ones it would delete.

    `managed` is what keeps the rule from being uselessly strict. Once a copy
    carries this tool's own UPSTREAM.json naming this plugin and this source, the
    directory is a mirror we manage: every file in it came from here, so an
    untracked one is output from a previous run that has not been committed yet
    and rewriting or dropping it costs nothing. That is the normal loop --
    publish, look, publish again -- and a blanket rule would deadlock it and
    would also refuse to propagate an upstream deletion.

    Before that stamp exists the directory belongs to whoever made it. That is
    the first publish, which is exactly when the destination is least likely to
    be what the operator thinks it is.
    """
    if managed:
        return []
    loose = untracked_in(dest_repo, relative)
    return sorted(path for path in touched if path in loose)


# --------------------------------------------------------------------------
# provenance
# --------------------------------------------------------------------------


def provenance(plugin, source, previous):
    """What UPSTREAM.json should say, given what it already says.

    `commit` is the last commit that touched the plugin, not HEAD. HEAD moves
    whenever anything lands anywhere in this repo, including work on another
    plugin that does not change this copy by a byte; the plugin-scoped SHA names
    the commit the content actually came from and stays put for unrelated work.

    `published` is carried over whenever nothing else changed, so re-publishing
    unchanged content produces a byte-identical file. Between them these make the
    whole operation idempotent, which is what lets a reviewer downstream treat
    any diff at all as real content rather than learning to wave through a date
    bump.
    """
    relative = Path("plugins") / plugin
    url = git(ROOT, "remote", "get-url", "origin")
    slug = parse_origin(url)
    if slug is None:
        raise Refused(
            f"cannot read owner/repo out of the origin URL {url!r}, and a copy whose "
            "provenance is wrong is worse than one that was not written"
        )
    manifest_path = source / ".claude-plugin" / "plugin.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise Refused(f"could not read {manifest_path}: {error}") from None
    version = manifest.get("version") if isinstance(manifest, dict) else None
    if not version:
        # Refused rather than recorded as null. Downstream the version is how one
        # copy is told from another, and it is what provenance_drift compares, so
        # a null would sit in the copy forever comparing equal to itself.
        raise Refused(f"{manifest_path} declares no version, which the copy is identified by")
    commit = git(ROOT, "log", "-1", "--format=%H", "--", str(relative))

    record = {
        "source": slug,
        "plugin": plugin,
        "version": version,
        "commit": commit,
        "published": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
    }
    if isinstance(previous, dict):
        carried = dict(record)
        carried["published"] = previous.get("published", record["published"])
        if carried == previous:
            return carried
    return record


def read_provenance(target):
    """The copy's UPSTREAM.json, or None when it is absent or unreadable."""
    path = target / PROVENANCE
    if not path.is_file():
        return None
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    return loaded if isinstance(loaded, dict) else None


def render_provenance(record):
    return json.dumps(record, indent=2, sort_keys=True) + "\n"


# --------------------------------------------------------------------------
# the mirror
# --------------------------------------------------------------------------


def is_executable(path):
    return bool(path.stat().st_mode & 0o111)


def wanted_mode(mode):
    return MODE_EXEC if mode == MODE_EXEC else MODE_FILE


def _raise_walk_error(error):
    raise Refused(f"could not read {getattr(error, 'filename', '')}: {error}")


def walk(root):
    """os.walk that raises instead of skipping a directory it cannot read.

    os.walk swallows every scandir error by default, so an unreadable directory
    yields nothing and looks exactly like an empty one. Everything here that
    walks is answering a question where "empty" and "could not look" have
    opposite consequences: the delete sweep would leave files behind, the plan
    would call the copy in sync, and the confinement pass would prove nothing
    about the part of the tree it never saw. This repo's rule is that nothing
    reports a silence as a fact.
    """

    return os.walk(str(root), onerror=_raise_walk_error)


def plan(source, entries, target):
    """What would have to change downstream, as (added, changed, removed).

    `changed` covers a differing mode as well as differing bytes. A comparison
    that looked only at content would call a copy in sync while git reported a
    permanent `old mode 100755 / new mode 100644` diff that re-running this could
    never clear.

    A destination path that exists but is not a regular file -- a directory
    where upstream has a file, or a symlink -- is a refusal rather than an
    `added`. Copying onto a directory writes a file *inside* it and then strips
    the execute bit off the directory itself, leaving a tree that neither git
    nor rm can traverse; copying onto a symlink writes through it and silently
    corrupts whatever it points at, and leaves the link in place so the copy
    never converges.
    """
    added, changed, removed = [], [], []
    for path in sorted(entries):
        want = source / path
        have = target / path
        if os.path.islink(str(have)) or (have.exists() and not have.is_file()):
            raise Refused(
                f"{target / path} already exists and is not a regular file. "
                "Refusing: writing onto it would corrupt what is there rather "
                "than replace it. Remove it in the destination first."
            )
        if not have.exists():
            added.append(path)
        elif not filecmp.cmp(str(want), str(have), shallow=False):
            changed.append(path)
        elif is_executable(have) != (wanted_mode(entries[path]) == MODE_EXEC):
            changed.append(path)

    if target.is_dir():
        for relative in extraneous(target, entries):
            removed.append(relative)
    return added, changed, sorted(removed)


def keep_set(target, entries):
    """What the sweep must not delete: the published names, and their identities.

    Names alone are not enough. On a case-insensitive filesystem -- APFS by
    default, so every Mac this runs on -- an upstream rename that changes only
    case leaves the file on disk under its old name while the new name refers to
    that same file. Compared by name the old one looks extraneous, and the sweep
    deletes the file that was just published.

    os.path.normcase does not help: on POSIX it returns the path unchanged, so
    it silently does nothing on the platform where the problem occurs. Device
    and inode identify the file itself and are exact on either kind of
    filesystem.
    """
    names = set(entries) | {PROVENANCE}
    identities = set()
    for name in names:
        try:
            found = (target / name).stat()
        except OSError:
            continue
        identities.add((found.st_dev, found.st_ino))
    return names, identities


def extraneous(target, entries):
    """Paths under `target` that this publish does not account for."""
    names, identities = keep_set(target, entries)
    loose = []
    for current, _, files in walk(target):
        for name in files:
            found = Path(current) / name
            relative = str(found.relative_to(target))
            if relative in names:
                continue
            here = found.stat()
            if (here.st_dev, here.st_ino) in identities:
                continue
            loose.append(relative)
    return loose


def confine(target, path):
    """Refuse a write or a delete that would land outside `target`.

    "This never touches anything outside <dest>/plugins/<name>/" is the promise
    the whole tool rests on, and everything above enforces it only at the top:
    `check_destination` rejects a symlinked destination and a symlinked plugin
    directory, and nothing checks the directories in between. A symlinked
    subdirectory downstream -- `plugins/gh/scripts` pointing elsewhere -- would
    pass every one of those guards, and then `shutil.copy2` would happily write
    straight through it into another part of the repository, or out of it
    entirely.

    So the promise is checked where it is kept, against the resolved path, on
    every file this writes or removes. os.walk does not follow symlinked
    directories, which is why the delete sweep cannot find them on its own.
    """
    root = os.path.realpath(str(target))
    resolved = os.path.realpath(str(path))
    if resolved != root and not resolved.startswith(root + os.sep):
        raise Refused(
            f"{path} resolves to {resolved}, outside {root}. Something in the "
            "destination path is a symlink; refusing rather than writing through it."
        )


def check_confinement(target, entries):
    """Prove every path the mirror would touch stays inside `target`, first.

    `confine` alone would catch an escape, but only on reaching it, halfway
    through a copy -- and a refusal that has already written files is the worst
    of both outcomes. So the whole set is checked before anything is written, and
    the per-file calls stay as the invariant rather than the detection.

    os.path.realpath resolves the symlinks in whatever prefix already exists, so
    a destination path whose parents are not there yet is answered correctly.
    """
    for path in sorted(entries):
        confine(target, target / path)
    if target.is_dir():
        for current, directories, files in walk(target):
            for name in list(directories) + files:
                confine(target, Path(current) / name)


def apply_mirror(source, entries, target, record):
    """Copy, then delete, then write provenance.

    In that order on purpose. Copying first means a run that dies partway leaves
    a superset of the right files rather than a half-deleted tree, and it is what
    `rsync --delete` does for the same reason. UPSTREAM.json goes last and
    atomically, so "tree complete but provenance missing" is a state --check can
    name rather than a silent half-copy.
    """
    target.mkdir(parents=True, exist_ok=True)
    for path in sorted(entries):
        destination = target / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        confine(target, destination)
        # copy2, not copy or copyfile: the executable bit is part of what git
        # tracks, so a copy that dropped it would show downstream as a mode diff.
        shutil.copy2(str(source / path), str(destination))
        mode = destination.stat().st_mode
        if wanted_mode(entries[path]) == MODE_EXEC:
            destination.chmod(mode | 0o111)
        else:
            destination.chmod(mode & ~0o111)

    # Recomputed after the copy, not reused from plan(): the identities are of
    # the files as they are now, which is what makes a case-only rename resolve
    # to the file just written rather than to a name that no longer applies.
    for relative in extraneous(target, entries):
        found = target / relative
        confine(target, found)
        found.unlink()
    prune_empty(target)

    written = target / PROVENANCE
    staging = target / (PROVENANCE + ".tmp")
    staging.write_text(render_provenance(record), encoding="utf-8")
    os.replace(str(staging), str(written))


def prune_empty(target):
    """Drop directories the delete sweep emptied.

    git cannot track an empty directory, so one left behind is invisible to
    `git status` downstream and would make --check and git disagree forever.
    """
    for current, _, _ in os.walk(str(target), topdown=False, onerror=_raise_walk_error):
        here = Path(current)
        if here == target:
            continue
        # iterdir, not os.walk's own lists: bottom-up, the child directories were
        # enumerated before this pass emptied them, so those lists are stale by
        # the time they are read and a nested directory would never be pruned.
        if not any(here.iterdir()):
            here.rmdir()


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------


def report_lines(added, changed, removed):
    for label, paths in (("add", added), ("update", changed), ("remove", removed)):
        for path in paths:
            yield f"  {label:<7} {path}"


def run(args):
    source, entries, untracked = check_source(args.plugin)
    target = check_destination(args.dest, args.plugin)
    check_confinement(target, entries)
    relative = Path("plugins") / args.plugin

    previous = read_provenance(target)
    record = provenance(args.plugin, source, previous)
    added, changed, removed = plan(source, entries, target)

    # Whether this copy is one this tool already owns. Both halves matter: a
    # stamp naming another plugin, or another source repository, is not a licence
    # to delete files out of this directory.
    managed = bool(
        previous
        and previous.get("plugin") == record["plugin"]
        and previous.get("source") == record["source"]
    )

    # Printed on every run, in sync or not. The recorded commit is not what
    # decides the exit status -- a revert-and-recommit moves it without changing
    # a byte of content -- so if it were only printed on drift it would be
    # invisible exactly when someone wanted to know it.
    write("{} {} from {}\n".format(record["plugin"], record["version"], record["source"]))
    write("  upstream commit  {}\n".format(record["commit"]))
    if previous:
        write(
            "  copy records     {} ({}, published {})\n".format(
                previous.get("commit", "nothing"),
                previous.get("version", "no version"),
                previous.get("published", "never"),
            )
        )
    else:
        write(f"  copy records     nothing; no readable {PROVENANCE}\n")
    for line in untracked:
        write(f"  not published    {line} (untracked)\n")

    stale = provenance_drift(previous, record, target, entries)
    if args.check:
        if not (added or changed or removed or stale):
            write(f"in sync: {args.dest / relative} matches {relative}\n")
            return EXIT_OK
        write(f"drift against {relative}:\n")
        for line in report_lines(added, changed, removed):
            write(line + "\n")
        if stale:
            write("  {:<7} {}\n".format("fix", stale))
        return EXIT_DRIFT

    if not (added or changed or removed) and previous == record:
        write("already in sync; nothing written\n")
        return EXIT_OK

    doomed = unrecoverable(args.dest, relative, added + changed + removed, managed)
    if doomed:
        raise Refused(
            "{} holds untracked files this publish would overwrite or delete, and it carries no "
            "{} of ours saying the directory is a copy we manage. Refusing, "
            "because git cannot restore a file it never tracked:\n{}\n"
            "Commit or remove them, or run with --check to see the whole "
            "difference first.".format(
                relative, PROVENANCE, "\n".join("  " + path for path in doomed)
            )
        )

    try:
        apply_mirror(source, entries, target, record)
    except (OSError, Refused) as error:
        # Not EXIT_REFUSED: a refusal means nothing was written, and by here the
        # copy is half-made. On stderr, not through write(), because write() has
        # gone quiet if the reader left and this is the one message that must
        # arrive.
        flush_quietly()
        print(
            f"publish-plugin.py: failed partway through writing {args.dest / relative}: {error}\n"
            "The copy is incomplete. Recover in the destination with:\n"
            f"  git -C {args.dest} checkout -- {relative}\n"
            f"  git -C {args.dest} clean -fd {relative}\n"
            "Note that `clean -fd` also removes untracked files under that path.",
            file=sys.stderr,
        )
        return EXIT_CRASH

    for line in report_lines(added, changed, removed):
        write(line + "\n")
    write(
        f"published {relative} into {args.dest / relative}\n"
        "nothing is committed; review and commit it there\n"
    )
    return EXIT_OK


def provenance_drift(previous, record, target, entries):
    """Why the copy's provenance is wrong, or "" when it is fine.

    Three arms. Absent or unreadable is drift: provenance is the one thing the
    destination cannot derive, so a copy without it is not in the state this tool
    produces. A version disagreeing with the copy's own manifest is drift, and is
    the signature of a hand-edit or an apply that died partway. A record naming a
    different plugin or a different source repository is drift too, and is the
    one that means this directory belongs to some other mirror entirely.

    A stale `commit` alone is NOT drift, for the reason given in run().
    """
    if previous is None:
        return f"{PROVENANCE} is missing or unreadable"
    manifest = target / ".claude-plugin" / "plugin.json"
    if ".claude-plugin/plugin.json" in entries and manifest.is_file():
        try:
            copied = json.loads(manifest.read_text(encoding="utf-8")).get("version")
        except (ValueError, OSError):
            return f"{manifest.name} in the copy cannot be read"
        if previous.get("version") != copied:
            return "{} says version {!r} but the copied manifest says {!r}".format(
                PROVENANCE, previous.get("version"), copied
            )
    if previous.get("plugin") != record["plugin"] or previous.get("source") != record["source"]:
        return f"{PROVENANCE} names a different plugin or source repository"
    return ""


def main(argv):
    bind_closed_streams()
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)

    parser = argparse.ArgumentParser(
        prog="publish-plugin.py",
        description="Mirror one plugin into a downstream repo as a read-only copy.",
    )
    parser.add_argument("plugin", help="plugin directory name under plugins/")
    parser.add_argument("dest", type=Path, help="path to the destination repository")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift and write nothing; exit 1 if the copy is not current",
    )
    args = parser.parse_args(argv)

    try:
        status = run(args)
    except Refused as refusal:
        print(f"refused: {refusal}", file=sys.stderr)
        return EXIT_REFUSED

    try:
        # Flushed here, while a BrokenPipeError can still be caught. Left to
        # interpreter shutdown it prints its own "Exception ignored in" trace.
        sys.stdout.flush()
    except BrokenPipeError:
        silence_output()
    return status


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(EXIT_CRASH)
    except Exception as error:  # noqa: BLE001 - the whole point is that nothing escapes as 1
        # str, not repr: repr(OSError) drops the filename, which is the one
        # thing an operator needs to act on.
        print(
            f"publish-plugin.py: unexpected failure: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        sys.exit(EXIT_CRASH)
