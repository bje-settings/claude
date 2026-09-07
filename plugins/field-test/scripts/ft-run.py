#!/usr/bin/env python3
"""ft-run.py: the field-test run marker for one Claude Code session.

  ft-run.py start <target> [--resolved <file>] [--cwd <dir>] [--] [arg...]
  ft-run.py finish
  ft-run.py show
  ft-run.py dir

The marker is what tells this plugin's hooks that the session is a field test.
It lives at
  ${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/runs/<session-id>/run.json
beside the events.jsonl the hooks append to. Those two files are the whole of
the run side's state -- the harden side keeps its own -- and nothing is cached;
the only other files in the run directory are the ones a run writes there for
itself (resolved.json, names.json).

The session id comes from --session, then $CLAUDE_CODE_SESSION_ID, which the
Bash tool exports and which matches the session_id hooks receive on stdin.

`--resolved` takes the JSON ft-resolve.py printed for the target, so the marker
records which plugin, version, and commit was under test. Without it those
fields are null: the marker still works, the issues it feeds are just vaguer.

Exit 0 on success, 1 on failure, 2 on usage or a missing session or state dir,
3 when a run is already active for this session.

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli  # noqa: E402  (needs HERE on sys.path first)
from lib import run as run_lib  # noqa: E402

PROG = "ft-run.py"
MARKER_VERSION = 1


class Failure(Exception):
    """Anything this script refuses to do: the message, and the status to exit with."""

    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def split_session(argv):
    """(session, remaining arguments), with everything after `--` left alone.

    The session flag is global: the skill lets the environment supply the id, and
    --session exists for a caller with the id in hand, today only the tests.
    Everything from `--` on belongs to the target, including a --session of its
    own. Scanning past it would send the marker to a directory no hook looks in.
    """
    session = ""
    rest = []
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--session":
            value = argv[index + 1] if index + 1 < len(argv) else ""
            if not value or value.startswith("-"):
                die("--session needs a value", 2)
            session = value
            index += 2
            continue
        if argument == "--":
            rest.extend(argv[index:])
            break
        rest.append(argument)
        index += 1
    return session, rest


def valid_marker(path: str):
    """Whatever the marker file parses to, or a refusal naming it.

    A marker that is not JSON is a crashed write, not a live run. Saying so is
    the difference between a user deleting one file and a session that can
    neither start nor finish a run.

    Deliberately not `run_lib.load_marker`, which folds "not JSON" and "JSON, but
    not an object" into the same None. Here they are different answers: the shell
    checked the file parsed and then indexed it, so a marker holding `[]` passed
    the first test and failed the second, and `start` refused it as a run already
    in progress rather than as a corrupt file. That status is documented, and the
    run skill branches on it.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        die(f"the run marker at {path} is not valid JSON; delete it and start again")


def require_marker(path: str, session: str):
    if not os.path.isfile(path):
        die(f"no field test is running for session {session}")
    marker = valid_marker(path)
    if not isinstance(marker, dict):
        die(f"the run marker at {path} is not an object; delete it and start again")
    return marker


