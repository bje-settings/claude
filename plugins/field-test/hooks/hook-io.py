#!/usr/bin/env python3
"""The field-test hooks: hooks.json runs this file directly for every event.

Everything a hook does is JSON: reading the payload Claude Code sends on stdin,
appending one event record per tool call, and writing the PreToolUse decision.
`jq` is not used in a hook at all, and nothing here is imported from outside
this plugin: a hook runs on every tool call, so it depends only on what a Mac
already has.

Where the run marker lives, and whether this session has a live one, is
`scripts/lib/run.py`: the hooks must look in exactly the directory ft-run.py
wrote to, and two copies of that rule would be two chances for them to disagree.

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

`Stop` fires at every turn boundary in the main session; see `handle_stop` below.

Always exits 0, whatever happens, including a plugin directory this cannot
import its own library out of: a hook that fails must not take the session down
with it. Short of that it records a `hook_error` event first, so a run whose
guardrail crashed is not mistaken for a run that had nothing to block.
"""

import json
import os
import re
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


def load_run_lib():
    """The plugin's own run-marker module, imported the first time it is needed.

    Inside the try in `main`, so a plugin directory this cannot import out of
    costs the recording and nothing else: the tool call still goes through and
    the session does not stop.
    """
    scripts = os.path.join(os.path.dirname(HERE), "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from lib import run as run_lib

    return run_lib


def now():
    """The timestamp every event record carries, in the marker's own format."""
    return load_run_lib().now()


def append(path, record):
    """Append one event to the run's events file, or give up quietly."""
    load_run_lib().append_event(path, record)


def read_payload():
    """The hook payload, or None when stdin holds anything else."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, AttributeError):
        return None
    return payload if isinstance(payload, dict) else None


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
    """Record the turn boundary. This does not finish the run.

    `Stop` fires at every turn boundary in the main session, not only at the end
    of the field test: a target that pauses for the user or schedules a wake ends
    its turn on purpose, and `Stop` fires anyway. Finishing here would mark the
    run done mid-test, so every later hook would see a finished marker and go
    silent for the rest of the run. Finishing is the run skill's own Step 4
    action; this hook only records that the turn ended, with the target's last
    message, so the events file carries the target's own claim beside the calls
    it made. No finding reads that field; `ft-collect.py --report` reads the
    transcript instead. `ft-issue.py names` does scan it, with every other
    event field, for the `#N` references redaction has to catch.
    """
    record = base_record("Stop", payload)
    record["last_assistant_message"] = payload.get("last_assistant_message") or ""
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
        sys.stderr.write("usage: hook-io.py {{{}}}\n".format("|".join(EVENTS)))
        return 0
    payload = read_payload()
    if payload is None:
        return 0
    run_lib = load_run_lib()
    path = run_lib.live_run_dir(payload.get("session_id"))
    if path is None:
        return 0
    run_lib.note_transcript(path, payload.get("transcript_path"))
    # A crash here is invisible from the outside: this exits 0, Claude Code allows
    # the command, and a run that lost its deny list looks exactly like a run the
    # target never reached for anything. Record it as an event so collection can
    # say the guardrail was off, then still exit 0.
    try:
        dispatch(event, payload, path)
    except Exception:
        record = base_record("hook_error", payload)
        record.update({"hook": event, "error": traceback.format_exc()[-STDERR_TAIL_CHARS:]})
        append(path, record)
    return 0


if __name__ == "__main__":
    # The outermost guarantee, and the reason hooks.json needs no shell wrapper:
    # nothing that happens in here, including failing to import this plugin's own
    # library, may be the reason a session stops.
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - a hook never fails the session
        sys.exit(0)
