"""Claims the workstreams fixtures make about themselves.

The other workstreams tests rely on these shapes, so they are asserted here
rather than assumed there. Ported one for one from the 27 examples in
`spec/workstreams/fixtures_spec.sh`, whose `It` description each test carries in
its docstring; that spec stays until nothing bash reads the shell fixtures.

The tests that pass `--jq` run real jq through the stub, exactly as the shell
stub did, which is the point of that flag: the expression is the caller's.
"""

from __future__ import annotations

import json
import re

from conftest import (
    ws_fixture_extensions,
    ws_fixture_home,
    ws_fixture_installed_plugins,
)


def output_json(result):
    assert result.status == 0, result.stderr
    return json.loads(result.stdout)


def issues(ws_sandbox):
    return json.loads((ws_sandbox.gh_dir / "issues.json").read_text(encoding="utf-8"))


def prs(ws_sandbox):
    return json.loads((ws_sandbox.gh_dir / "prs.json").read_text(encoding="utf-8"))


# --- issues.json --------------------------------------------------------------


def test_issues_hold_seven_records(ws_sandbox):
    """holds seven records: six issues, one of them closed, and one pull request"""
    records = issues(ws_sandbox)
    assert len(records) == 7
    assert [record["number"] for record in records if record["state"] == "CLOSED"] == [5]
    assert [record["number"] for record in records if "/pull/" in record["url"]] == [7]


def test_issue_one_references_two_and_four_and_issue_two_has_no_body(ws_sandbox):
    """gives issue 1 references to #2 and #4, and issue 2 a null body"""
    records = issues(ws_sandbox)
    assert "#2" in records[0]["body"]
    assert "#4" in records[0]["body"]
    assert records[1]["body"] is None


def test_issue_three_mentions_itself_and_issue_one_twice(ws_sandbox):
    """has issue 3 mention itself and mention #1 twice"""
    body = issues(ws_sandbox)[2]["body"]
    assert "#3" in body
    assert len(re.findall(r"#1\b", body)) == 2


def test_only_issue_four_is_in_the_observe_milestone(ws_sandbox):
    """puts only issue 4 in the observe milestone"""
    records = issues(ws_sandbox)
    assert [
        record["number"]
        for record in records
        if (record["milestone"] or {}).get("title") == "observe"
    ] == [4]


def test_issue_six_has_a_seven_only_inside_a_url(ws_sandbox):
    """gives issue 6 a #7 only inside a url"""
    body = issues(ws_sandbox)[5]["body"]
    assert "/#7" in body
    assert re.search(r"(^|[^A-Za-z0-9/])#7", body) is None


# --- prs.json -----------------------------------------------------------------


def test_prs_cover_open_drafts_a_ready_pr_and_a_merged_pr(ws_sandbox):
    """covers open drafts, a ready PR, and a merged PR"""
    assert [[pr["state"], pr["isDraft"]] for pr in prs(ws_sandbox) if pr["number"] <= 14] == [
        ["OPEN", True],
        ["OPEN", True],
        ["OPEN", True],
        ["OPEN", False],
        ["MERGED", False],
    ]


def test_pr_twelve_is_stacked_on_the_branch_of_pr_ten(ws_sandbox):
    """stacks PR 12 on the branch of PR 10"""
    by_number = {pr["number"]: pr for pr in prs(ws_sandbox)}
    assert by_number[12]["baseRefName"] == by_number[10]["headRefName"]


def test_one_pr_per_check_conclusion_the_fold_distinguishes(ws_sandbox):
    """carries one PR per check conclusion the fold distinguishes"""
    seen = {
        check.get("conclusion") or check.get("state") or "null"
        for pr in prs(ws_sandbox)
        for check in pr["statusCheckRollup"]
    }
    assert sorted(seen) == [
        "CANCELLED",
        "FAILURE",
        "NEUTRAL",
        "PENDING",
        "SKIPPED",
        "STALE",
        "SUCCESS",
        "null",
    ]


def test_pr_thirteen_has_no_checks_and_pr_fourteen_only_a_status_context(ws_sandbox):
    """has PR 13 with no checks and PR 14 with only a StatusContext"""
    by_number = {pr["number"]: pr for pr in prs(ws_sandbox)}
    assert by_number[13]["statusCheckRollup"] == []
    assert [check["__typename"] for check in by_number[14]["statusCheckRollup"]] == [
        "StatusContext"
    ]


# --- the gh stub --------------------------------------------------------------


def test_reports_the_fixture_repository_by_default(ws_sandbox, run_gh):
    """reports the fixture repository by default"""
    result = run_gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
    assert result.status == 0
    assert result.stdout.strip() == "bje-settings/example"


def test_honours_the_fixture_repo_variable(ws_sandbox, run_gh):
    """honours WS_GH_FIXTURE_REPO"""
    ws_sandbox.setenv("WS_GH_FIXTURE_REPO", "acme/widgets")
    result = run_gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner")
    assert result.status == 0
    assert result.stdout.strip() == "acme/widgets"


def test_filters_issue_list_the_way_gh_does(ws_sandbox, run_gh):
    """filters issue list by state, label, and milestone the way gh does"""
    result = run_gh("issue", "list", "--state", "open", "--label", "bug", "--json", "number")
    assert [issue["number"] for issue in output_json(result)] == [1]
    result = run_gh(
        "issue", "list", "--state", "open", "--milestone", "observe", "--json", "number"
    )
    assert [issue["number"] for issue in output_json(result)] == [4]


def test_matches_search_against_title_and_body_case_insensitively(ws_sandbox, run_gh):
    """matches --search against title and body, case-insensitively"""
    result = run_gh("issue", "list", "--state", "open", "--search", "LINTER", "--json", "number")
    assert [issue["number"] for issue in output_json(result)] == [2]


