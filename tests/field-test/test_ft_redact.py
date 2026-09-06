"""Black-box tests for ft-redact.py.

Ported from `spec/field-test/redact_spec.sh`, plus one named test per placeholder
the table can carry: redaction can only fail in two ways, and both are checked
here against a real repository rather than a hand-written table — a name that
survives into a public issue, and a name stripped from an issue entitled to keep
it. "requires jq" did not come across; there is no jq to require.
"""

from __future__ import annotations

import json

import pytest
from conftest import FT_ISSUE, FT_REDACT, ft_fixture_repo

pytestmark = pytest.mark.usefixtures("ft_sandbox")


@pytest.fixture
def names(ft_sandbox, run_script):
    """The redaction table for a repository with a remote, a branch, and a #N."""

    def build(slug="acme-org/widgets", with_run=True):
        ft_fixture_repo(ft_sandbox.path / "target", slug)
        args = [str(ft_sandbox.path / "target")]
        if with_run:
            ft_sandbox.events.write_text(
                json.dumps(
                    {
                        "event": "PostToolUse",
                        "command": "gh pr view 12 --json url # see #12",
                        "exit_code": 0,
                    }
                )
                + "\n"
            )
            args += ["--run", str(ft_sandbox.run_dir)]
        result = run_script(FT_ISSUE, "names", *args)
        assert result.status == 0, result.stderr
        path = ft_sandbox.path / "names.json"
        path.write_text(result.stdout)
        return path

    return build


def sample(ft_sandbox):
    """The text an issue body would be built from: every name, as evidence holds it."""
    return (
        "Ran against acme-org/widgets, cloned from git@github.com:acme-org/widgets.git.\n"
        f"Checkout at {ft_sandbox.path / 'target'}, on branch wktr-9-widget-fix.\n"
        'Commit under test: "fix: the widget drops its last field" (see #12).\n'
        "Owner acme-org, repository widgets.\n"
    )


def redacted(ft_sandbox, run_script, path, *args):
    result = run_script(FT_REDACT, str(path), *args, stdin=sample(ft_sandbox))
    assert result.status == 0, result.stderr
    return result.stdout


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_REDACT, "--help")
    assert result.status == 0
    assert "ft-redact.py <names.json>" in result.stdout


def test_exits_2_with_usage_when_given_nothing(run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_REDACT)
    assert result.status == 2
    assert "ft-redact.py <names.json>" in result.stderr


def test_rejects_an_unknown_argument(names, run_script):
    """rejects an unknown argument"""
    result = run_script(FT_REDACT, str(names()), "--outside")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_refuses_a_names_file_that_is_not_there(ft_sandbox, run_script):
    """refuses a names file that is not there"""
    result = run_script(FT_REDACT, str(ft_sandbox.path / "nope.json"))
    assert result.status == 2
    assert "no names file" in result.stderr


def test_reports_a_names_file_that_is_not_json(ft_sandbox, run_script):
    """reports a names file that is not JSON"""
    path = ft_sandbox.path / "names.json"
    path.write_text("nope")
    result = run_script(FT_REDACT, str(path), stdin="text")
    assert result.status == 1
    assert "not valid JSON" in result.stderr


def test_refuses_json_that_is_not_a_names_table(ft_sandbox, run_script):
    """refuses JSON that is not a names table, rather than redacting nothing and saying it did

    Every file a run writes is a JSON object in the same directory, so the wrong
    one parses. Redacting nothing and appending the note anyway is how a real
    repository name reaches a public issue under a line saying it was removed.
    """
    path = ft_sandbox.path / "names.json"
    path.write_text('{"target":"gh:shepherd","args":[]}')
    result = run_script(FT_REDACT, str(path), stdin="acme-org/widgets is here")
    assert result.status == 1
    assert "not a names table" in result.stderr
    assert result.stdout == ""


# --- outside the enterprise --------------------------------------------------


def test_leaves_not_one_name_in_the_output(ft_sandbox, names, run_script):
    """leaves not one name of the repository under test in the output"""
    path = names()
    output = redacted(ft_sandbox, run_script, path)
    table = json.loads(path.read_text())["placeholders"]
    survivors = [entry["value"] for entry in table if entry["value"] in output]
    assert survivors == []


def test_replaces_owner_name_before_owner(ft_sandbox, names, run_script):
    """replaces owner/name before owner, so the repository is not half-named"""
    output = redacted(ft_sandbox, run_script, names())
    assert "<org>/<repo>" in output
    assert "<org>/widgets" not in output


@pytest.mark.parametrize(
    "placeholder",
    ["<remote-url>", "<org>/<repo>", "<path>", "<commit>", "<branch>", "<pr>", "<org>", "<repo>"],
)
def test_replaces_every_kind_of_name(ft_sandbox, names, run_script, placeholder):
    """replaces the branch, the commit subject, the path, and the reference

    One case per placeholder the table can carry: a category that stops being
    collected leaves a real name in a public issue, and only the placeholder it
    would have become says which.
    """
    assert placeholder in redacted(ft_sandbox, run_script, names())


def test_says_the_run_was_outside_the_enterprise(ft_sandbox, names, run_script):
    """says the run was outside the enterprise, so the shape reads as real"""
    output = redacted(ft_sandbox, run_script, names())
    assert "outside the plugin" in output
    assert "The shape of the case is real; the names are not." in output


def test_keeps_everything_that_is_not_a_name(ft_sandbox, names, run_script):
    """keeps everything that is not a name"""
    output = redacted(ft_sandbox, run_script, names())
    assert "Checkout at" in output
    assert "Ran against" in output


# A short repository or branch name is a word that also appears inside other
# words. Replacing it everywhere rewrites the prose until the issue is
# unreadable, so a value under four characters is replaced only where it stands
# as a word.


def short(ft_sandbox, names, run_script):
    path = names("acme-org/run", with_run=False)
    result = run_script(
        FT_REDACT,
        str(path),
        stdin="A runner is running in the run directory of acme-org/run.\n",
    )
    assert result.status == 0, result.stderr
    return result.stdout


def test_a_short_name_is_replaced_where_it_stands_alone(ft_sandbox, names, run_script):
    """still replaces the name where it stands on its own"""
    output = short(ft_sandbox, names, run_script)
    assert "the <repo> directory" in output
    assert "<org>/<repo>" in output


def test_a_short_name_leaves_the_words_it_is_part_of_alone(ft_sandbox, names, run_script):
    """leaves the words it is only a part of alone"""
    assert "A runner is running" in short(ft_sandbox, names, run_script)


# --- inside the enterprise ---------------------------------------------------


def test_inside_passes_the_text_through_byte_for_byte(ft_sandbox, names, run_script):
    """passes the text through byte for byte"""
    result = run_script(FT_REDACT, str(names()), "--inside", stdin=sample(ft_sandbox))
    assert result.status == 0
    assert result.stdout == sample(ft_sandbox)


def test_inside_adds_no_note_about_redaction(ft_sandbox, names, run_script):
    """adds no note about redaction"""
    result = run_script(FT_REDACT, str(names()), "--inside", stdin=sample(ft_sandbox))
    assert result.status == 0
    assert "outside the plugin" not in result.stdout


def test_inside_still_refuses_a_names_file_that_is_not_there(ft_sandbox, run_script):
    """refuses a names file that is not there, inside the enterprise too

    New with the port: --inside redacts nothing, but a caller that named the
    wrong file has not decided anything about redaction, and should hear so.
    """
    result = run_script(FT_REDACT, str(ft_sandbox.path / "nope.json"), "--inside", stdin="text")
    assert result.status == 2
    assert "no names file" in result.stderr
