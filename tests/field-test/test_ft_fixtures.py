"""The claims this plugin's fixtures make, asserted.

Ported from the run-side half of `spec/field-test/fixtures_spec.sh`. The other
tests here read claims off these fixtures: that a repository has this branch,
that an events file holds an unresolved failure, that the stub serves one open
issue carrying the signature the duplicate search looks for. Asserting those
claims is what stops the rest of the suite passing for the wrong reason. The
deny-list and allow-list counts moved to `test_ft_hooks.py`, beside the tests
that walk them.
"""

from __future__ import annotations

import json

import pytest
from conftest import (
    ft_fixture_enterprise,
    ft_fixture_events,
    ft_fixture_git,
    ft_fixture_hook_input,
    ft_fixture_installed_plugins,
    ft_fixture_repo,
    ft_fixture_run,
    ft_fixture_transcript,
)

pytestmark = pytest.mark.usefixtures("ft_sandbox")


def events_of(path):
    return [json.loads(line) for line in path.read_text().split("\n") if line.strip()]


def write_events(ft, case):
    path = ft.path / "e.jsonl"
    ft_fixture_events(path, case)
    return events_of(path)


# --- ft_fixture_repo ---------------------------------------------------------


def test_the_repo_has_two_branches_and_the_stated_subjects(ft_sandbox):
    """builds a repository with two branches and the stated commit subjects"""
    directory = ft_fixture_repo(ft_sandbox.path / "r", "acme-org/widgets")
    branches = ft_fixture_git(
        directory, "for-each-ref", "--format=%(refname:short)", "refs/heads/"
    ).split()
    subjects = ft_fixture_git(directory, "log", "--format=%s").strip().split("\n")
    remote = ft_fixture_git(directory, "remote", "get-url", "origin").strip()
    assert sorted(branches) == ["main", "wktr-9-widget-fix"]
    assert subjects == [
        "fix: the widget drops its last field",
        "feat: the first commit subject",
    ]
    assert remote == "git@github.com:acme-org/widgets.git"


def test_the_repo_writes_an_https_remote_when_asked(ft_sandbox):
    """writes an https remote when asked for one"""
    directory = ft_fixture_repo(ft_sandbox.path / "r", "acme-org/widgets", "https")
    assert (
        ft_fixture_git(directory, "remote", "get-url", "origin").strip()
        == "https://github.com/acme-org/widgets.git"
    )


def test_the_repo_has_no_remote_when_asked_for_none(ft_sandbox):
    """leaves the repository without a remote when asked for none"""
    directory = ft_fixture_repo(ft_sandbox.path / "r", "acme-org/widgets", "none")
    assert ft_fixture_git(directory, "remote").strip() == ""


# --- ft_fixture_events -------------------------------------------------------


def test_the_clean_case_is_two_successful_calls(ft_sandbox):
    """gives the clean case two successful Bash calls and nothing else"""
    events = write_events(ft_sandbox, "clean")
    assert [event["event"] for event in events] == ["PostToolUse", "PostToolUse"]
    assert [event["exit_code"] for event in events] == [0, 0]


def test_the_nonzero_case_repeats_one_command_on_two_numbers(ft_sandbox):
    """gives the nonzero case the same failing command twice, on different numbers"""
    events = write_events(ft_sandbox, "nonzero")
    failed = [event["command"] for event in events if event["exit_code"] == 1]
    assert failed == ["gh pr merge --auto --squash 11", "gh pr merge --auto --squash 12"]


def test_the_failure_case_is_a_call_that_failed_outright(ft_sandbox):
    """gives the failure case a tool call that failed outright"""
    events = write_events(ft_sandbox, "failure")
    assert [(event["event"], event["exit_code"]) for event in events] == [
        ("PostToolUseFailure", 127)
    ]


def test_the_denied_case_holds_the_command_the_hook_refused(ft_sandbox):
    """gives the denied case a command the hook refused, with its reason"""
    events = write_events(ft_sandbox, "denied")
    denied = [event for event in events if event["event"] == "denied"]
    assert [event["command"] for event in denied] == ["git push --force origin main"]
    assert denied[0]["reason"]


def test_the_args_used_case_carries_the_option(ft_sandbox):
    """gives the args-used case a call that carries --dry-run"""
    events = write_events(ft_sandbox, "args-used")
    assert len([event for event in events if "--dry-run" in (event["command"] or "")]) == 1


def test_the_preceding_case_has_five_calls_one_running_none(ft_sandbox):
    """gives the preceding case five calls before the failure, one running none"""
    events = write_events(ft_sandbox, "preceding")
    assert [event.get("command") or "-" for event in events] == [
        "git fetch origin",
        "git status --short",
        "gh pr list --state open",
        "gh pr checks 11",
        "-",
        "gh pr merge --auto --squash 11",
    ]


def test_the_null_agent_case_names_no_subagent(ft_sandbox):
    """gives the null-agent case a claim and a failure with no subagent id"""
    events = write_events(ft_sandbox, "null-agent")
    assert [event["agent_id"] for event in events] == [None, None]


