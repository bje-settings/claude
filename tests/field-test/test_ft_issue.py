"""Black-box tests for ft-issue.py.

Ported from `spec/field-test/issue_spec.sh`, one test per example. "requires jq"
did not come across; there is no jq to require. The render tests keep one example
per arm of `lib/render.py`, which `test_render.py` also covers directly.
"""

from __future__ import annotations

import json

import pytest
from conftest import FT_ISSUE, ft_fixture_repo, ft_fixture_run

pytestmark = pytest.mark.usefixtures("ft_sandbox")

REPO = "acme-org/plugins"


@pytest.fixture
def target(ft_sandbox):
    """The repository under test, as a real checkout."""

    def build(slug="acme-org/widgets", form="ssh"):
        return str(ft_fixture_repo(ft_sandbox.path / "target", slug, form))

    return build


@pytest.fixture
def names_file(ft_sandbox, run_script):
    """The redaction table for the repository under test, written to a file."""

    def build():
        result = run_script(FT_ISSUE, "names", str(ft_sandbox.path / "target"))
        assert result.status == 0, result.stderr
        path = ft_sandbox.path / "names.json"
        path.write_text(result.stdout)
        return str(path)

    return build


@pytest.fixture
def record(ft_sandbox):
    """One finding, of whichever kind and severity a test asks for."""

    def build(kind="bash_nonzero", severity="medium", count=1):
        path = ft_sandbox.path / "record.json"
        path.write_text(
            json.dumps(
                {
                    "kind": kind,
                    "severity": severity,
                    "count": count,
                    "signature": f"{kind}:gh pr merge --auto --squash N",
                    "agent_id": "agent-1",
                    "agent_type": "shepherd-repo",
                    "evidence": {
                        "command": "gh pr merge --auto --squash 11",
                        "reason": None,
                        "exit_code": 1,
                        "stderr": "GraphQL: Pull request is in unstable status",
                        "claim": "All four pull requests were merged.",
                        "preceding": ["git fetch origin"],
                    },
                }
            )
        )
        return str(path)

    return build


def names_of(result):
    return json.loads(result.stdout)


def values_of(result):
    return [entry["value"] for entry in names_of(result)["placeholders"]]


def placeholders_of(result):
    return [entry["placeholder"] for entry in names_of(result)["placeholders"]]


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(run_script):
    """prints usage for --help"""
    result = run_script(FT_ISSUE, "--help")
    assert result.status == 0
    assert "ft-issue.py names" in result.stdout


def test_exits_2_with_usage_when_given_nothing(run_script):
    """exits 2 with usage when given nothing"""
    result = run_script(FT_ISSUE)
    assert result.status == 2
    assert "ft-issue.py names" in result.stderr


def test_rejects_an_unknown_command(run_script):
    """rejects an unknown command"""
    result = run_script(FT_ISSUE, "file")
    assert result.status == 2
    assert "unknown command: file" in result.stderr


# --- names -------------------------------------------------------------------


def test_names_needs_an_existing_directory(ft_sandbox, run_script):
    """needs an existing directory"""
    result = run_script(FT_ISSUE, "names", str(ft_sandbox.path / "nope"))
    assert result.status == 2
    assert "existing repository directory" in result.stderr


def test_names_rejects_an_unknown_argument(target, run_script):
    """rejects an unknown argument"""
    result = run_script(FT_ISSUE, "names", target(), "--deep")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_names_rejects_run_with_no_value(target, run_script):
    """rejects --run with no value"""
    result = run_script(FT_ISSUE, "names", target(), "--run")
    assert result.status == 2
    assert "--run needs a value" in result.stderr


def test_names_collects_the_remote_slug_owner_and_name(target, run_script):
    """collects the remote, the slug, the owner, and the name"""
    result = run_script(FT_ISSUE, "names", target())
    assert result.status == 0
    assert names_of(result)["repo"] == "acme-org/widgets"
    for placeholder in ("<org>/<repo>", "<remote-url>", "<org>", "<repo>"):
        assert placeholder in placeholders_of(result)


