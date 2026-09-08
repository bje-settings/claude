#!/usr/bin/env python3
"""The gh plugin's SessionStart hook: hooks.json runs this file directly.

A report-only sync check at session start. It never changes a branch, worktree,
or working tree: the fan-out branch runs `gh-sync.py --dry-run --no-install`, and
the in-repo branch does not touch the network at all. The fan-out branch does
fetch, which updates remote-tracking refs.

It stays silent unless there is something worth acting on, because a hook that
speaks every single time stops being read, and it always exits 0 on the
`session-start` path, so nothing here can stop a session from starting. The
`; exit 0` in hooks.json holds the same guarantee for the cases this file is
never reached in at all: no python3 on PATH, or a hooks directory this file was
never installed into.

Usage:
  hook-io.py session-start              the whole hook; payload on stdin
  hook-io.py cwd                        read the payload on stdin, print its cwd
  hook-io.py branch <current> <default> the "you are not on the default branch" message
  hook-io.py report                     the fan-out report, read from stdin

The last three are the pieces `session-start` is built from, kept as
subcommands because they are the seams the tests and a human debugging the hook
work at.

Anything else -- no subcommand, one that is not a subcommand, or `branch`
without exactly two branch names -- is the one path that answers with a usage
message and exit 2: a typo in hooks.json is a wiring mistake, and a hook that
swallowed it would be silent about the check it was supposed to run for the life
of the install. hooks.json's `; exit 0` absorbs the status, so the diagnostic
that actually survives is the usage line on stderr, which Claude Code's debug
log keeps. Nothing is written to stdout there, so the hook still contributes no
context.

stderr is where the other degraded runs leave their trace too, for the same
reason: a missing `gh-sync.py` or a missing git is worth one line in the debug
log and nothing at all in the session.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(os.path.dirname(HERE), "scripts")
SYNC = os.path.join(SCRIPTS, "gh-sync.py")

sys.path.insert(0, SCRIPTS)

try:
    from lib import discover, streams  # noqa: E402
except ImportError:
    # A hook must not be the reason a session stops, so an installation missing
    # the plugin's own library still runs: it loses the stream handling and the
    # repository count in one message, and nothing else. Every use is guarded.
    discover = None
    streams = None

ORIGIN_HEAD = "refs/remotes/origin/HEAD"
ORIGIN_PREFIX = "refs/remotes/origin/"

# Only speak when the fan-out report contains something actionable: a proposed
# change ("would ..."), a problem ("✗"), or a degraded run ("could not ..."). A
# run whose merge lookups all failed has nothing to propose, and silence there
# would read as "everything is in order" rather than "nothing could be checked".
ACTIONABLE = ("would ", "✗", "could not")

# The hook's own budget is 60 seconds, so the fan-out has to be stopped with time
# left to say that it was. One fetch per repository is the slow part, and a
# directory of repositories against a remote that is answering slowly is exactly
# the case that runs over.
SYNC_TIMEOUT = 50.0
SYNC_TIMEOUT_ENV = "GH_HOOK_SYNC_TIMEOUT"

FAILED_LINE = "could not run the sync check: {detail}"
TIMEOUT_LINE = (
    "could not finish the sync check within {seconds} s ({count} repositories under {cwd})"
)

BRANCH_MESSAGE = """\
This session started on branch '{current}'; the repository's default branch is '{default}'.
Ask the user whether they would like to run /gh:sync to move to '{default}', fast-forward it,
and prune branches whose work has already landed. Ask first. Do not run it unprompted, and do
not mention this if the user is clearly in the middle of something else.
"""

REPORT_MESSAGE = """\
A read-only /gh:sync check ran for the repositories below. No branch, worktree, or working tree
was changed (it does fetch, so remote-tracking refs are current).

{report}

