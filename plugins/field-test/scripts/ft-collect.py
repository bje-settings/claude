#!/usr/bin/env python3
"""ft-collect.py: turn one field test's recorded events into candidate problems.

  ft-collect.py <run-dir>              the findings, as a JSON array
  ft-collect.py <run-dir> --report     the target's final message, as text

The run directory is what ft-run.py created and the hooks appended to. The
decision logic is in lib/collect.py, one function per kind of finding, each with
a test of its own.

--report prints the last assistant message from the session transcript the hooks
recorded on the marker. That is the target's own account of what it did, which is
the thing worth checking against GitHub rather than trusting.

Exit 0 with the array (possibly empty), 1 on a broken run directory, 2 on usage.

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import collect  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-collect.py"


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def load_marker(path: str):
    if not os.path.isfile(path):
        die(f"no run marker at {path}")
    try:
        with open(path) as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        die(f"run marker is not valid JSON: {path}")
    if not isinstance(marker, dict):
        die(f"run marker is not valid JSON: {path}")
    return marker


def load_events(path: str):
    """The events file as a list, or nothing at all when no hook ever wrote one."""
    if not os.path.isfile(path):
        return []
    try:
        with open(path) as handle:
            text = handle.read()
    except OSError:
        die(f"events file is not valid JSON lines: {path}")
    events = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            die(f"events file is not valid JSON lines: {path}")
    return events


def report(marker):
    """The target's own last message, or a refusal saying why there is none.

    Every way this can fail prints nothing, and nothing is also what a target
    that said nothing prints. Telling those two apart is the whole point of this
    output, so each failure is named instead.
    """
    transcript = marker.get("transcript_path") or ""
    if not transcript:
        die("the run marker has no transcript_path; no hook event carried one")
    if not os.path.isfile(transcript):
        die(f"no transcript at {transcript}")
    try:
        with open(transcript, errors="replace") as handle:
            text = handle.read()
    except OSError:
        die(f"could not read the transcript at {transcript}")
    sys.stdout.write(collect.last_assistant_text(text) + "\n")


def run(argv):
    first = argv[1] if len(argv) > 1 else ""
    if first in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if first == "":
        sys.stderr.write(__doc__)
        return 2

    run_dir = first
    mode = argv[2] if len(argv) > 2 else ""
    if mode not in ("", "--report"):
        die(f"unknown argument: {mode}", 2)

    marker = load_marker(os.path.join(run_dir, "run.json"))
    if mode == "--report":
        report(marker)
        return 0

    events = load_events(os.path.join(run_dir, "events.jsonl"))
    sys.stdout.write(
        json.dumps(collect.findings(marker, events), indent=2, ensure_ascii=False) + "\n"
    )
    return 0


def main(argv):
    try:
        return run(argv)
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
