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

A missing or unrecognised event prints nothing and exits 0. There is no usage
text: hooks.json is the only caller, and anything printed here would surface to
the user as output from a hook they never ran.

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
guardrail crashed is not mistaken for a run that had nothing to block, and it
prints the traceback to stderr, where Claude Code's debug log keeps it. The
`; exit 0` in hooks.json holds the same guarantee for the cases this file is
never reached in at all: no python3 on PATH, or an unreadable hooks directory.
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

    Called only from inside the try in `main`, so a plugin directory this cannot
    import out of costs the recording and nothing else: the tool call still goes
    through and the session does not stop. The traceback still reaches stderr,
    which is where the debug log picks it up.
    """
    scripts = os.path.join(os.path.dirname(HERE), "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from lib import run as run_lib

    return run_lib


def now():
    """The timestamp every event record carries, in the marker's own format."""
    return load_run_lib().now()


def report_failed_write(what, path, error):
    """One line to stderr for a record that did not reach disk, and then on.

    A hook cannot stop the session over a full disk. But it must not go quiet
    either: everything this plugin later says about a run is computed from what
    was written here, so a write that failed is a finding, or a whole report,
    that will never reach an issue. The debug log keeps a hook's stderr, which is
    the only place that is visible.
    """
    sys.stderr.write(f"field-test: could not record {what} in {path}: {error}\n")


def append(path, record):
    """Append one event to the run's events file, saying so on stderr if it cannot."""
    ok, error = load_run_lib().append_event(path, record)
    if not ok:
        report_failed_write(record.get("event"), os.path.join(path, "events.jsonl"), error)


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

    A list that cannot be read at all is the same failure as a rule that will not
    compile, only total, and it comes back the same way: one broken entry naming
    the file and the error. Returning an empty list instead would switch the
    guardrail off for the whole run and say nothing, and a run that blocked
    nothing because it had no rules is indistinguishable from a run whose target
    never reached for anything.
    """
    rules = []
    broken = []
    comment = []
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError as error:
        return rules, [{"pattern": None, "line": 0, "error": f"{path}: {error}"}]
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
    # A Bash call with no command at all is nothing to match against and nothing
    # to say: an empty command runs nothing either.
    if command is None or command == "":
        return
    # A command that is some other type would reach re.search and raise, and an
    # exception here is the deny list switched off for the rest of the call. It is
    # not silently allowed, though: nothing was matched, so nothing can be said
    # about whether the guardrail would have refused it, and that is the finding.
    if not isinstance(command, str):
        record = base_record("hook_error", payload)
        record.update(
            {
                "hook": "PreToolUse",
                "error": (
                    f"tool_input.command is {type(command).__name__}, "
                    "not a string; nothing was matched"
                ),
            }
        )
        append(path, record)
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


def reconfigure_streams():
    """UTF-8 out, replacing what will not encode, on the streams that allow it.

    A deny reason carries the target's own command, which can hold anything. Under
    a non-UTF-8 locale writing it would raise UnicodeEncodeError, and a decision
    this could not print is a command Claude Code allows. Inlined rather than
    shared with the scripts under scripts/lib/: a hook runs on every tool call and
    must not depend on an import to be able to speak at all.

    A stream that is None gets a devnull one instead: Python leaves it None when
    it starts with the descriptor closed, and a hook that raised AttributeError on
    its first write would record nothing at all for that call.

    Guarded otherwise because `reconfigure` needs a text stream that is still
    open: a caller that replaced sys.stdout with something else has neither the
    method nor the encoding problem.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if stream is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            continue


def main(argv):
    reconfigure_streams()
    # Silently, with no usage text: hooks.json is the only caller, and anything
    # this wrote would reach the user as output from a hook they did not run.
    event = argv[1] if len(argv) > 1 else ""
    if event not in EVENTS:
        return 0
    payload = read_payload()
    if payload is None:
        return 0
    # A crash in here is invisible from the outside: this exits 0, Claude Code
    # allows the command, and a run that lost its deny list looks exactly like a
    # run the target never reached for anything. Record it as an event so
    # collection can say the guardrail was off, then still exit 0.
    #
    # The import and the two marker calls are inside it too. They read files a
    # crashed write can have left in any state, and a marker that raises on the
    # way in is exactly the kind of failure worth a record.
    path = None
    try:
        run_lib = load_run_lib()
        path = run_lib.live_run_dir(payload.get("session_id"))
        if path is None:
            return 0
        # Reported for the same reason an unwritten event is. This is the only
        # place the transcript's location is ever learned, so a marker that did
        # not take it is what makes `ft-collect.py --report` say later that no
        # hook event carried one -- which would not be true.
        ok, error = run_lib.note_transcript(path, payload.get("transcript_path"))
        if not ok:
            report_failed_write("transcript_path", os.path.join(path, "run.json"), error)
        dispatch(event, payload, path)
        # Forced now, while a closed pipe still lands in the arm below rather
        # than in the interpreter's shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except BrokenPipeError:
        # Claude Code stopped reading the decision. Not this hook's failure, and
        # the interpreter must not resurface it as a trace from its own shutdown
        # flush either, so both descriptors go somewhere that always accepts.
        for stream in (sys.stdout, sys.stderr):
            try:
                fileno = stream.fileno()
            except (AttributeError, OSError, ValueError):
                continue
            devnull = os.open(os.devnull, os.O_WRONLY)
            try:
                os.dup2(devnull, fileno)
            finally:
                os.close(devnull)
        return 0
    except Exception:
        if path is None:
            # Nothing was learned about where this run records anything, so there
            # is nowhere to write the record. The outermost guard below prints the
            # traceback, which is the only place this failure can still be seen.
            raise
        record = base_record("hook_error", payload)
        record.update({"hook": event, "error": traceback.format_exc()[-STDERR_TAIL_CHARS:]})
        append(path, record)
    return 0


if __name__ == "__main__":
    # The outermost guarantee: nothing that happens in here, including failing to
    # import this plugin's own library, may be the reason a session stops. The
    # `; exit 0` in hooks.json is the same guarantee one level out, for the cases
    # this file never reaches at all -- no python3 on PATH, or a hooks/ directory
    # it was not installed into.
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except (KeyboardInterrupt, Exception):
        # The two arms spelled out rather than BaseException, which also swallows
        # GeneratorExit and anything else the interpreter uses to unwind. A hook
        # interrupted with the session it runs in is not a hook that failed, and
        # it must not be the reason that session stops either, so both land here.
        #
        # To stderr before exiting 0. Claude Code's debug log keeps a hook's
        # stderr, so this is the one place a failure that recorded nothing --
        # a broken lib/run.py, most of all -- can still be diagnosed. Exiting
        # 0 quietly would leave nothing anywhere.
        traceback.print_exc()
        sys.exit(0)
