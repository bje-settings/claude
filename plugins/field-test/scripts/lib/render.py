"""One finding rendered into the issue template.

The output's first line is the issue title and the rest is the body, so the
whole thing is one stream of text that redaction can be applied to in one pass;
splitting title from body would mean redacting twice and give a second place for
a name to survive.

The per-kind text is here rather than in the template because it is a decision:
what a reader should have expected, and what state a fixture has to reproduce,
differ by finding. `test:` is used instead of `fix:` for a finding that says a
check is missing rather than that something failed.
"""

from __future__ import annotations

SUMMARY_CHARS = 70
CLAIM_CHARS = 400

EXPECTED = {
    "denied": "the target not to reach for a command that cannot be undone",
    "tool_failure": "the tool call to complete, or the target to handle the failure and say so",
    "bash_nonzero": "the command to exit 0, or the target to stop and report the non-zero exit",
    "subagent_contradiction": (
        "a subagent that hit a failure it never resolved to report that failure"
    ),
    "deny_list_error": "every rule in the deny list to be in force for the whole run",
    "hook_error": "the field-test hooks to record every tool call and filter every Bash call",
    "args_dropped": "every option given to the target to reach the commands it runs",
}
EXPECTED_DEFAULT = "the target to complete the step without this"

ACTUAL = {
    "denied": "the field-test hook blocked it, and the run continued without it",
    "tool_failure": "the tool call failed and the run continued",
    "bash_nonzero": "the command exited non-zero and the run continued",
    "deny_list_error": (
        "the rule did not compile, so it blocked nothing and nothing it names was refused"
    ),
    "hook_error": "the hook raised and the tool call went through unrecorded and unfiltered",
    "args_dropped": "the option never appeared in any command the target ran",
}
ACTUAL_DEFAULT = "see the output below"

FIXTURE = {
    "denied": (
        "A repository where the target reaches this step, plus a spec asserting the deny "
        "list still matches this command and still allows the benign form of it."
    ),
    "args_dropped": (
        "A spec that runs the target with this option and asserts it reaches the command "
        "the target builds."
    ),
    "subagent_contradiction": (
        "A canned subagent result whose text claims success beside recorded events holding "
        "an unresolved failure, asserted to produce this finding."
    ),
    "deny_list_error": (
        "A deny list holding this pattern, asserted to leave the remaining rules in force "
        "and to record the rule it lost."
    ),
    "hook_error": (
        "The payload that made the hook raise, asserted to leave the session running and to "
        "record the call the hook could not handle."
    ),
}
FIXTURE_DEFAULT = (
    "A repository in the state the commands above left it in, built by the fixtures rather "
    "than mocked, plus a spec asserting the target's behaviour from that state."
)


def actual_of(kind: str, evidence) -> str:
    if kind == "subagent_contradiction":
        claim = evidence.get("claim") or ""
        return "the subagent's last message reported success: " + claim[:CLAIM_CHARS]
    return ACTUAL.get(kind, ACTUAL_DEFAULT)


def summary_of(signature: str) -> str:
    """The signature without its kind prefix, which is what the title says.

    One leading space removed, not every one: this was jq's `ltrimstr(" ")`, which
    strips a single prefix. A signature written with two spaces after the colon
    kept the second, and a title is compared against the ones already filed.
    """
    text = ":".join((signature or "").split(":")[1:])
    if text.startswith(" "):
        text = text[1:]
    return text[:SUMMARY_CHARS]


def preceding_of(preceding) -> str:
    if not preceding:
        return "Nothing was recorded before it."
    return "\n".join("1. `" + (command or "").split("\n")[0] + "`" for command in preceding)


def default(value, fallback):
    """jq's `//`: the fallback only for null, never for an empty string.

    Not Python's `or`, which also fires on "". The difference is visible in an
    issue: a finding recorded with `"command": ""` rendered as an empty Steps
    section under the shell, and rendering "(no single command...)" there instead
    would have the issue assert something about the run that is not true. Every
    one of these fields was a `//` in render.jq, and each is a claim about what
    was recorded.
    """
    return fallback if value is None else value


def fields(record, run):
    """Every template substitution for one finding, in the order they are applied."""
    kind = record.get("kind")
    evidence = record.get("evidence") or {}
    resolved = run.get("resolved") or {}
    if not isinstance(resolved, dict):
        resolved = {}
    stderr = evidence.get("stderr") or ""
    exit_code = evidence.get("exit_code")
    args = run.get("args") or []
    return [
        ("type", "test" if kind == "args_dropped" else "fix"),
        ("target", default(run.get("target"), "unknown")),
        ("summary", summary_of(record.get("signature") or "")),
        (
            "reason",
            # "A " + null + " finding..." in jq is "A  finding...": adding null to
            # a string yields the string, so an unnamed kind left two spaces, not
            # the word "None".
            default(
                evidence.get("reason"),
                "A " + ("" if kind is None else str(kind)) + " finding recorded during the run.",
            ),
        ),
        ("expected", EXPECTED.get(kind, EXPECTED_DEFAULT)),
        ("actual", actual_of(kind, evidence)),
        (
            "command",
            default(
                evidence.get("command"),
                "(no single command; the finding is about the run as a whole)",
            ),
        ),
        # stderr and claude_version were an explicit `== ""` test in render.jq,
        # not a `//`, so an empty string does take the fallback for these two.
        ("stderr", stderr if stderr else "(no output recorded)"),
        ("exit_code", "not recorded" if exit_code is None else str(exit_code)),
        ("preceding", preceding_of(evidence.get("preceding") or [])),
        ("args", " ".join(args) if args else "(none)"),
        ("repo", default(run.get("cwd"), "unknown")),
        ("plugin", default(default(resolved.get("plugin"), run.get("target")), "unknown")),
        ("version", default(resolved.get("version"), "version unknown")),
        ("commit", default(resolved.get("commit"), "not a local checkout")),
        ("claude_version", run.get("claude_version") or "not recorded"),
        ("kind", kind),
        ("severity", default(record.get("severity"), "medium")),
        ("count", str(record.get("count") if record.get("count") is not None else 1)),
        ("signature", record.get("signature") or ""),
        ("fixture", FIXTURE.get(kind, FIXTURE_DEFAULT)),
    ]


def render(template: str, record, run) -> str:
    """The template with every `{{key}}` replaced by this finding's text."""
    text = template
    for key, value in fields(record, run):
        text = text.replace("{{" + key + "}}", value if value is not None else "")
    return text
