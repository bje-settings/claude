"""Test module basenames are unique across the whole suite.

pytest imports test modules into one namespace, so two files named
`test_fixtures.py` in different plugin directories collide: the second one
imported shadows the first, and whichever loses is silently never run. There
are no `__init__.py` files here to give each directory its own package, and
adding them is the wrong trade: the plugins are installed separately and their
tests should stay as independent of each other as they are. So the rule is a
naming one, and this is what enforces it. See `.claude/rules/type-py.md`.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def test_no_duplicate_test_module_basenames():
    names = Counter(path.name for path in TESTS.rglob("test_*.py"))
    duplicates = {name: count for name, count in names.items() if count > 1}
    assert not duplicates, (
        "test module basenames must be unique across the suite, because pytest "
        f"imports them into one namespace; repeated: {sorted(duplicates)}"
    )