def test_names_collects_branches_and_subjects(target, run_script):
    """collects the branches and the recent commit subjects"""
    result = run_script(FT_ISSUE, "names", target())
    assert result.status == 0
    assert "wktr-9-widget-fix" in values_of(result)
    assert "fix: the widget drops its last field" in values_of(result)


def test_names_orders_the_table_longest_first(target, run_script):
    """orders the table longest value first, so owner/name beats owner"""
    result = run_script(FT_ISSUE, "names", target())
    lengths = [len(value) for value in values_of(result)]
    assert lengths == sorted(lengths, reverse=True)


def test_names_collects_the_references_seen_during_the_run(ft_sandbox, target, run_script):
    """collects the references seen during the run"""
    directory = target()
    ft_sandbox.events.write_text(
        json.dumps(
            {"event": "PostToolUse", "command": "gh pr view 12 # closes #12", "exit_code": 0}
        )
        + "\n"
    )
    result = run_script(FT_ISSUE, "names", directory, "--run", str(ft_sandbox.run_dir))
    assert result.status == 0
    assert "#12" in values_of(result)
    assert "<pr>" in placeholders_of(result)


def test_names_answers_for_a_checkout_with_no_remote(target, run_script):
    """still answers for a checkout with no remote, using the directory name"""
    result = run_script(FT_ISSUE, "names", target("acme-org/widgets", "none"))
    assert result.status == 0
    assert names_of(result)["repo"] is None
    assert "target" in values_of(result)


def test_names_refuses_a_directory_that_is_not_a_checkout(ft_sandbox, run_script):
    """refuses a directory that is not a git checkout, rather than redacting nothing"""
    plain = ft_sandbox.path / "plain"
    plain.mkdir()
    result = run_script(FT_ISSUE, "names", str(plain))
    assert result.status == 2
    assert "not one" in result.stderr


def test_names_collects_both_spellings_of_a_symlinked_checkout(ft_sandbox, target, run_script):
    """collects both spellings of a checkout reached through a symlink"""
    directory = target()
    link = ft_sandbox.path / "link"
    link.symlink_to(directory)
    result = run_script(FT_ISSUE, "names", str(link))
    assert result.status == 0
    paths = [
        entry["value"]
        for entry in names_of(result)["placeholders"]
        if entry["placeholder"] == "<path>"
    ]
    assert str(link) in paths


def test_names_keeps_a_remote_naming_no_owner_out_of_the_table(target, run_script):
    """keeps the remote out of the table when it names no owner and repo"""
    result = run_script(FT_ISSUE, "names", target("singleton"))
    assert result.status == 0
    assert names_of(result)["repo"] is None
    assert "target" in values_of(result)
    assert "<org>/<repo>" not in placeholders_of(result)


def test_names_refuses_a_run_directory_with_no_events_file(ft_sandbox, target, run_script):
    """refuses a run directory with no events file, rather than dropping the #N references"""
    directory = target()
    ft_sandbox.events.unlink()
    result = run_script(FT_ISSUE, "names", directory, "--run", str(ft_sandbox.run_dir))
    assert result.status == 2
    assert "no events file" in result.stderr


def test_names_refuses_an_events_file_it_cannot_read(ft_sandbox, target, run_script):
    """refuses an events file it cannot read, rather than dropping the #N references"""
    directory = target()
    ft_sandbox.events.write_text('{"event":"PostToolUse","command":"gh pr view 12 # closes #12"\n')
    result = run_script(FT_ISSUE, "names", directory, "--run", str(ft_sandbox.run_dir))
    assert result.status == 1
    assert "would survive redaction" in result.stderr


