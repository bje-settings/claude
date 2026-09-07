"""The recorded events of one field test, reduced to candidate problems.

`findings(run, events)` returns an array of finding records, highest severity
first:

    {kind, severity, signature, agent_id, agent_type, evidence, count}

A record is a *candidate*. Deciding which candidates are real problems and
which are the target working correctly is the skill's job, not this module's:
the rule for telling them apart is not mechanical, and guessing here would
either hide a bug or file a false one.

`signature` is what dedupe is done on, here and against already-open issues, so
it is normalised: first line only, whitespace collapsed, every run of digits
replaced by N, truncated. Two runs of the same bug on different PR numbers must
produce the same signature.

One function per kind of finding, so a branch that stops firing fails a test of
its own rather than disappearing into a filter nobody can see inside.
"""

from __future__ import annotations

import json
import re

SIGNATURE_CHARS = 80
PRECEDING = 3

RANKS = {"high": 0, "medium": 1, "low": 2}

# An explicit failed or paused status is taken at its word; any other structured
# status reports an outcome and is read as success.
STATUS_FAILED = re.compile(r'"status"\s*:\s*"(failed|paused)"')
STATUS_ANY = re.compile(r'"status"\s*:\s*"')
SUCCESS_WORDS = re.compile(
    r"\b(merged|done|passed|succeeded|success|complete|completed|clean)\b", re.IGNORECASE
)


def norm(text) -> str:
    """The signature form of a command: first line, collapsed, digits to N.

    A command that was never recorded normalises to the empty string rather
    than raising, which would lose every other finding in the run.
    """
    first = (text or "").split("\n")
    first = first[0] if first else ""
    collapsed = re.sub(r"\s+", " ", first)
    return re.sub(r"[0-9]+", "N", collapsed)[:SIGNATURE_CHARS]


def rank(severity) -> int:
    return RANKS.get(severity, 3)


def preceding(events, index):
    """The few commands before `index`, which is what makes a failure reproducible.

    An exit code on its own rarely says what put the repository into that
    state. Command-bearing events are filtered first and the last three taken
    from those: a raw slice of the last three events would let a command-less
    record, such as a Stop that now lands at every turn boundary, occupy one of
    the three slots and displace a real command from the trail.
    """
    commands = [
        event.get("command") for event in events[:index] if event.get("command") not in (None, "")
    ]
    return commands[-PRECEDING:]


def failed_event(event) -> bool:
    if event.get("event") in ("PostToolUseFailure", "denied"):
        return True
    code = event.get("exit_code")
    return code is not None and code != 0


def unresolved(events, agent):
    """This subagent's failures that were never followed by the same command succeeding.

    A worker that retried and got through is not contradicting itself, so only
    the unresolved ones can contradict a claim of success.
    """
    out = []
    for index, event in enumerate(events):
        if event.get("agent_id") is None or event.get("agent_id") != agent:
            continue
        if not failed_event(event):
            continue
        command = event.get("command")
        resolved = any(
            later.get("agent_id") == agent
            and later.get("command") is not None
            and later.get("command") == command
            and later.get("exit_code") == 0
            for later in events[index + 1 :]
        )
        if not resolved:
            out.append(event)
    return out


def claims_success(message) -> bool:
    """A subagent's last message read as a claim."""
    text = message or ""
    if STATUS_FAILED.search(text):
        return False
    if STATUS_ANY.search(text):
        return True
    return bool(SUCCESS_WORDS.search(text))


def _finding(kind, severity, signature, event, evidence):
    return {
        "kind": kind,
        "severity": severity,
        "signature": signature,
        "agent_id": event.get("agent_id"),
        "agent_type": event.get("agent_type"),
        "evidence": evidence,
    }


def denied_findings(events):
    out = []
    for index, event in enumerate(events):
        if event.get("event") != "denied":
            continue
        out.append(
            _finding(
                "denied",
                "high",
                "denied:" + norm(event.get("command")),
                event,
                {
                    "command": event.get("command"),
                    "reason": event.get("reason"),
                    "exit_code": None,
                    "stderr": "",
                    "preceding": preceding(events, index),
                },
            )
        )
    return out


def deny_list_error_findings(events):
    """A deny-list rule that did not compile.

    A finding about the field test itself rather than about the target: the
    rule blocked nothing all run, so the absence of a `denied` record for it
    proves nothing either way.
    """
    out = []
    for event in events:
        if event.get("event") != "deny_list_error":
            continue
        out.append(
            _finding(
                "deny_list_error",
                "high",
                "deny_list_error:" + norm(event.get("pattern")),
                event,
                {
                    "command": None,
                    "reason": (
                        "a deny-list rule did not compile and blocked nothing all run: "
                        + (event.get("error") or "no reason recorded")
                    ),
                    "exit_code": None,
                    "stderr": "",
                    "pattern": event.get("pattern") or "",
                    "line": event.get("line"),
                    "deny_list": event.get("deny_list") or "",
                    "preceding": [],
                },
            )
        )
    return out