Offer to run /gh:sync to apply this for real. Ask first, and report the outcome plainly,
including any repository that gets skipped and why.
"""


def emit(context):
    """Write one SessionStart hook response.

    `additionalContext` is model-context-only: it surfaces only once the model
    takes a turn, and a user whose first input pre-empts that turn (running the
    very command this hook would have suggested) never sees it at all.
    `systemMessage` is rendered directly by the CLI regardless of whether the
    model ever takes a turn, so the same text goes out both ways.
    """
    json.dump(
        {
            "systemMessage": context,
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            },
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


def note(line):
    """One line to stderr, where Claude Code's debug log keeps it.

    stdout carries the hook response and nothing else, so a run that is degraded
    but has nothing a session should act on still leaves a trace for whoever is
    debugging the install.
    """
    sys.stderr.write(line + "\n")


def payload_cwd():
    """The `cwd` of the payload on stdin, or "" when there is not one to read.

    A malformed payload is not an error worth failing on: the caller falls back
    to its own working directory, and the hook must never block a session. A cwd
    that is not a string is treated as absent rather than coerced, because the
    only thing done with it is `os.path.isdir`, where an integer would be read as
    a file descriptor.
    """
    try:
        payload = json.load(sys.stdin)
    except (ValueError, AttributeError, OSError, UnicodeDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    value = payload.get("cwd")
    return value if isinstance(value, str) else ""


def read_cwd():
    """Print the payload's cwd, or an empty line if it cannot be read."""
    print(payload_cwd())


def git(cwd, *args):
    """git in `cwd`: its stripped stdout, or None when the command failed.

    None and "" are different answers and both are used below: `show-ref
    --verify --quiet` succeeds with no output at all, so only None can mean "the
    ref is not there". stderr is discarded here on purpose: the failure worth a
    line in the debug log is git missing altogether, which `session_start`
    checks once before any of this, and a ref that is not there is not a failure
    at all.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", cwd, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        # A cwd that vanished between the isdir check and here, or a git that
        # left the PATH since `session_start` looked. Nothing to report either
        # way.
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.decode("utf-8", "replace").strip()


def default_branch(cwd):
    """The repository's default branch, resolved without going to the network.

    The cached `origin/HEAD` first, and where a clone never fetched one, the
    first of `main` and `master` that exists locally. Asking the remote would
    mean a round trip on every session start, which is exactly what the in-repo
    branch of this hook exists to avoid.
    """
    ref = git(cwd, "symbolic-ref", "--quiet", ORIGIN_HEAD)
    if ref:
        if ref.startswith(ORIGIN_PREFIX):
            return ref[len(ORIGIN_PREFIX) :]
        return ref
    for candidate in ("main", "master"):
        if git(cwd, "show-ref", "--verify", "--quiet", "refs/heads/" + candidate) is not None:
            return candidate
    return ""


def branch_message(cwd):
    """The in-repo message, or None when there is nothing worth saying.

    Nothing to say on a detached HEAD (there is no branch to compare), on a
    repository whose default branch cannot be resolved locally, or when the
    session already started on the default branch.
    """
    current = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    if not current or current == "HEAD":
        return None
    default = default_branch(cwd)
    if not default or default == current:
        return None
    return BRANCH_MESSAGE.format(current=current, default=default)


def sync_timeout():
    """The fan-out's budget in seconds: SYNC_TIMEOUT, or the override.

    The environment override exists so a test can reach the timeout arm without
    waiting out the real bound. Anything unparseable or not positive is the
    default rather than an error: this is a hook, and a stray value in the
    environment must not be the thing that decides a session.
    """
    raw = os.environ.get(SYNC_TIMEOUT_ENV, "")
    try:
        value = float(raw)
    except ValueError:
        return SYNC_TIMEOUT
    return value if value > 0 else SYNC_TIMEOUT


def kill_group(child):
    """Stop the fan-out and everything it started.

    `gh-sync.py` spawns a `gh-sync-repo.py` per repository, each of which runs
    git: killing the child alone would leave those running against the network
    long after the session moved on. The child is its own session leader, so the
    group signalled here cannot reach this hook or the session that started it.
    """
    try:
        os.killpg(os.getpgid(child.pid), signal.SIGKILL)
    except OSError:
        # The child is already gone, or has no group of its own to signal.
        child.kill()


def repo_count(cwd):
    """How many repositories the fan-out was working through.

    The same discovery `gh-sync.py` does, so the number in the timeout message
    is the one it was working from. It is a local `git rev-parse` per immediate
    subdirectory, cheap even directly after a run that used its whole budget.
    Any failure answers 0: this is one detail inside a message about a different
    failure, and it must not become a second one.
    """
    if discover is None:
        return 0
    try:
        return len(discover.discover_repos(cwd))
    except Exception:
        return 0


def last_line(text):
    """The last line of `text` with anything in it, stripped, or ""."""
    for line in reversed(text.splitlines()):
        if line.strip():
            return line.strip()
    return ""


def run_sync(cwd):
    """The dry-run fan-out's report, or a one-line account of a degraded run.

    `sys.executable`, not `python3`: the child must be the interpreter already
    running this hook, not whichever one happens to come first on the PATH of
    the session that started.

    Popen rather than `subprocess.run(timeout=...)`: on a timeout the whole
    process group has to go, and `TimeoutExpired` does not carry the pid to
    signal it by.
    """
    timeout = sync_timeout()
    try:
        child = subprocess.Popen(
            [sys.executable, SYNC, "--dry-run", "--no-install", cwd],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        # `os.access` said the file is readable and the exec still failed: a
        # partial install, or a machine out of processes. Nothing to say.
        return None
    try:
        out, err = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(child)
        child.communicate()
        return TIMEOUT_LINE.format(seconds=format(timeout, "g"), count=repo_count(cwd), cwd=cwd)
    if child.returncode != 0:
        # The child's own diagnosis, kept whole where the debug log will have
        # it; the session gets one line, because a person reads that one.
        text = err.decode("utf-8", "replace")
        sys.stderr.write(text if text.endswith("\n") or not text else text + "\n")
        detail = last_line(text) or f"exit status {child.returncode}"
        return FAILED_LINE.format(detail=detail)
    return out.decode("utf-8", "replace")


def report_message(cwd):
    """The fan-out message, or None when the dry run said nothing actionable.

    A degraded run goes back through this same path rather than around it:
    "could not" is already the vocabulary `gh-sync.py` reports a lookup it could
    not make in, and the filter below already treats it as worth saying.
    """
    if not os.access(SYNC, os.R_OK):
        note("missing " + SYNC)
        return None
    report = run_sync(cwd)
    if report is None:
        return None
    if not any(marker in report for marker in ACTIONABLE):
        return None
    return REPORT_MESSAGE.format(report=report.rstrip("\n"))


def session_start():
    """The whole hook: pick the branch the payload's directory calls for, or stay quiet."""
    cwd = payload_cwd()
    if not cwd or not os.path.isdir(cwd):
        cwd = os.getcwd()
    if shutil.which("git") is None:
        # Both branches need git: the in-repo check cannot ask what branch this
        # is, and `gh-sync.py` refuses outright. Neither is worth a line of a
        # session's context, and both are worth one in the debug log.
        note("git is not on PATH")
        return
    if git(cwd, "rev-parse", "--show-toplevel") is not None:
        message = branch_message(cwd)
    else:
        message = report_message(cwd)
    if message:
        emit(message)