def claude_version() -> str:
    """What `claude --version` says, or nothing.

    An issue body has to say which build produced the behaviour; a missing
    claude is not worth failing a run over.
    """
    try:
        finished = subprocess.run(
            ["claude", "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return ""
    # Whatever the exit status was. The shell ran `claude --version | head -1`,
    # so the status was head's and never claude's, and a build that prints its
    # version and exits non-zero still had its version recorded. Keeping that
    # matters more than it looks: the field this fills is how an issue says which
    # build produced the behaviour.
    output = finished.stdout.decode("utf-8", "replace").split("\n")
    return output[0] if output else ""


def start_options(argv):
    """(resolved file, cwd, target arguments) from what follows the target."""
    resolved = ""
    run_cwd = os.getcwd()
    index = 0
    while index < len(argv):
        argument = argv[index]
        value = argv[index + 1] if index + 1 < len(argv) else ""
        if argument == "--resolved":
            if not value:
                die("--resolved needs a value", 2)
            resolved = value
            index += 2
        elif argument == "--cwd":
            if not value:
                die("--cwd needs a value", 2)
            run_cwd = value
            index += 2
        elif argument == "--":
            index += 1
            break
        elif argument.startswith("-"):
            die(f"start: unknown argument: {argument}", 2)
        else:
            break
    return resolved, run_cwd, argv[index:]


def cmd_start(argv, run_dir: str, marker_path: str, session: str):
    target = argv[0] if argv else ""
    if not target or target.startswith("-"):
        die("start needs a target", 2)
    resolved, run_cwd, args = start_options(argv[1:])

    # Everything that can refuse happens before events.jsonl is truncated, which
    # is the one destructive thing this script does: a live run must keep its
    # recorded events when a start over it is refused.
    if os.path.isfile(marker_path):
        marker = valid_marker(marker_path)
        # A marker that is not an object counts as unfinished. It is not this
        # command's job to decide the file is junk and overwrite it: the one
        # destructive thing `start` does is truncate events.jsonl, and 3 is the
        # status that tells the caller to run `finish` and look at the run
        # directory rather than losing what is recorded in it.
        if not isinstance(marker, dict) or marker.get("finished_at") is None:
            die(f"a field test is already running for session {session}; run finish first", 3)
    resolved_document = None
    if resolved:
        if not os.path.isfile(resolved):
            die(f"no such resolved file: {resolved}", 2)
        try:
            with open(resolved, encoding="utf-8") as handle:
                resolved_document = json.load(handle)
        except (OSError, ValueError):
            die(f"resolved file is not valid JSON: {resolved}")

    try:
        os.makedirs(run_dir, exist_ok=True)
    except OSError:
        die(f"cannot create {run_dir}")
    events = os.path.join(run_dir, "events.jsonl")
    try:
        with open(events, "w", encoding="utf-8"):
            pass
    except OSError:
        die(f"cannot create {events}")

    try:
        run_lib.write_json(
            marker_path,
            {
                "version": MARKER_VERSION,
                "session_id": session,
                "target": target,
                "args": args,
                "cwd": run_cwd,
                "resolved": resolved_document,
                "claude_version": claude_version(),
                "started_at": run_lib.now(),
                "finished_at": None,
            },
        )
    except OSError:
        die(f"cannot write {marker_path}")
    # write_out, not sys.stdout.write: the marker and events.jsonl are already on
    # disk by this point, and a reader that went away must not be the reason the
    # rest of this command is skipped.
    cli.write_out(marker_path + "\n")


def cmd_finish(marker_path: str, session: str):
    marker = require_marker(marker_path, session)
    if marker.get("finished_at") is None:
        marker["finished_at"] = run_lib.now()
    try:
        run_lib.write_json(marker_path, marker)
    except OSError:
        die(f"cannot write {marker_path}")


def cmd_show(marker_path: str, session: str):
    marker = require_marker(marker_path, session)
    cli.write_out(json.dumps(marker, indent=2, ensure_ascii=False) + "\n")


def run(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if command == "":
        sys.stderr.write(__doc__)
        return 2

    session, rest = split_session(argv[2:])
    state = run_lib.state_dir()
    if not state:
        die("set CLAUDE_PLUGIN_DATA (or FT_STATE_DIR) to locate the run marker", 2)
    session = session or os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
    if not session:
        die("no session id: pass --session or set CLAUDE_CODE_SESSION_ID", 2)

    run_dir = run_lib.run_dir(state, session)
    marker_path = os.path.join(run_dir, "run.json")

    if command == "dir":
        cli.write_out(run_dir + "\n")
    elif command == "start":
        cmd_start(rest, run_dir, marker_path, session)
    elif command == "finish":
        cmd_finish(marker_path, session)
    elif command == "show":
        cmd_show(marker_path, session)
    else:
        die(f"unknown command: {command}", 2)
    return 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather than
        # in the interpreter's own shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        # Only the flush above and the usage text can reach this: every line this
        # script prints as an answer goes through cli.write_out, which stops the
        # output and lets the work finish. By here there is no work left, so
        # losing stderr with it costs nothing.
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The docstring promises this script's own message, not a traceback. An
        # arm nobody anticipated still reports one line and exit 1, the way every
        # anticipated one does. The class name is there so an exception with an
        # empty message still names what happened instead of printing a bare colon.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