def test_the_hook_error_case_has_a_hook_that_raised(ft_sandbox):
    """gives the hook-error case a hook that raised and a call that still ran"""
    events = write_events(ft_sandbox, "hook-error")
    assert [event["event"] for event in events] == ["hook_error", "PostToolUse"]


def test_the_no_command_case_has_a_null_command_and_an_empty_one(ft_sandbox):
    """gives the no-command case a null command and an empty one"""
    events = write_events(ft_sandbox, "no-command")
    assert [event["command"] for event in events] == [None, "", "git push --force origin main"]


def test_the_contradiction_case_holds_an_unresolved_failure(ft_sandbox):
    """gives the contradiction case a failure the subagent never resolved"""
    events = [event for event in write_events(ft_sandbox, "contradiction") if event["agent_id"]]
    assert len([event for event in events if event.get("exit_code") == 1]) == 1
    assert len([event for event in events if event.get("exit_code") == 0]) == 0


def test_the_retried_case_has_the_same_command_succeeding_afterwards(ft_sandbox):
    """gives the retried case the same command succeeding afterwards"""
    events = write_events(ft_sandbox, "retried")
    codes = [event["exit_code"] for event in events if event.get("command") == "bash spec/run.sh"]
    assert codes == [1, 0]


def test_the_status_ok_case_reports_a_status_that_is_not_failed(ft_sandbox):
    """gives the status-ok case a subagent reporting a status that is not failed"""
    events = write_events(ft_sandbox, "status-ok")
    stop = next(event for event in events if event["event"] == "SubagentStop")
    assert '"status": "ok"' in stop["last_assistant_message"]


def test_the_deny_error_case_holds_a_rule_that_did_not_compile(ft_sandbox):
    """gives the deny-error case a rule that did not compile beside a normal call"""
    events = write_events(ft_sandbox, "deny-error")
    broken = [event for event in events if event["event"] == "deny_list_error"]
    assert [event["pattern"] for event in broken] == ["[unclosed"]


def test_the_honest_case_reports_failed(ft_sandbox):
    """gives the honest case a subagent that reports failed"""
    events = write_events(ft_sandbox, "honest")
    stop = next(event for event in events if event["event"] == "SubagentStop")
    assert '"status": "failed"' in stop["last_assistant_message"]


def test_the_mixed_case_has_one_event_of_every_kind(ft_sandbox):
    """gives the mixed case one event of every kind the collector can raise"""
    events = write_events(ft_sandbox, "mixed")
    assert [event["event"] for event in events] == [
        "PostToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "denied",
        "SubagentStop",
    ]


def test_the_events_writer_refuses_a_case_it_does_not_have(ft_sandbox):
    """refuses a case it does not have, rather than writing an empty file"""
    with pytest.raises(KeyError):
        ft_fixture_events(ft_sandbox.path / "e.jsonl", "nosuchcase")


# --- the stub gh -------------------------------------------------------------


def issues_from(result):
    assert result.status == 0, result.stderr
    return json.loads(result.stdout)


def test_the_stub_serves_the_issue_the_duplicate_search_looks_for(run_gh):
    """serves one open field-test issue carrying the signature the specs search for"""
    result = run_gh(
        "issue",
        "list",
        "--repo",
        "acme-org/plugins",
        "--state",
        "open",
        "--label",
        "field-test",
        "--search",
        "bash_nonzero:gh pr merge --auto --squash N",
        "--json",
        "number",
    )
    assert [issue["number"] for issue in issues_from(result)] == [40]


def test_the_stub_serves_an_issue_whose_signature_holds_quotes(run_gh):
    """serves an open field-test issue whose signature holds quotes"""
    result = run_gh(
        "issue",
        "list",
        "--repo",
        "acme-org/plugins",
        "--state",
        "open",
        "--label",
        "field-test",
        "--search",
        'bash_nonzero:gh pr comment -b "done" N',
        "--json",
        "number",
    )
    assert [issue["number"] for issue in issues_from(result)] == [44]


def test_the_stub_keeps_a_closed_issue_out_of_the_open_set(run_gh):
    """keeps a closed issue with the same signature out of the open set"""
    result = run_gh(
        "issue", "list", "--repo", "acme-org/plugins", "--state", "closed", "--json", "number"
    )
    assert [issue["number"] for issue in issues_from(result)] == [42]


def test_the_stub_refuses_a_flag_it_does_not_emulate(run_gh):
    """refuses a flag it does not emulate, so a test cannot pass on a fake answer"""
    result = run_gh("issue", "list", "--repo", "acme-org/plugins", "--author", "someone")
    assert result.status == 64
    assert "unhandled flag" in result.stderr


def test_the_stub_refuses_a_subcommand_it_does_not_emulate(run_gh):
    """refuses a subcommand it does not emulate"""
    result = run_gh("pr", "merge", "11")
    assert result.status == 1
    assert "unsupported" in result.stderr


def test_the_stub_refuses_an_unknown_json_field(run_gh):
    """refuses an unknown --json field the way gh does"""
    result = run_gh("issue", "list", "--repo", "acme-org/plugins", "--json", "nosuchfield")
    assert result.status == 1
    assert "Unknown JSON field" in result.stderr


