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
        with open(path) as handle:
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
    """Write `document` to `path` atomically. Raises OSError if it cannot."""
    tmp = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def note_transcript(path: str, transcript) -> None:
    """Record the transcript path on the marker the first time a hook reports one.

    Collection needs the transcript and only the hooks are told where it is.
    """
    if not transcript:
        return
    marker_path = os.path.join(path, "run.json")
    marker = load_marker(marker_path)
    if marker is None or marker.get("transcript_path"):
        return
    marker["transcript_path"] = transcript
    try:
        write_json(marker_path, marker)
    except OSError:
        return


def append_event(path: str, record) -> None:
    """Append one event record to the run's events file, or give up quietly."""
    try:
        with open(os.path.join(path, "events.jsonl"), "a") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        return