def hook_error_findings(events):
    """A hook that raised.

    The hook still exits 0, so the tool call went through unexamined and, for a
    PreToolUse, unfiltered: the guardrail was off for that call and nothing else
    in the run would say so.
    """
    out = []
    for event in events:
        if event.get("event") != "hook_error":
            continue
        error = event.get("error") or ""
        last_line = error.split("\n")[-1] if error else ""
        hook = event.get("hook") or ""
        out.append(
            _finding(
                "hook_error",
                "high",
                norm("hook_error:" + hook + ":" + last_line),
                event,
                {
                    "command": None,
                    "reason": (
                        "the "
                        + (event.get("hook") or "unknown")
                        + " hook raised, so that tool call was neither recorded nor filtered"
                    ),
                    "exit_code": None,
                    "stderr": error,
                    "preceding": [],
                },
            )
        )
    return out


def tool_failure_findings(events):
    out = []
    for index, event in enumerate(events):
        if event.get("event") != "PostToolUseFailure":
            continue
        out.append(
            _finding(
                "tool_failure",
                "medium",
                "tool_failure:" + norm(event.get("command")),
                event,
                {
                    "command": event.get("command"),
                    "reason": None,
                    "exit_code": event.get("exit_code"),
                    "stderr": event.get("stderr_tail") or "",
                    "preceding": preceding(events, index),
                },
            )
        )
    return out


def nonzero_findings(events):
    out = []
    for index, event in enumerate(events):
        if event.get("event") != "PostToolUse":
            continue
        code = event.get("exit_code")
        if code is None or code == 0:
            continue
        out.append(
            _finding(
                "bash_nonzero",
                "medium",
                "bash_nonzero:" + norm(event.get("command")),
                event,
                {
                    "command": event.get("command"),
                    "reason": None,
                    "exit_code": code,
                    "stderr": event.get("stderr_tail") or "",
                    "preceding": preceding(events, index),
                },
            )
        )
    return out


def contradiction_findings(events):
    out = []
    for stop in events:
        if stop.get("event") != "SubagentStop":
            continue
        if not claims_success(stop.get("last_assistant_message")):
            continue
        bad = unresolved(events, stop.get("agent_id"))
        if not bad:
            continue
        agent_type = stop.get("agent_type") or "subagent"
        out.append(
            _finding(
                "subagent_contradiction",
                "high",
                "subagent_contradiction:" + norm(agent_type + ":" + (bad[0].get("command") or "")),
                stop,
                {
                    "command": bad[0].get("command"),
                    "reason": "reported success after a failure it never resolved",
                    "exit_code": bad[0].get("exit_code"),
                    "stderr": bad[0].get("stderr_tail") or "",
                    "claim": stop.get("last_assistant_message") or "",
                    "unresolved": [event.get("command") for event in bad],
                    "preceding": [],
                },
            )
        )
    return out


def args_dropped_findings(run, events):
    """An option handed to the target that never reached any command it ran.

    Only options are checked: a bare word may legitimately be consumed by the
    skill rather than passed through.
    """
    out = []
    for argument in run.get("args") or []:
        if not isinstance(argument, str) or not argument.startswith("-"):
            continue
        used = any(
            event.get("command") is not None and argument in event.get("command")
            for event in events
        )
        if used:
            continue
        out.append(
            {
                "kind": "args_dropped",
                "severity": "low",
                "signature": "args_dropped:" + argument,
                "agent_id": None,
                "agent_type": None,
                "evidence": {
                    "command": None,
                    "reason": (
                        "argument " + argument + " never appeared in any command the target ran"
                    ),
                    "exit_code": None,
                    "stderr": "",
                    "argument": argument,
                    "preceding": [],
                },
            }
        )
    return out


def findings(run, events):
    """Every candidate finding in one run, deduped by signature, worst first."""
    raw = (
        denied_findings(events)
        + deny_list_error_findings(events)
        + hook_error_findings(events)
        + tool_failure_findings(events)
        + nonzero_findings(events)
        + contradiction_findings(events)
        + args_dropped_findings(run, events)
    )
    grouped = {}
    for record in raw:
        grouped.setdefault(record["signature"], []).append(record)
    collapsed = []
    for signature in sorted(grouped):
        group = grouped[signature]
        first = dict(group[0])
        first["count"] = len(group)
        collapsed.append(first)
    return sorted(collapsed, key=lambda record: (rank(record["severity"]), record["signature"]))


def last_assistant_text(transcript: str) -> str:
    """The last assistant turn of a transcript that carried text of its own.

    The transcript is JSON lines and may be read while it is still being
    written, so a line that does not parse is skipped rather than failing the
    whole read. The last turn *with text*, not simply the last turn: a real
    transcript often ends on a turn holding only thinking and tool_use blocks,
    and the empty string that would print is indistinguishable from a target
    that said nothing, which is the one thing this output exists to show.
    """
    latest = ""
    for line in transcript.split("\n"):
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("type") != "assistant":
            continue
        message = record.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            content = []
        text = "\n".join(
            block.get("text") or ""
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if text:
            latest = text
    return latest