def silence_output():
    if streams is not None:  # pragma: no branch - only a broken checkout has none
        streams.silence_output()


def main(argv):
    if streams is not None:
        streams.bind_closed_streams()
        streams.use_utf8(sys.stdout)
        streams.use_utf8(sys.stderr)
        # stdin too: `report` reads a gh-sync report holding ✓, ✗ and ·, and
        # under a single-byte locale reading it strictly is a UnicodeDecodeError
        # rather than a decoded line. The payload path is guarded separately,
        # because a payload can be malformed for reasons a locale cannot fix.
        streams.use_utf8(sys.stdin)
    mode = argv[1] if len(argv) > 1 else ""
    try:
        if mode == "session-start":
            session_start()
        elif mode == "cwd":
            read_cwd()
        elif mode == "branch" and len(argv) == 4:
            emit(BRANCH_MESSAGE.format(current=argv[2], default=argv[3]))
        elif mode == "report":
            emit(REPORT_MESSAGE.format(report=sys.stdin.read().rstrip("\n")))
        else:
            sys.stderr.write(
                "usage: hook-io.py {session-start|cwd|branch <current> <default>|report}\n"
            )
            return 2
        # Forced now, while a closed pipe still lands in the handler below rather
        # than in the interpreter's shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except BrokenPipeError:
        # Claude Code stopped reading. Nothing here changes state, so there is no
        # work to carry on with; both descriptors go somewhere that always
        # accepts so the interpreter's own shutdown flush cannot resurface it.
        silence_output()
    return 0


if __name__ == "__main__":
    # The outermost guarantee: nothing that happens in here may be the reason a
    # session stops. Anything unforeseen leaves its traceback on stderr, where
    # Claude Code's debug log keeps it, and exits 0 all the same.
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except (KeyboardInterrupt, Exception):
        import traceback

        traceback.print_exc()
        sys.exit(0)
