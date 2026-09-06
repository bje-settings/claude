"""The shellcheck file list is written out twice, so a test keeps the copies equal.

`.github/workflows/ci.yml` lints the shell scripts in CI; `.pre-commit-config.yaml`
lints the same ones before a commit. A file added to one list and forgotten in the
other is only discovered when it is already broken, so compare them here. Issue #61
deletes the pre-commit hook along with the last `.sh` file under `plugins/`, and this
test with it.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _ci_shellcheck_files() -> list[str]:
    """The arguments to the `shellcheck -S warning \\` command in the lint job."""
    text = (REPO / ".github/workflows/ci.yml").read_text()
    start = text.index("shellcheck -S warning \\")
    body = text[start:]
    files = []
    for line in body.splitlines()[1:]:
        stripped = line.strip()
        if not stripped:
            break
        files.append(stripped.rstrip("\\").strip())
        if not stripped.endswith("\\"):
            break
    return files


def _pre_commit_shellcheck_files() -> list[str]:
    """The `args:` entries of the shellcheck hook."""
    text = (REPO / ".pre-commit-config.yaml").read_text()
    start = text.index("id: shellcheck")
    args = text.index("args:", start)
    files = []
    for line in text[args:].splitlines()[1:]:
        match = re.match(r"^\s+- (\S+)$", line)
        if not match:
            break
        files.append(match.group(1))
    return files


def test_the_two_shellcheck_lists_are_the_same() -> None:
    assert _pre_commit_shellcheck_files() == _ci_shellcheck_files()


def test_every_listed_file_exists() -> None:
    listed = _ci_shellcheck_files()
    assert listed, "parsed an empty list out of ci.yml"
    missing = [f for f in listed if not (REPO / f).is_file()]
    assert missing == []