def test_applies_limit(ws_sandbox, run_gh):
    """applies --limit"""
    result = run_gh("issue", "list", "--state", "all", "--limit", "2", "--json", "number")
    assert [issue["number"] for issue in output_json(result)] == [1, 2]


def test_rejects_a_flag_it_does_not_emulate(ws_sandbox, run_gh):
    """rejects a flag it does not emulate rather than ignoring it"""
    result = run_gh("issue", "list", "--assignee", "me", "--json", "number")
    assert result.status == 64
    assert "unhandled flag: --assignee" in result.stderr


def test_projects_to_exactly_the_json_fields_asked_for(ws_sandbox, run_gh):
    """projects to exactly the --json fields asked for"""
    result = run_gh("issue", "view", "1", "--json", "number,title")
    assert sorted(output_json(result)) == ["number", "title"]


def test_rejects_a_json_field_that_does_not_exist(ws_sandbox, run_gh):
    """rejects a --json field that does not exist, like real gh"""
    result = run_gh("pr", "view", "10", "--json", "number,isDrft")
    assert result.status == 1
    assert 'Unknown JSON field: "isDrft"' in result.stderr


def test_fails_when_the_jq_expression_fails(ws_sandbox, run_gh):
    """fails when the --jq expression fails"""
    result = run_gh("repo", "view", "--json", "nameWithOwner", "--jq", "bad(")
    assert result.status == 1
    assert "compile error" in result.stderr


def test_rejects_a_second_positional_argument(ws_sandbox, run_gh):
    """rejects a second positional argument"""
    result = run_gh("issue", "view", "1", "2", "--json", "number")
    assert result.status == 1
    assert "unexpected second argument: 2" in result.stderr


def test_rejects_a_subcommand_it_does_not_emulate(ws_sandbox, run_gh):
    """rejects a subcommand it does not emulate"""
    result = run_gh("api", "graphql")
    assert result.status == 1
    assert "unsupported: api graphql" in result.stderr


def test_fails_every_call_when_the_fail_variable_is_set(ws_sandbox, run_gh):
    """fails every call when WS_GH_FIXTURE_FAIL is set"""
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = run_gh("auth", "status")
    assert result.status == 1
    assert "simulated failure" in result.stderr


def test_auth_status_reports_a_login_and_can_be_made_to_fail(ws_sandbox, run_gh):
    """serves auth status, and fails it under WS_GH_FIXTURE_NOAUTH

    Not in the shell spec, which asserted the NOAUTH switch only through
    ws-preflight.sh; the stub owns the behaviour, so the claim belongs here.
    """
    assert "Logged in" in run_gh("auth", "status").stdout
    ws_sandbox.setenv("WS_GH_FIXTURE_NOAUTH", "1")
    result = run_gh("auth", "status")
    assert result.status == 1
    assert "not logged into any GitHub hosts" in result.stderr


def test_serves_empty_sets_when_a_fixture_file_is_missing(ws_sandbox, run_gh):
    """serves empty sets when the fixture directory is missing a file"""
    (ws_sandbox.gh_dir / "extensions.txt").unlink()
    result = run_gh("extension", "list")
    assert result.status == 0
    assert result.stdout == ""


def test_reports_a_corrupt_fixture_as_a_read_failure(ws_sandbox, run_gh):
    """reports a corrupt fixture as a jq failure, not as not-found

    The message is the stub's own now that nothing shells out to jq to read the
    file, but the claim is the same: a corrupt fixture must not read as "no such
    issue".
    """
    (ws_sandbox.gh_dir / "issues.json").write_text("{oops", encoding="utf-8")
    result = run_gh("issue", "view", "1", "--json", "number")
    assert result.status == 1
    assert "cannot read issues.json" in result.stderr
    assert "Could not resolve" not in result.stderr


def test_accepts_a_pull_request_by_number_hash_or_url(ws_sandbox, run_gh):
    """accepts a pull request by number, #number, or url"""
    for reference in ("13", "#13", "https://example.invalid/p/13"):
        result = run_gh("pr", "view", reference, "--json", "number")
        assert output_json(result)["number"] == 13


# --- home and plugin fixtures -------------------------------------------------


def test_lays_out_the_gh_stack_skill_where_gh_skill_install_puts_it(ws_sandbox):
    """lays out the gh-stack skill where gh skill install puts it"""
    assert (ws_sandbox.home / ".claude" / "skills" / "gh-stack" / "SKILL.md").is_file()


def test_lists_extensions_tab_separated_with_the_repo_second(ws_sandbox):
    """lists extensions tab-separated with the repo in the second column"""
    lines = (ws_sandbox.gh_dir / "extensions.txt").read_text(encoding="utf-8").splitlines()
    assert [line.split("\t")[1] for line in lines] == ["github/gh-stack", "dlvhdr/gh-dash"]


def test_can_omit_the_skill_and_the_review_plugin(ws_sandbox):
    """can omit the skill and the review plugin, and offers a near-miss extension name"""
    ws_fixture_home(ws_sandbox.path / "bare", "without-skill")
    ws_fixture_installed_plugins(ws_sandbox.path / "bare.json", "without-review")
    ws_fixture_extensions(ws_sandbox.path / "ext.txt", "without-stack")
    assert not (ws_sandbox.path / "bare" / ".claude" / "skills" / "gh-stack").exists()
    plugins = json.loads((ws_sandbox.path / "bare.json").read_text(encoding="utf-8"))["plugins"]
    assert list(plugins) == ["gh@bje"]
    extensions = (ws_sandbox.path / "ext.txt").read_text(encoding="utf-8")
    assert "github/gh-stack-anything" in extensions
    assert "\tgithub/gh-stack\t" not in extensions