def test_names_reads_the_owner_through_an_ssh_host_alias(target, run_script):
    """reads the owner through an ssh host alias, which names the same repository"""
    result = run_script(FT_ISSUE, "names", target("acme-org/widgets", "alias"))
    assert result.status == 0
    assert names_of(result)["repo"] == "acme-org/widgets"
    assert "acme-org" in values_of(result)
    assert "widgets" in values_of(result)


def test_names_drops_a_value_too_short_to_replace_safely(target, run_script):
    """drops a value too short to replace safely"""
    result = run_script(FT_ISSUE, "names", target("a/b"))
    assert result.status == 0
    assert "a" not in values_of(result)
    assert "b" not in values_of(result)


# --- search ------------------------------------------------------------------


def test_search_needs_a_repo_and_a_signature(run_script):
    """needs a repo and a signature"""
    result = run_script(FT_ISSUE, "search", REPO)
    assert result.status == 2
    assert "search needs" in result.stderr


def test_search_finds_the_open_issue_with_the_same_signature(run_script):
    """finds the open field-test issue carrying the same signature"""
    result = run_script(FT_ISSUE, "search", REPO, "bash_nonzero:gh pr merge --auto --squash N")
    assert result.status == 0
    assert result.stdout.strip() == "40"


def test_search_prints_nothing_when_no_open_issue_carries_it(run_script):
    """prints nothing when no open issue carries it"""
    result = run_script(FT_ISSUE, "search", REPO, "denied:git push --force origin main")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_search_ignores_an_issue_that_is_not_labelled(run_script):
    """ignores an issue that is not labelled field-test"""
    result = run_script(FT_ISSUE, "search", REPO, "is not a field-test issue")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_search_finds_a_signature_holding_quotes(run_script):
    """finds a signature holding the quotes a shell command normally holds"""
    result = run_script(FT_ISSUE, "search", REPO, 'bash_nonzero:gh pr comment -b "done" N')
    assert result.status == 0
    assert result.stdout.strip() == "44"


def test_search_treats_a_gh_failure_as_no_match(ft_sandbox, run_script):
    """treats a gh failure as no match rather than a duplicate"""
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = run_script(FT_ISSUE, "search", REPO, "bash_nonzero:gh pr merge --auto --squash N")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_search_treats_a_missing_gh_as_no_match(ft_sandbox, run_script):
    """treats a gh that cannot be run as no match

    New with the port: the shell read gh's failure and its absence through the
    same non-zero exit; Python has to catch the OSError to keep exiting 0.
    """
    ft_sandbox.setenv("FT_GH", ft_sandbox.path / "no-such-gh")
    result = run_script(FT_ISSUE, "search", REPO, "bash_nonzero:gh pr merge --auto --squash N")
    assert result.status == 0
    assert result.stdout.strip() == ""


# --- ensure-label ------------------------------------------------------------


def test_ensure_label_needs_a_repo(run_script):
    """needs a repo"""
    result = run_script(FT_ISSUE, "ensure-label")
    assert result.status == 2
    assert "ensure-label needs" in result.stderr


def test_ensure_label_creates_the_label(run_script):
    """creates the label, and does not mind that it is already there"""
    result = run_script(FT_ISSUE, "ensure-label", REPO)
    assert result.status == 0
    assert "field-test" in result.stdout


def test_ensure_label_reports_a_failure(ft_sandbox, run_script):
    """reports a failure rather than carrying on"""
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = run_script(FT_ISSUE, "ensure-label", REPO)
    assert result.status == 1
    assert "could not create the field-test label" in result.stderr


def test_ensure_label_reports_a_gh_that_cannot_be_run(ft_sandbox, run_script):
    """reports a gh that cannot be run

    New with the port, for the same reason as the search case above.
    """
    ft_sandbox.setenv("FT_GH", ft_sandbox.path / "no-such-gh")
    result = run_script(FT_ISSUE, "ensure-label", REPO)
    assert result.status == 1
    assert "could not create the field-test label" in result.stderr


# --- render ------------------------------------------------------------------


