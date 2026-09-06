#!/usr/bin/env python3
"""Input and output for the field-test hooks.

The hooks are a shell entry point, but everything they do is JSON: reading the
payload Claude Code sends on stdin, appending one event record per tool call,
and writing the PreToolUse decision. Doing that inline with `python3 -c` would
bury it in quoted heredocs where it could not be linted, tested, or read, and
`jq` is not used in a hook at all: a hook runs on every tool call, so it depends
only on what a Mac already has.

Usage:
  hook-io.py <event>            payload on stdin; event is one of
                                PreToolUse PostToolUse PostToolUseFailure
                                SubagentStop Stop

Nothing happens unless a field-test run marker exists for the payload's
session_id and is unfinished. That check is the first thing done and the common
case is a session that is not a field test, where this exits without touching
anything.

Environment:
  FT_STATE_DIR / CLAUDE_PLUGIN_DATA   where runs/<session>/ lives
  FT_DENY_LIST                        default: deny-list.txt beside this file
  FT_RUN_SH                           default: ../scripts/ft-run.sh

Always exits 0. A hook that fails must not take the session down with it, but it
records a `hook_error` event first, so a run whose guardrail crashed is not
mistaken for a run that had nothing to block.
"""

import datetime
import json
import os
import re
import subprocess
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
EVENTS = ("PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop")
STDERR_TAIL_CHARS = 2000
# The first line of a PostToolUseFailure `error` for a Bash call: "Exit code 1".
EXIT_CODE_RE = re.compile(r"\s*Exit code (\d+)", re.IGNORECASE)

DENY_REASON = (
    "Blocked by the field-test plugin: {reason}\n"
    "The command was recorded as a finding. A field test observes; it does not let the "
    "target take an action that cannot be undone. Re-run the command yourself if it is "
    "genuinely what you want."
)


