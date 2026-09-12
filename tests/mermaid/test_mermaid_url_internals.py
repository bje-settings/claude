"""In-process tests for the two guard arms in `mermaid-url.py`'s `main`.

Both are unreachable from a real subprocess: a real `sys.stdout` always has
`.reconfigure`, and nothing reachable from the CLI can raise other than
`Failure` or `BrokenPipeError`. Loaded by path rather than run as a script, the
same technique `tests/test_publish.py` uses for a script with no `lib/` and no
`sys.path.insert` -- a fresh load per test, since an in-process loader must not
cache a script module across tests.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent.parent / "plugins" / "mermaid" / "scripts" / "mermaid-url.py"

DIAGRAM = "graph TD; A-->B"


@pytest.fixture
def module():
    spec = importlib.util.spec_from_file_location("mermaid_url_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _StreamWithoutReconfigure:
    """A stdout stand-in with no `.reconfigure`, forcing the `AttributeError` arm."""

    def __init__(self) -> None:
        self.written = []

    def write(self, text: str) -> None:
        self.written.append(text)

    def flush(self) -> None:
        pass


class _FakeStdin:
    def __init__(self, data: bytes) -> None:
        self.buffer = io.BytesIO(data)


def test_a_stream_without_reconfigure_does_not_crash_main(module, monkeypatch):
    fake_stdout = _StreamWithoutReconfigure()
    monkeypatch.setattr(sys, "stdout", fake_stdout)
    monkeypatch.setattr(sys, "stdin", _FakeStdin(DIAGRAM.encode()))

    status = module.main(["--route", "view"])

    assert status == 0
    assert "".join(fake_stdout.written).startswith("https://mermaid.live/view#pako:")


def test_an_unanticipated_exception_is_reported_not_raised(module, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", _FakeStdin(DIAGRAM.encode()))

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(module, "build_url", boom)

    status = module.main(["--route", "view"])
    captured = capsys.readouterr()

    assert status == 1
    assert "mermaid-url.py: internal error: RuntimeError: boom" in captured.err