def render(ft_sandbox, run_script, record_path, names_path, *args, run=None):
    return run_script(
        FT_ISSUE,
        "render",
        record_path,
        str(run or ft_sandbox.marker),
        names_path,
        *args,
    )


def test_render_refuses_a_record_that_is_not_json(ft_sandbox, target, names_file, run_script):
    """refuses a record that is not JSON, rather than printing an empty title"""
    target()
    names = names_file()
    path = ft_sandbox.path / "record.json"
    path.write_text("nope")
    result = render(ft_sandbox, run_script, str(path), names)
    assert result.status == 2
    assert "record is not valid JSON" in result.stderr
    assert result.stdout == ""


def test_render_refuses_a_run_marker_that_is_not_json(
    ft_sandbox, target, names_file, record, run_script
):
    """refuses a run marker that is not JSON"""
    target()
    names = names_file()
    broken = ft_sandbox.path / "broken-run.json"
    broken.write_text("nope")
    result = render(ft_sandbox, run_script, record(), names, run=broken)
    assert result.status == 2
    assert "run marker is not valid JSON" in result.stderr
    assert result.stdout == ""


def test_render_needs_all_three_files(ft_sandbox, run_script):
    """needs all three files"""
    result = run_script(FT_ISSUE, "render", str(ft_sandbox.path / "nope.json"))
    assert result.status == 2
    assert "render needs" in result.stderr


def test_render_rejects_an_unknown_argument(ft_sandbox, target, names_file, record, run_script):
    """rejects an unknown argument"""
    target()
    result = render(ft_sandbox, run_script, record(), names_file(), "--outside")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_render_puts_the_title_on_the_first_line(
    ft_sandbox, target, names_file, record, run_script
):
    """puts the title on the first line, in the repository commit convention"""
    target()
    result = render(ft_sandbox, run_script, record(), names_file(), "--inside")
    assert result.status == 0
    assert result.stdout.split("\n")[0] == "fix: gh:shepherd: gh pr merge --auto --squash N"


def test_render_uses_test_for_a_missing_check(ft_sandbox, target, names_file, record, run_script):
    """uses test rather than fix when the finding is a missing check"""
    target()
    result = render(ft_sandbox, run_script, record("args_dropped", "low"), names_file(), "--inside")
    assert result.status == 0
    assert "test: gh:shepherd:" in result.stdout.split("\n")[0]