def now():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def read_payload():
    """The hook payload, or None when stdin holds anything else."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, AttributeError):
        return None
    return payload if isinstance(payload, dict) else None


def run_dir_for(session_id):
    """The run directory for this session, or None when there is no live run."""
    state_dir = os.environ.get("FT_STATE_DIR") or os.environ.get("CLAUDE_PLUGIN_DATA")
    if not state_dir or not session_id:
        return None
    path = os.path.join(state_dir, "runs", session_id)
    try:
        with open(os.path.join(path, "run.json")) as handle:
            marker = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(marker, dict) or marker.get("finished_at") is not None:
        return None
    return path


def note_transcript(path, transcript):
    """Record the transcript path on the marker the first time a hook reports one.

    Collection needs the transcript and only the hooks are told where it is.
    """
    if not transcript:
        return
    marker_path = os.path.join(path, "run.json")
    try:
        with open(marker_path) as handle:
            marker = json.load(handle)
        if marker.get("transcript_path"):
            return
        marker["transcript_path"] = transcript
        tmp = marker_path + ".tmp.%d" % os.getpid()
        with open(tmp, "w") as handle:
            json.dump(marker, handle)
        os.replace(tmp, marker_path)
    except (OSError, ValueError):
        return


def append(path, record):
    try:
        with open(os.path.join(path, "events.jsonl"), "a") as handle:
            handle.write(json.dumps(record) + "\n")
    except OSError:
        return


def load_deny_list(path):
    """([(compiled regex, reason)], [broken rule]) from the deny list.

    The comment lines above a pattern are its reason, which is what the target
    is told when a command is blocked, so the list stays self-documenting.

    A pattern that does not compile is skipped rather than raised: a hook that
    fails is a session that stops. But it is not skipped silently. A dropped rule
    is a hole in the only thing this plugin stops, and a run that recorded nothing
    about it is indistinguishable from a run the target never tested that rule in,
    so each one comes back as a broken-rule entry for the caller to record.

    Every exception, not only re.error: a repetition count too large for the engine
    raises OverflowError, and one rule written that way must cost that rule rather
    than the whole list.
    """
    rules = []
    broken = []
    comment = []
    try:
        with open(path) as handle:
            lines = handle.read().splitlines()
    except OSError:
        return rules, broken
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped:
            comment = []
        elif stripped.startswith("#"):
            comment.append(stripped.lstrip("#").strip())
        else:
            try:
                rules.append((re.compile(stripped), " ".join(comment) or stripped))
            except Exception as error:  # noqa: BLE001 - one bad rule, not the list
                broken.append({"pattern": stripped, "line": number, "error": str(error)})
            comment = []
    return rules, broken


def exit_code_of(response, error=""):
    """The tool's exit code, whichever spelling the payload uses, else None.

    A PostToolUseFailure payload carries no `tool_response` at all: the failure
    arrives as a top-level `error` string whose first line is `Exit code N`, with
    the command's output after it. Read that too, or every tool_failure finding
    reaches the issue saying the exit code was not recorded.
    """
    if isinstance(response, dict):
        for key in ("exit_code", "exitCode", "returnCode", "code"):
            value = response.get(key)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
    match = EXIT_CODE_RE.match(error or "")
    return int(match.group(1)) if match else None


def error_text(payload):
    """The top-level `error` string of a PostToolUseFailure payload."""
    text = payload.get("error")
    if text is None:
        return ""
    return text if isinstance(text, str) else str(text)


def stderr_tail(response, error=""):
    if isinstance(response, dict):
        text = response.get("stderr") or ""
        if not isinstance(text, str):
            text = str(text)
    else:
        text = ""
    # `error` is the only output a failed call reports, so it stands in when there
    # is no tool_response to read a stderr out of.
    return (text or error)[-STDERR_TAIL_CHARS:]


def base_record(event, payload):
    return {
        "ts": now(),
        "event": event,
        "agent_id": payload.get("agent_id"),
        "agent_type": payload.get("agent_type"),
    }


def handle_bash(event, payload, path):
    if payload.get("tool_name") != "Bash":
        return
    tool_input = payload.get("tool_input") or {}
    response = payload.get("tool_response")
    error = error_text(payload)
    record = base_record(event, payload)
    record.update(
        {
            "tool_use_id": payload.get("tool_use_id"),
            "command": tool_input.get("command") if isinstance(tool_input, dict) else None,
            "exit_code": exit_code_of(response, error),
            "stderr_tail": stderr_tail(response, error),
        }
    )
    append(path, record)


def handle_pre_tool_use(payload, path):
    """Deny a command the deny list names, and record the attempt as a finding."""
    if payload.get("tool_name") != "Bash":
        return
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    # Not `if not command`: a command that is not a string reaches re.search and
    # raises, and an exception here is the deny list silently switched off for the
    # rest of the run. There is nothing to match against, so there is nothing to deny.
    if not isinstance(command, str) or not command:
        return
    deny_list = os.environ.get("FT_DENY_LIST") or os.path.join(HERE, "deny-list.txt")
    rules, broken = load_deny_list(deny_list)
    for rule in broken:
        record = base_record("deny_list_error", payload)
        record.update(rule)
        record["deny_list"] = deny_list
        append(path, record)
    for pattern, reason in rules:
        if not pattern.search(command):
            continue
        record = base_record("denied", payload)
        record.update({"command": command, "reason": reason, "pattern": pattern.pattern})
        append(path, record)
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": DENY_REASON.format(reason=reason),
                }
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return


def handle_subagent_stop(payload, path):
    record = base_record("SubagentStop", payload)
    record.update(
        {
            # The subagent's own transcript, not the main session's, which is what
            # the common transcript_path holds on this event.
            "transcript_path": payload.get("agent_transcript_path")
            or payload.get("transcript_path"),
            "last_assistant_message": payload.get("last_assistant_message") or "",
        }
    )
    append(path, record)


def handle_stop(payload, path):
    append(path, base_record("Stop", payload))
    run_sh = os.environ.get("FT_RUN_SH") or os.path.join(HERE, "..", "scripts", "ft-run.sh")
    try:
        finished = subprocess.run(
            ["bash", run_sh, "finish", "--session", payload.get("session_id") or ""],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        return
    if finished.returncode == 0:
        return
    # A marker that never gets its finished_at keeps every later hook recording into
    # a run nobody will collect, and the next start in this session is refused as one
    # already running. Nothing else in the run would say why.
    record = base_record("hook_error", payload)
    record.update(
        {
            "hook": "Stop",
            "error": "ft-run.sh finish exited %d: %s"
            % (
                finished.returncode,
                finished.stderr.decode("utf-8", "replace")[-STDERR_TAIL_CHARS:],
            ),
        }
    )
    append(path, record)


def dispatch(event, payload, path):
    if event == "PreToolUse":
        handle_pre_tool_use(payload, path)
    elif event in ("PostToolUse", "PostToolUseFailure"):
        handle_bash(event, payload, path)
    elif event == "SubagentStop":
        handle_subagent_stop(payload, path)
    else:
        handle_stop(payload, path)


def main(argv):
    event = argv[1] if len(argv) > 1 else ""
    if event not in EVENTS:
        sys.stderr.write("usage: hook-io.py {%s}\n" % "|".join(EVENTS))
        return 0
    payload = read_payload()
    if payload is None:
        return 0
    path = run_dir_for(payload.get("session_id"))
    if path is None:
        return 0
    note_transcript(path, payload.get("transcript_path"))
    # A crash here is invisible from the outside: the wrapper exits 0, Claude Code
    # allows the command, and a run that lost its deny list looks exactly like a run
    # the target never reached for anything. Record it as an event so collection can
    # say the guardrail was off, then still exit 0.
    try:
        dispatch(event, payload, path)
    except Exception:
        record = base_record("hook_error", payload)
        record.update({"hook": event, "error": traceback.format_exc()[-STDERR_TAIL_CHARS:]})
        append(path, record)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
