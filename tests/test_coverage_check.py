"""The threshold gate decides whether a build passes, so it gets its own tests.

The six ported tests carry the `It` description they came from in their
docstring; the rest were added with the port, for the branch listing and for the
failure modes the shell spec never covered (an empty report, a bad threshold, an
unreadable file).
"""

from __future__ import annotations

from pathlib import Path

import pytest

CHECK = Path(__file__).resolve().parent / "coverage_check.py"


def write_report(
    path: Path, covered: int, total: int, branches: str = "", root_rate: str | None = None
) -> Path:
    """Minimal Cobertura: one class, `covered` lines hit out of `total`."""
    rate = covered / total
    lines = "".join(
        f'<line number="{number}" hits="{1 if number <= covered else 0}"/>'
        for number in range(1, total + 1)
    )
    root = f'line-rate="{rate}"' if root_rate is None else root_rate
    path.write_text(
        '<?xml version="1.0"?>\n'
        f"<coverage {root}>\n"
        '  <packages><package name="p"><classes>\n'
        f'    <class name="c" filename="plugins/gh/scripts/thing.sh" line-rate="{rate}">\n'
        f"      <lines>{lines}{branches}</lines>\n"
        "    </class>\n"
        "  </classes></package></packages>\n"
        "</coverage>\n",
        encoding="utf-8",
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


def test_names_uncovered_lines_and_partial_branches_together(run_script, report):
    """lists both kinds of gap on one line when a file has both"""
    write_report(
        report,
        8,
        10,
        branches='<line number="4" hits="1" branch="true" condition-coverage="50% (1/2)"/>',
    )
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "uncovered: 9,10  partial branches: 4" in result.stdout


def test_a_never_hit_branch_line_is_only_counted_as_uncovered(run_script, report):
    """leaves a branch line that was never hit to the uncovered list

    Reporting it twice would say a line is both unreached and half-reached, and
    the fix for the two is not the same.
    """
    write_report(
        report,
        9,
        10,
        branches='<line number="10" hits="0" branch="true" condition-coverage="0% (0/2)"/>',
    )
    result = run_script(CHECK, report, 95)
    assert "uncovered: 10" in result.stdout
    assert "partial branches" not in result.stdout


def test_a_branch_line_without_condition_coverage_says_nothing(run_script, report):
    """tolerates a branch line carrying no condition-coverage at all"""
    write_report(report, 100, 100, branches='<line number="5" hits="1" branch="true"/>')
    result = run_script(CHECK, report, 95)
    assert result.status == 0
    assert "partial branches" not in result.stdout


def test_rejects_a_report_with_no_measured_files(run_script, report):
    """fails loudly when the report measured nothing

    An empty report's root line-rate is 0 or 1 depending on the tool, so it would
    otherwise either fail with a misleading 0.00% or pass a build that measured
    no files at all.
    """
    report.write_text(
        '<?xml version="1.0"?>\n<coverage line-rate="1" lines-valid="0">\n'
        "  <packages></packages>\n</coverage>\n",
        encoding="utf-8",
    )
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "no measured files" in result.stderr


def test_rejects_a_report_with_no_line_rate(run_script, report):
    """calls a missing root line-rate a parse error rather than 0%"""
    write_report(report, 100, 100, root_rate='lines-valid="100"')
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "no line-rate" in result.stderr
    # Not reported as a 0% run: there is no overall line at all.
    assert "overall:" not in result.stdout


def test_rejects_a_report_with_an_unreadable_line_rate(run_script, report):
    """calls an unparsable root line-rate a parse error rather than 0%"""
    write_report(report, 100, 100, root_rate='line-rate="most of it"')
    result = run_script(CHECK, report, 95)
    assert result.status == 1
    assert "unreadable line-rate" in result.stderr


def test_rejects_a_report_it_cannot_read(run_script, tmp_path):
    """says which file it could not read, and exits 2"""
    missing = tmp_path / "not-there.xml"
    result = run_script(CHECK, missing, 95)
    assert result.status == 2
    assert "cannot read" in result.stderr
    assert str(missing) in result.stderr


def test_rejects_a_malformed_report(run_script, report):
    """says a report that is not XML could not be read, and exits 2"""
    report.write_text("<coverage line-rate=", encoding="utf-8")
    result = run_script(CHECK, report, 95)
    assert result.status == 2
    assert "cannot read" in result.stderr


def test_rejects_a_threshold_that_is_not_a_number(run_script, report):
    """rejects a threshold that is not a number

    Left to float() it would raise; left untyped it would silently become 0 and
    turn the gate off while still exiting 0.
    """
    write_report(report, 10, 100)
    result = run_script(CHECK, report, "ninetyfive")
    assert result.status == 2
    assert "not a number" in result.stderr
    assert "usage:" in result.stderr


def test_rejects_a_nan_threshold(run_script, report):
    """rejects a NaN threshold, which every comparison would pass"""
    write_report(report, 10, 100)
    result = run_script(CHECK, report, "nan")
    assert result.status == 2
    assert "between 0 and 100" in result.stderr


def test_rejects_a_threshold_outside_the_range(run_script, report):
    """rejects a negative threshold and one above 100"""
    write_report(report, 100, 100)
    for bad in ("-1", "101"):
        result = run_script(CHECK, report, bad)
        assert result.status == 2, bad
        assert "between 0 and 100" in result.stderr
