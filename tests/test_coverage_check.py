"""The threshold gate decides whether a build passes, so it gets its own tests.

Ported from spec/gh/coverage_check_spec.sh; each test's docstring is the `It`
description it came from, plus one for the branch listing the port added.
"""

from __future__ import annotations

from pathlib import Path

import pytest

CHECK = Path(__file__).resolve().parent / "coverage_check.py"


def write_report(path: Path, covered: int, total: int, branches: str = "") -> Path:
    """Minimal Cobertura: one class, `covered` lines hit out of `total`."""
    rate = covered / total
    lines = "".join(
        f'<line number="{number}" hits="{1 if number <= covered else 0}"/>'
        for number in range(1, total + 1)
    )
    path.write_text(
        '<?xml version="1.0"?>\n'
        f'<coverage line-rate="{rate}">\n'
        '  <packages><package name="p"><classes>\n'
        f'    <class name="c" filename="plugins/gh/scripts/thing.sh" line-rate="{rate}">\n'
        f"      <lines>{lines}{branches}</lines>\n"
        "    </class>\n"
        "  </classes></package></packages>\n"
        "</coverage>\n"
    )
    return path


@pytest.fixture
def report(tmp_path: Path) -> Path:
    return tmp_path / "cobertura.xml"


def test_passes_above_threshold(run_script, report):
    """passes when coverage is above the threshold"""
    write_report(report, 97, 100)
    result = run_script(CHECK, report, 95)
    assert result.status == 0
    assert "97.00%" in result.stdout


def test_passes_exactly_on_threshold(run_script, report):
    """passes when coverage sits exactly on the threshold"""
    write_report(report, 95, 100)
    result = run_script(CHECK, report, 95)
    assert result.status == 0
    assert "overall: 95.00%" in result.stdout


def test_fails_below_threshold(run_script, report):
    """fails when coverage is below the threshold"""
    write_report(report, 94, 100)
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "overall: 94.00%" in result.stdout
    assert "below the threshold" in result.stderr


def test_names_the_uncovered_lines(run_script, report):
    """names the uncovered lines so a drop says what moved"""
    write_report(report, 8, 10)
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "plugins/gh/scripts/thing.sh" in result.stdout
    assert "uncovered: 9,10" in result.stdout
    assert result.stderr


def test_names_the_partly_taken_branches(run_script, report):
    """names the lines whose branches were only partly taken

    kcov's report carries no branch attributes, so this listing is coverage.py's
    alone; a line that is hit but only half-branched is invisible in the line
    number and is exactly what the port added branch coverage to surface.
    """
    write_report(
        report,
        100,
        100,
        branches=(
            '<line number="3" hits="1" branch="true" condition-coverage="50% (1/2)"/>'
            '<line number="7" hits="1" branch="true" condition-coverage="100% (2/2)"/>'
        ),
    )
    result = run_script(CHECK, report, 95)
    assert result.status == 0
    assert "partial branches: 3" in result.stdout
    # The fully covered branch on line 7 is not noise the reader has to filter.
    assert "partial branches: 3,7" not in result.stdout


def test_says_nothing_about_branches_for_a_kcov_report(run_script, report):
    """stays quiet about branches on a report that has none (kcov's)"""
    write_report(report, 97, 100)
    result = run_script(CHECK, report, 95)
    assert result.status == 0
    assert "partial branches" not in result.stdout


def test_defaults_to_95(run_script, report):
    """defaults to a 95 threshold"""
    write_report(report, 94, 100)
    result = run_script(CHECK, report)
    assert result.status == 1
    assert "threshold: 95.00%" in result.stdout
    assert result.stderr


def test_rejects_no_report(run_script):
    """rejects being called with no report"""
    result = run_script(CHECK)
    assert result.status == 2
    assert "usage:" in result.stderr
