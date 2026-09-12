"""Black-box tests for `plugins/mermaid/scripts/mermaid-url.py`."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import zlib
from pathlib import Path

SCRIPT = Path(__file__).parent.parent.parent / "plugins" / "mermaid" / "scripts" / "mermaid-url.py"

DIAGRAM = "graph TD; A-->B"


def decode(url: str) -> dict:
    payload = url.split("pako:", 1)[1]
    padded = payload + "=" * (-len(payload) % 4)
    return json.loads(zlib.decompress(base64.urlsafe_b64decode(padded)))


def test_default_route_is_view(run_script):
    result = run_script(SCRIPT, stdin=DIAGRAM)
    assert result.status == 0
    assert result.stdout.strip().startswith("https://mermaid.live/view#pako:")


def test_edit_route(run_script):
    result = run_script(SCRIPT, "--route", "edit", stdin=DIAGRAM)
    assert result.stdout.strip().startswith("https://mermaid.live/edit#pako:")


def test_ink_svg_route(run_script):
    result = run_script(SCRIPT, "--route", "ink-svg", stdin=DIAGRAM)
    assert result.stdout.strip().startswith("https://mermaid.ink/svg/pako:")


def test_ink_img_route(run_script):
    result = run_script(SCRIPT, "--route", "ink-img", stdin=DIAGRAM)
    assert result.stdout.strip().startswith("https://mermaid.ink/img/pako:")


def test_payload_round_trips_the_diagram(run_script):
    result = run_script(SCRIPT, stdin=DIAGRAM)
    state = decode(result.stdout.strip())
    assert state["code"] == DIAGRAM
    assert json.loads(state["mermaid"]) == {"theme": "default"}


def test_theme_is_passed_through(run_script):
    result = run_script(SCRIPT, "--theme", "dark", stdin=DIAGRAM)
    state = decode(result.stdout.strip())
    assert json.loads(state["mermaid"]) == {"theme": "dark"}


def test_non_ascii_diagram_round_trips(run_script):
    diagram = "graph TD; A[café]-->B[☃]"
    result = run_script(SCRIPT, stdin=diagram)
    assert result.status == 0
    assert decode(result.stdout.strip())["code"] == diagram


def test_multiline_diagram_with_quotes_round_trips(run_script):
    diagram = 'graph TD\n  A["say \\"hi\\""]-->B\n  B-->C'
    result = run_script(SCRIPT, stdin=diagram)
    assert result.status == 0
    assert decode(result.stdout.strip())["code"] == diagram


def test_surrounding_whitespace_is_stripped_from_the_payload(run_script):
    result = run_script(SCRIPT, stdin=f"  \n{DIAGRAM}\n\t ")
    assert decode(result.stdout.strip())["code"] == DIAGRAM


def test_theme_with_quotes_and_backslashes_round_trips(run_script):
    theme = 'wei"rd\\theme'
    result = run_script(SCRIPT, "--theme", theme, stdin=DIAGRAM)
    state = decode(result.stdout.strip())
    assert json.loads(state["mermaid"]) == {"theme": theme}


def test_empty_theme_round_trips(run_script):
    result = run_script(SCRIPT, "--theme", "", stdin=DIAGRAM)
    state = decode(result.stdout.strip())
    assert json.loads(state["mermaid"]) == {"theme": ""}


def test_empty_stdin_is_a_reported_failure(run_script):
    result = run_script(SCRIPT, stdin="")
    assert result.status == 2
    assert "no diagram source on stdin" in result.stderr
    assert result.stdout == ""


def test_whitespace_only_stdin_is_a_reported_failure(run_script):
    result = run_script(SCRIPT, stdin="   \n\t")
    assert result.status == 2
    assert "no diagram source on stdin" in result.stderr


def test_unknown_route_is_a_usage_error(run_script):
    result = run_script(SCRIPT, "--route", "bogus", stdin=DIAGRAM)
    assert result.status == 2
    assert "invalid choice" in result.stderr


def test_invalid_utf8_stdin_is_a_reported_failure(run_script):
    # A lone 0xE9 is not valid UTF-8 on its own (it's the Latin-1 "é"), the
    # shape of a diagram pasted from a non-UTF-8 source.
    result = run_script(SCRIPT, stdin=b"graph TD; A[caf\xe9]-->B")
    assert result.status == 2
    assert "not valid UTF-8" in result.stderr
    assert result.stdout == ""


def test_ascii_locale_does_not_mangle_a_non_ascii_diagram(run_script):
    diagram = "graph TD; A[café]-->B"
    result = run_script(SCRIPT, stdin=diagram, env={"PYTHONIOENCODING": "ascii"})
    assert result.status == 0
    assert "Traceback" not in result.stderr
    assert decode(result.stdout.strip())["code"] == diagram


def test_error_messages_use_a_consistent_program_name(run_script):
    failure = run_script(SCRIPT, stdin="")
    usage_error = run_script(SCRIPT, "--route", "bogus", stdin=DIAGRAM)
    assert failure.stderr.startswith("mermaid-url.py:")
    assert "mermaid-url.py: error:" in usage_error.stderr
    assert "mermaid-url:" not in failure.stderr
    assert "mermaid-url:" not in usage_error.stderr


def test_broken_pipe_does_not_crash():
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    try:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=DIAGRAM.encode("utf-8"),
            stdout=write_fd,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        os.close(write_fd)
    assert completed.returncode == 0
    assert b"Traceback" not in completed.stderr
