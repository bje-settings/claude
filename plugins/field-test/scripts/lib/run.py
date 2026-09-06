"""The run marker: where it lives, how it is read, and how it is written.

Shared by `ft-run.py`, which creates and finishes the marker, and by
`hooks/hook-io.py`, which has to answer one question on every tool call in
every session: is this session a field test? Both need the same answer to
"where does this session's run directory live", and two copies of that rule
would be two chances for the hooks to write beside the directory collection
reads.

Every write goes to a temp file and is moved into place, so a crash mid-write
cannot leave a half-written marker that neither starts nor finishes a run.
"""

from __future__ import annotations

import datetime
import json
import os


def now() -> str:
    """The timestamp format the marker and every event record use."""
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def state_dir(environ=None) -> str:
    """Where runs/ lives: FT_STATE_DIR, then CLAUDE_PLUGIN_DATA, else empty."""
    environ = os.environ if environ is None else environ
    return environ.get("FT_STATE_DIR") or environ.get("CLAUDE_PLUGIN_DATA") or ""


def run_dir(state: str, session: str) -> str:
    return os.path.join(state, "runs", session)


def load_marker(path: str):
    """The marker as a dict, or None when it is missing or not readable JSON."""
    try:
        with open(path, encoding="utf-8") as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        return None
    return marker if isinstance(marker, dict) else None


def live_run_dir(session_id: str, environ=None):
    """The run directory for a live field test in this session, else None.

    A marker that is missing, unreadable, not an object, or already finished is
    not a live run: the hooks record nothing, which is every session that is not
    a field test.
    """
    state = state_dir(environ)
    if not state or not session_id:
        return None
    path = run_dir(state, session_id)
    marker = load_marker(os.path.join(path, "run.json"))
    if marker is None or marker.get("finished_at") is not None:
        return None
    return path


def write_json(path: str, document) -> None:
    """Write `document` to `path` atomically. Raises OSError or ValueError if it cannot.

    Written the way the hook on `main` wrote it, with neither an indent nor
    `ensure_ascii=False`: the marker is a file two programs exchange, not one a
    person reads, and `ft-run.py show` pretty-prints it for the one caller that
    does. `ensure_ascii=True` is also jq's own output, so these are the bytes the
    shell wrote, and it is what keeps the write from failing on content: a lone
    surrogate reaching a UTF-8 encoder raises, and escaped it is just six ASCII
    characters.

    ValueError is left to the caller alongside OSError because both mean the same
    thing here -- the document did not reach the file, so a marker says the run is
    in a state it is not -- and the temp file must not be left behind either way.
    """
    tmp = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(document, handle)
            handle.write("\n")
        os.replace(tmp, path)
    except (OSError, ValueError):
        try:
            os.unlink(tmp)
        except OSError:
            # Best effort, and deliberately silent: the caller is about to be
            # handed the original failure, which is the one worth reporting. A
            # temp file that cannot be removed is usually the same unwritable
            # directory that caused it, and raising here would replace the real
            # error with the cleanup's.
            pass
        raise


def note_transcript(path: str, transcript) -> tuple[bool, str]:
    """Record the transcript path on the marker the first time a hook reports one.

    (False, why) when there was one to record and it could not be written.
    Collection needs the transcript and only the hooks are ever told where it is,
    so a write that failed here is the reason `ft-collect.py --report` later says
    no hook event carried a transcript_path. Left silent, that message is simply
    untrue, and it is the one output whose whole job is telling "the target said
    nothing" apart from "this could not find out".

    Nothing to record, and a marker already carrying one, are both successes:
    only the first hook to see a transcript writes it.
    """
    if not transcript:
        return True, ""
    marker_path = os.path.join(path, "run.json")
    marker = load_marker(marker_path)
    if marker is None or marker.get("transcript_path"):
        return True, ""
    marker["transcript_path"] = transcript
    try:
        write_json(marker_path, marker)
    except (OSError, ValueError) as error:
        return False, str(error)
    return True, ""


def append_event(path: str, record) -> tuple[bool, str]:
    """Append one event record to the run's events file. (False, why) if it could not.

    `ensure_ascii=True`, as jq wrote it: the events file is read back by
    ft-collect.py and ft-issue.py, so the bytes are a contract. It also keeps a
    record holding a lone surrogate -- which a tool_response can -- from raising
    on the way to a UTF-8 file, since escaped it is only ASCII. ValueError is
    caught beside OSError for what escaping cannot help with, a record that does
    not serialise at all.

    Reported rather than raised, because the caller is a hook and a full disk
    must not stop a session. Reported rather than swallowed, because an event
    that was never recorded is a finding that never reaches an issue. The reason
    comes back with the status so the caller can say which of the two happened
    instead of only that something did.
    """
    try:
        with open(os.path.join(path, "events.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
    except (OSError, ValueError) as error:
        return False, str(error)
    return True, ""
