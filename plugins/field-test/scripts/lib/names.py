"""The redaction table for one repository under test.

`names_table` takes what git and the run's events said about a checkout and
returns

    {"repo": ..., "placeholders": [{"value": ..., "placeholder": ...}, ...]}

`placeholders` is ordered longest value first, which is the whole point of
building it here rather than at the call site: `owner/name` has to be replaced
before `owner`, or the result reads `<org>/name` and the repository is still
named.

Empty and one-character values are dropped: a value that is empty would match
everywhere, and a single character matches inside every other word. Values of
two and three characters are kept, because a repository really can be called
`cm`; `redact` replaces those only where they stand as a word.
"""

from __future__ import annotations

import re

REF = re.compile(r"#[0-9]+")

# Longest-first is enforced by sorting, but the order below still decides which
# placeholder a value keeps when two categories collect the same string.
CATEGORIES = (
    ("remote", "<remote-url>"),
    ("repo", "<org>/<repo>"),
    ("paths", "<path>"),
    ("subjects", "<commit>"),
    ("branches", "<branch>"),
    ("refs", "<pr>"),
    ("owner", "<org>"),
    ("name", "<repo>"),
)


def refs_in(text: str):
    """The `#N` references a run mentioned, sorted and deduplicated.

    They are pull request and issue numbers on the repository under test, which
    name it as surely as its branches do.
    """
    return sorted(set(REF.findall(text or "")))


def lines(text: str):
    """Non-empty lines, which is what git's list output amounts to."""
    return [line for line in (text or "").split("\n") if line]


def names_table(fields):
    """The table, from {remote, repo, owner, name, branches, paths, refs, subjects}."""
    entries = []
    for key, placeholder in CATEGORIES:
        value = fields.get(key)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, str) and len(item) > 1:
                entries.append({"value": item, "placeholder": placeholder})
    seen = {}
    for entry in sorted(entries, key=lambda entry: entry["value"]):
        seen.setdefault(entry["value"], entry)
    placeholders = sorted(seen.values(), key=lambda entry: -len(entry["value"]))
    return {"repo": fields.get("repo") or None, "placeholders": placeholders}