def test_render_writes_expected_and_actual_for_denied(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the expected and actual for the kind of finding"""
    target()
    result = render(ft_sandbox, run_script, record("denied", "high"), names_file(), "--inside")
    assert result.status == 0
    assert "reach for a command that cannot be undone" in result.stdout
    assert "the field-test hook blocked it" in result.stdout


def test_render_quotes_the_claim_back(ft_sandbox, target, names_file, record, run_script):
    """quotes the claim back when a subagent contradicted itself"""
    target()
    result = render(
        ft_sandbox, run_script, record("subagent_contradiction", "high"), names_file(), "--inside"
    )
    assert result.status == 0
    assert "All four pull requests were merged." in result.stdout
    assert "never resolved" in result.stdout


def test_render_names_the_lost_rule(ft_sandbox, target, names_file, record, run_script):
    """names the lost rule when the finding is a deny-list rule that did not compile"""
    target()
    result = render(
        ft_sandbox, run_script, record("deny_list_error", "high"), names_file(), "--inside"
    )
    assert result.status == 0
    assert "every rule in the deny list to be in force" in result.stdout
    assert "blocked nothing" in result.stdout


def test_render_describes_a_tool_failure_fixture(
    ft_sandbox, target, names_file, record, run_script
):
    """describes what a tool_failure fixture would have to reproduce"""
    target()
    result = render(ft_sandbox, run_script, record("tool_failure"), names_file(), "--inside")
    assert result.status == 0
    assert "built by the fixtures rather than mocked" in result.stdout


def test_render_writes_expected_and_actual_for_a_non_zero_exit(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the expected and actual for a non-zero exit"""
    target()
    result = render(ft_sandbox, run_script, record("bash_nonzero"), names_file(), "--inside")
    assert result.status == 0
    assert "the command to exit 0" in result.stdout
    assert "exited non-zero and the run continued" in result.stdout


def test_render_writes_expected_and_actual_for_a_failed_tool_call(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the expected and actual for a tool call that failed"""
    target()
    result = render(ft_sandbox, run_script, record("tool_failure"), names_file(), "--inside")
    assert result.status == 0
    assert "the tool call to complete" in result.stdout
    assert "the tool call failed and the run continued" in result.stdout


def test_render_writes_expected_actual_and_fixture_for_a_dropped_option(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the expected, actual and fixture for a dropped option"""
    target()
    result = render(ft_sandbox, run_script, record("args_dropped", "low"), names_file(), "--inside")
    assert result.status == 0
    assert "every option given to the target to reach the commands it runs" in result.stdout
    assert "never appeared in any command" in result.stdout
    assert "runs the target with this option" in result.stdout


def test_render_writes_the_fixture_a_denied_command_needs(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the fixture a denied command would need"""
    target()
    result = render(ft_sandbox, run_script, record("denied", "high"), names_file(), "--inside")
    assert result.status == 0
    assert "still allows the benign form of it" in result.stdout


def test_render_writes_the_fixture_a_contradicting_subagent_needs(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the fixture a contradicting subagent would need"""
    target()
    result = render(
        ft_sandbox, run_script, record("subagent_contradiction", "high"), names_file(), "--inside"
    )
    assert result.status == 0
    assert "A canned subagent result" in result.stdout


def test_render_writes_the_fixture_a_dropped_rule_needs(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the fixture a dropped deny-list rule would need"""
    target()
    result = render(
        ft_sandbox, run_script, record("deny_list_error", "high"), names_file(), "--inside"
    )
    assert result.status == 0
    assert "leave the remaining rules in force" in result.stdout


def test_render_writes_the_fixture_a_crashed_hook_needs(
    ft_sandbox, target, names_file, record, run_script
):
    """writes the fixture a crashed hook would need"""
    target()
    result = render(ft_sandbox, run_script, record("hook_error", "high"), names_file(), "--inside")
    assert result.status == 0
    assert "record every tool call and filter every Bash call" in result.stdout
    assert "went through unrecorded and unfiltered" in result.stdout
    assert "leave the session running" in result.stdout


def test_render_still_renders_a_kind_it_has_no_words_for(
    ft_sandbox, target, names_file, record, run_script
):
    """still renders a kind it has no words for, rather than an empty issue"""
    target()
    result = render(ft_sandbox, run_script, record("something_new"), names_file(), "--inside")
    assert result.status == 0
    assert "the target to complete the step without this" in result.stdout
    assert "see the output below" in result.stdout
    assert "built by the fixtures rather than mocked" in result.stdout


def test_render_says_what_was_not_recorded(ft_sandbox, target, names_file, run_script):
    """says what was not recorded rather than leaving the issue blank"""
    target()
    names = names_file()
    path = ft_sandbox.path / "record.json"
    path.write_text(
        json.dumps(
            {
                "kind": "args_dropped",
                "severity": "low",
                "count": 1,
                "signature": "args_dropped:--dry-run",
                "agent_id": None,
                "agent_type": None,
                "evidence": {
                    "command": None,
                    "reason": None,
                    "exit_code": None,
                    "stderr": "",
                    "argument": "--dry-run",
                    "preceding": [],
                },
            }
        )
    )
    result = render(ft_sandbox, run_script, str(path), names, "--inside")
    assert result.status == 0
    assert "the finding is about the run as a whole" in result.stdout
    assert "(no output recorded)" in result.stdout
    assert "Exit code: not recorded" in result.stdout
    assert "Nothing was recorded before it." in result.stdout
    assert "A args_dropped finding recorded during the run." in result.stdout


def test_render_says_so_when_the_marker_recorded_no_plugin(
    ft_sandbox, target, names_file, record, run_script
):
    """says so when the marker recorded no plugin, version or commit"""
    target()
    bare = ft_sandbox.path / "bare-run.json"
    ft_fixture_run(bare, "gh:shepherd", [], None)
    result = render(ft_sandbox, run_script, record(), names_file(), "--inside", run=bare)
    assert result.status == 0
    assert "`gh:shepherd` version unknown" in result.stdout
    assert "not a local checkout" in result.stdout
    assert "| Arguments | `(none)` |" in result.stdout


def test_render_carries_the_run_detail(ft_sandbox, target, names_file, record, run_script):
    """carries the run detail an issue is useless without"""
    target()
    result = render(ft_sandbox, run_script, record(), names_file(), "--inside")
    assert result.status == 0
    assert "`gh` 0.2.0" in result.stdout
    assert "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6" in result.stdout
    assert "2.1.263 (Claude Code)" in result.stdout
    assert "--dry-run" in result.stdout
    assert "git fetch origin" in result.stdout


def test_render_redacts_when_the_run_was_outside_the_enterprise(
    ft_sandbox, target, names_file, record, run_script
):
    """redacts the repository under test when the run was outside the enterprise"""
    target()
    result = render(ft_sandbox, run_script, record(), names_file())
    assert result.status == 0
    assert "outside the plugin" in result.stdout
    assert "acme-org/widgets" not in result.stdout


def test_render_refuses_a_names_file_that_is_not_a_table(ft_sandbox, target, record, run_script):
    """refuses a names file that is not a names table, rather than rendering an issue

    New with the port: the shell piped through ft-redact.sh and inherited its
    status; the same refusal has to survive the call becoming a function.
    """
    target()
    names = ft_sandbox.path / "names.json"
    names.write_text('{"target":"gh:shepherd"}')
    result = render(ft_sandbox, run_script, record(), str(names))
    assert result.status == 1
    assert "not a names table" in result.stderr


def test_search_treats_an_answer_it_cannot_read_as_no_match(ft_sandbox, run_script):
    """treats an answer that is not JSON as no match

    New with the port: the shell piped gh into jq and a jq failure printed
    nothing; the reader has to swallow the same thing rather than raising.
    """
    stub = ft_sandbox.path / "bin" / "gh"
    stub.parent.mkdir(parents=True, exist_ok=True)
    stub.write_text("#!/bin/sh\nprintf 'not json'\n")
    stub.chmod(0o755)
    ft_sandbox.setenv("FT_GH", stub)
    result = run_script(FT_ISSUE, "search", REPO, "bash_nonzero:gh pr merge --auto --squash N")
    assert result.status == 0
    assert result.stdout.strip() == ""


def test_names_refuses_an_events_file_it_cannot_open(ft_sandbox, target, run_script):
    """refuses an events file it cannot open, rather than dropping the #N references"""
    import os

    if os.geteuid() == 0:
        pytest.skip("running as root, permissions do not apply")
    directory = target()
    ft_sandbox.events.chmod(0o000)
    try:
        result = run_script(FT_ISSUE, "names", directory, "--run", str(ft_sandbox.run_dir))
    finally:
        ft_sandbox.events.chmod(0o644)
    assert result.status == 1
    assert "would survive redaction" in result.stderr


def test_names_skips_a_recorded_event_that_is_not_an_object(ft_sandbox, target, run_script):
    """reads past a recorded line that is not an event record"""
    directory = target()
    ft_sandbox.events.write_text('[1, 2, 3]\n{"event":"PostToolUse","command":"gh pr view #12"}\n')
    result = run_script(FT_ISSUE, "names", directory, "--run", str(ft_sandbox.run_dir))
    assert result.status == 0
    assert "#12" in values_of(result)
