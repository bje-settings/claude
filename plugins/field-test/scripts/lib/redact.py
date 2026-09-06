"""Strip a repository's identity out of text bound for a public issue.

Matching is literal, never a regular expression: a branch or commit subject can
contain anything, and a pattern built from one would be a way to leak the very
name this exists to remove.

A short value is replaced only where it stands as a word. A repository called
`run` or `cm` is a real name that has to go, but replacing it everywhere
rewrites the prose around it ("running" becomes "<repo>ning") until the issue is
unreadable. The word test is on the characters either side, never on the value
itself, so no pattern is ever built out of a name.
"""

from __future__ import annotations

import json
import os
import re

# Below this length a value is replaced only where it stands as a word.
BOUNDED_BELOW = 4
WORD = re.compile(r"[A-Za-z0-9_]")

# The note says what was done, not which categories were present: a checkout
# with no origin remote collects no organization name, and a note that named one
# anyway would be asserting a redaction that never happened.
NOTE = (
    "This run was on a repository outside the plugin's enterprise, so every name "
    "collected from it was replaced with a placeholder. The shape of the case is "
    "real; the names are not."
)


class RedactError(Exception):
    """A names file that cannot be redacted with. Carries the exit status to use."""

    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def replace_bounded(text: str, value: str, placeholder: str) -> str:
    """Replace `value` only where a word character sits on neither side of it."""
    parts = text.split(value)
    if len(parts) < 2:
        return text
    out = parts[0]
    for index in range(1, len(parts)):
        before = parts[index - 1]
        after = parts[index]
        touching = (before and WORD.search(before[-1])) or (after and WORD.search(after[0]))
        out += (value if touching else placeholder) + after
    return out


def apply_table(text: str, table) -> str:
    """Every value in the table replaced by its placeholder, in table order."""
    for entry in table:
        value = entry.get("value")
        placeholder = entry.get("placeholder")
        if not isinstance(value, str) or not value:
            continue
        if len(value) < BOUNDED_BELOW:
            text = replace_bounded(text, value, placeholder)
        else:
            text = text.replace(value, placeholder)
    return text


def check_present(path: str) -> None:
    """A names file that is not there is a usage error, inside the enterprise too.

    Checked before anything is read, so a caller that named the wrong file is
    told so rather than passing text through as though redaction had been
    considered.
    """
    if not os.path.isfile(path):
        raise RedactError(f"no names file at {path}", 2)


def load_table(path: str):
    """The placeholders of a names file, or a RedactError saying why not.

    Every other file a run writes is a JSON object in the same run directory,
    and one of them handed here by mistake indexes to nothing: nothing would be
    replaced and the note would still be appended saying every name was. That
    is the one failure that publishes a real repository name under a line
    asserting it was removed.
    """
    try:
        with open(path) as handle:
            document = json.load(handle)
    except OSError:
        raise RedactError(f"no names file at {path}", 2) from None
    except ValueError:
        raise RedactError(f"names file is not valid JSON: {path}") from None
    if not isinstance(document, dict) or not isinstance(document.get("placeholders"), list):
        raise RedactError(
            f"{path} is not a names table (no placeholders array); "
            "refusing to claim a redaction that did not happen"
        )
    return document["placeholders"]


def redact(text: str, path: str, inside: bool) -> str:
    """`text` with every name replaced, plus the note; or `text` itself, inside.

    Inside the enterprise this is the identity function, byte for byte: the
    repository under test belongs to the same enterprise as the plugin, so the
    specifics are exactly what makes the issue reproducible and they stay.
    """
    if inside:
        return text
    return apply_table(text, load_table(path)) + "\n> " + NOTE + "\n"