def test_the_stub_answers_the_enterprise_query_with_both_organizations(run_gh):
    """answers the enterprise query with both organizations by default"""
    result = run_gh(
        "api", "graphql", "-f", "query=query { viewer { enterprises { nodes { slug } } } }"
    )
    assert result.status == 0
    nodes = json.loads(result.stdout)["data"]["viewer"]["enterprises"]["nodes"]
    assert [org["login"] for org in nodes[0]["organizations"]["nodes"]] == [
        "acme-org",
        "acme-tools",
    ]


def test_the_stub_holds_the_second_organization_back_when_paged(ft_sandbox, run_gh):
    """holds the second organization back for the second page in the paged case"""
    ft_fixture_enterprise(ft_sandbox.gh_dir, "paged")
    result = run_gh(
        "api", "graphql", "-f", "query=query { viewer { enterprises { nodes { slug } } } }"
    )
    assert result.status == 0
    organizations = json.loads(result.stdout)["data"]["viewer"]["enterprises"]["nodes"][0][
        "organizations"
    ]
    assert organizations["pageInfo"]["hasNextPage"] is True
    assert [org["login"] for org in organizations["nodes"]] == ["acme-org"]


def test_the_stub_fails_every_call_when_told_to(ft_sandbox, run_gh):
    """fails every call when told to"""
    ft_sandbox.setenv("FT_GH_FIXTURE_FAIL", "1")
    result = run_gh("api", "graphql", "-f", "query=query { viewer { login } }")
    assert result.status == 1
    assert "simulated failure" in result.stderr


def test_the_stub_creates_the_label_only_with_force(run_gh):
    """refuses to create a label that is already there unless --force is given"""
    result = run_gh("label", "create", "field-test", "--repo", "acme-org/plugins")
    assert result.status == 1
    assert "already exists" in result.stderr


# --- ft_fixture_run and the registry fixtures --------------------------------


def test_the_run_marker_has_no_finish_time(ft_sandbox):
    """writes a marker the scripts accept, with no finish time"""
    path = ft_sandbox.path / "run.json"
    ft_fixture_run(path)
    marker = json.loads(path.read_text())
    assert (marker["version"], marker["target"], marker["finished_at"]) == (1, "gh:shepherd", None)


def test_the_installed_plugin_has_the_skill_file_the_resolver_looks_for(ft_sandbox):
    """lays the installed plugin out with the skill file the resolver looks for"""
    assert (ft_sandbox.install_dir / "skills" / "shepherd" / "SKILL.md").is_file()


def test_the_installed_plugin_omits_the_skill_file_when_asked(ft_sandbox):
    """omits the skill file when asked to"""
    other = ft_sandbox.path / "other"
    ft_fixture_installed_plugins(ft_sandbox.installed_plugins, other, "without-skill")
    assert not (other / "skills" / "shepherd" / "SKILL.md").exists()


def test_the_marketplace_source_is_a_directory_by_default(ft_sandbox):
    """names the marketplace source as a directory by default"""
    document = json.loads(ft_sandbox.marketplaces.read_text())
    assert document["bje"]["source"]["source"] == "directory"


# --- ft_fixture_hook_input and ft_fixture_transcript -------------------------


def test_the_failure_payload_has_no_tool_response():
    """gives the failure payload no tool_response, the way the real event has none"""
    payload = json.loads(ft_fixture_hook_input("post-failure"))
    assert "tool_response" not in payload
    assert payload["error"].startswith("Exit code 127")


def test_the_stop_payload_carries_the_targets_last_message():
    """gives the stop payload the target last message, the way a real Stop carries one"""
    payload = json.loads(ft_fixture_hook_input("stop"))
    assert "Rebased and pushed" in payload["last_assistant_message"]


def test_the_hook_payload_writer_refuses_a_case_it_does_not_have():
    """refuses a hook payload case it does not have"""
    with pytest.raises(KeyError):
        ft_fixture_hook_input("nosuchcase")


def test_the_transcript_writer_refuses_a_case_it_does_not_have(ft_sandbox):
    """refuses a transcript case it does not have"""
    with pytest.raises(KeyError):
        ft_fixture_transcript(ft_sandbox.path / "t.jsonl", "nosuchcase")


def test_the_tool_tail_transcript_ends_on_a_turn_with_no_text(ft_sandbox):
    """writes a transcript whose last assistant turn carries no text of its own"""
    path = ft_sandbox.path / "t.jsonl"
    ft_fixture_transcript(path, "tool-tail")
    last = json.loads(path.read_text().strip().split("\n")[-1])
    assert [block["type"] for block in last["message"]["content"]] == ["thinking", "tool_use"]


def test_the_with_report_transcript_ends_on_the_report(ft_sandbox):
    """writes a transcript whose last assistant turn is the report"""
    path = ft_sandbox.path / "t.jsonl"
    ft_fixture_transcript(path, "with-report")
    records = [json.loads(line) for line in path.read_text().split("\n") if line.strip()]
    last = [record for record in records if record["type"] == "assistant"][-1]
    assert "| #11 | merged |" in last["message"]["content"][0]["text"]
