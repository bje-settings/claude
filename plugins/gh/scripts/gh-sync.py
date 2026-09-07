#!/usr/bin/env python3
"""gh-sync.py — sync the current checkout, or every checkout one level down.

Usage:
  gh-sync.py [--dry-run] [--no-install] [-j N] [path]

Scope comes from the target directory, so no caller has to classify it:
  - the directory is a git repo     -> sync that repo
  - the directory is not a git repo -> sync every immediate subdirectory that
                                       is a git repo, non-recursively

Subdirectories that are not git repos are skipped without comment. Nothing is
ever cloned: only checkouts that already exist locally are touched.

The per-repo work is gh-sync-repo.py, one subprocess per repository, at most
`-j N` at a time. Its output is collected per repo and printed in directory
order, never in the order the jobs happened to finish.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

REPO_SCRIPT = os.path.join(HERE, "gh-sync-repo.py")
DISCOVER_LIB = os.path.join(HERE, "lib", "discover.py")

try:
    from lib import discover  # noqa: E402
except ImportError:  # pragma: no cover - only reachable in a broken checkout
    # A checkout missing its own library is reported as the wiring mistake it is,
    # rather than as a traceback naming an import the reader did not write.
    discover = None

DEFAULT_JOBS = "4"

# A -j that is not a positive integer is refused rather than clamped: the shell
# version this replaces read it in arithmetic context, where a non-numeric word
# is 0 and the throttle never lets a job start, so the run hung instead of
# failing. Nothing may quietly reinterpret it here either.
JOBS_RE = re.compile(r"^[1-9][0-9]*$")

# Set once the reader closes the pipe: the report stops, the sync does not.
_quiet = False


def write(text):
    """Write part of the report, or nothing once the reader has gone away.

    `gh-sync.py <dir> | head` closes the pipe partway through the report. The
    jobs have already run by then and may have deleted branches; abandoning the
    rest of the loop would only lose the account of it, so the first
    BrokenPipeError silences the report and the run finishes normally.

    Raw, not `print`: a job's output is passed through exactly as it arrived,
    down to its trailing newlines, because the session-start hook greps it.
    """
    global _quiet
    if _quiet:
        return
    try:
        sys.stdout.write(text)
    except BrokenPipeError:
        _quiet = True
        silence_output()


def parse_args(argv):
    """(target, jobs, dry_run, no_install, status). A status that is not None means stop."""
    dry_run = False
    no_install = False
    jobs = DEFAULT_JOBS
    target = ""
    rest = list(argv)
    while rest:
        arg = rest.pop(0)
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--no-install":
            no_install = True
        elif arg == "-j":
            jobs = rest.pop(0) if rest else DEFAULT_JOBS
        elif arg.startswith("-j"):
            jobs = arg[2:]
        elif arg in ("-h", "--help"):
            print(__doc__.strip())
            return target, 0, dry_run, no_install, 0
        elif arg.startswith("-"):
            print(f"unknown flag: {arg}", file=sys.stderr)
            return target, 0, dry_run, no_install, 2
        else:
            target = arg
    if not JOBS_RE.match(jobs):
        print(f"invalid -j value: {jobs}", file=sys.stderr)
        return target, 0, dry_run, no_install, 2
    return target, int(jobs), dry_run, no_install, None


def run_one(repo):
    """(exit status, output) of one repository's sync, stderr folded into stdout.

    Captured rather than inherited so the reports cannot interleave: several of
    these run at once, and a repository's lines belong together.
    """
    completed = subprocess.run(
        [sys.executable, REPO_SCRIPT, repo],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return completed.returncode, completed.stdout.decode("utf-8", "replace")


def run_all(repos, jobs):
    """Every repository's (status, output), at most `jobs` running at a time."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        # map, not as_completed: the results come back in the order the repos
        # were submitted, which is the order the report is written in.
        return list(pool.map(run_one, repos))


def report(target, repos, results):
    """Print the collected reports in directory order, under one header."""
    write(f"{target} ({len(repos)} repos)\n\n")
    for status, output in results:
        write(output)
        # The job's own exit status goes into its own section of the report, so a
        # crashed or killed repo cannot pass for one that simply had nothing to say.
        if status != 0:
            write(f"  ✗ sync script exited with status {status}\n")


def use_utf8(stream):
    """Make `stream` write UTF-8, replacing anything it cannot encode.

    The report carries ✓, ✗ and · from the per-repo jobs, and a repository path
    may hold any byte, so under a single-byte locale (LC_ALL=en_US.ISO8859-1,
    PYTHONIOENCODING=ascii) printing one raises UnicodeEncodeError. A stream that
    has been replaced with something without reconfigure, or that is already
    detached, is left alone rather than turned into a different crash.
    """
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def silence_output():
    """Send both descriptors to devnull, for a reader that has gone away.

    Both, not just stdout, so nothing the interpreter still tries to flush on the
    way out can resurface as a broken-pipe trace either.
    """
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, sys.stdout.fileno())
        os.dup2(devnull, sys.stderr.fileno())
    finally:
        os.close(devnull)


def main(argv):
    use_utf8(sys.stdout)
    use_utf8(sys.stderr)
    target, jobs, dry_run, no_install, status = parse_args(argv)
    if status is not None:
        return status

    target = target or os.getcwd()
    if not os.path.isdir(target):
        print(f"not a directory: {target}", file=sys.stderr)
        return 2
    # realpath, because git reports symlink-resolved paths and the comparison in
    # discovery must agree with it. On macOS /tmp and /var are symlinks, so the
    # logical path never matches and every repo beneath one would be skipped.
    target = os.path.realpath(target)

    if not os.path.exists(REPO_SCRIPT):
        print(f"missing {REPO_SCRIPT}", file=sys.stderr)
        return 2
    # `discover is None` is the same wiring mistake seen from the import side, and
    # gets the same answer rather than an AttributeError further down.
    if discover is None or not os.path.exists(DISCOVER_LIB):
        print(f"missing {DISCOVER_LIB}", file=sys.stderr)
        return 2

    os.environ["GH_SYNC_DRY_RUN"] = "1" if dry_run else "0"
    os.environ["GH_SYNC_NO_INSTALL"] = "1" if no_install else "0"

    repos = discover.discover_repos(target)

    # A target inside a repo yields exactly that repo, and it runs in the
    # foreground with the report going straight out: no header, no collecting.
    # A directory that merely holds one repo is still a fan-out, and says so.
    if len(repos) == 1 and discover.toplevel(target):
        # The status is deliberately dropped, as the shell version dropped it: a
        # skipped repo and a broken script both exit 0 here today.
        subprocess.run([sys.executable, REPO_SCRIPT, repos[0]])
        return 0

    if not repos:
        write(f"No git repositories directly inside {target}\n")
        return 0

    # The whole fan-out runs before a line of the report is written, as the shell
    # version did: the reports are assembled in directory order, not in the order
    # the jobs finished.
    report(target, repos, run_all(repos, jobs))

    try:
        # Forces the write now, while BrokenPipeError still lands in the handler
        # below. Left implicit, buffered output is flushed during interpreter
        # shutdown instead, which prints its own "Exception ignored in" trace.
        sys.stdout.flush()
    except BrokenPipeError:
        silence_output()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
