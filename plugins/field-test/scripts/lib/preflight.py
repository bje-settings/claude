"""What `ft-preflight.py` reports missing, and how it reads Claude's registry.

The jq the shell ran is here as plain functions: the `missing` list it built one
entry at a time, and the four arms it read the installed-plugins registry with.
Each arm is its own branch in the coverage report and its own unit test in
`tests/field-test/test_preflight.py`.

A plugin is present when the registry names it under any marketplace. Which
marketplace it came from is not this script's business: a fork of workstreams
under another name is still workstreams to the agents that dispatch it.
"""

from __future__ import annotations

import json

# The plugins `harden` dispatches work to. It reuses the workstreams worker and
# reviewer agents and the review loop they already own rather than growing its
# own, so both have to be installed before a round starts rather than halfway
# through a target with a fix already in flight.
REQUIRED = (
    ("workstreams", "/plugin install workstreams@bje"),
    ("pr-review-toolkit", "/plugin install pr-review-toolkit@claude-plugins-official"),
)

EXCERPT = 160


def excerpt(text: str) -> str:
    """A tool's own message on one line, short enough to sit in a JSON field."""
    return " ".join(text.split("\n"))[:EXCERPT]


def missing(identifier: str, hint: str, detail: str = "") -> dict:
    """One entry of the `missing` array. `detail` is the tool's own message."""
    entry = {"id": identifier, "hint": hint}
    if detail:
        entry["detail"] = detail
    return entry


def registry_findings(path: str, text):
    """What the installed-plugins registry says is missing.

    `text` is the file's contents, or None when there is no file. A registry
    that cannot be read is reported as itself rather than as two missing
    plugins: the fix is a different one, and telling someone to install two
    plugins they already have sends them the wrong way.
    """
    if text is None:
        return [missing(identifier, hint) for identifier, hint in REQUIRED]
    try:
        document = json.loads(text)
    except ValueError:
        return [missing("registry-unreadable", f"installed plugins file is not valid JSON: {path}")]
    if document is None or document is False:
        # What `jq -e .` reported as a failure rather than as a document, and
        # the shell named as invalid JSON on the strength of that exit code.
        return [missing("registry-unreadable", f"installed plugins file is not valid JSON: {path}")]
    if not isinstance(document, dict) or not isinstance(document.get("plugins"), dict):
        return [
            missing("registry-unreadable", f"installed plugins file has no plugins object: {path}")
        ]
    return [
        missing(identifier, hint)
        for identifier, hint in REQUIRED
        if not has_plugin(document, identifier)
    ]


def has_plugin(document, identifier: str) -> bool:
    """Whether the registry names the plugin under any marketplace at all."""
    prefix = identifier + "@"
    return any(
        isinstance(key, str) and key.startswith(prefix) for key in document["plugins"].keys()
    )


def report(entries):
    """The one object this script prints: what is missing, and whether that is none."""
    return {"ok": not entries, "missing": list(entries)}
