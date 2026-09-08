"""Black-box tests for ft-harden-state.py.

Ported from `spec/field-test/harden_state_spec.sh`. Every example runs the script
as its own process and reads the resulting state file back, because what is being
checked is the file on disk and the exit status, not a return value. "requires
jq" did not come across; there is no jq to require.

The state file is what a resumed session reads, so the tests that matter most
are the refusals: a run this would have thrown away, a write that could not
land, and a field a typo would otherwise have invented.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FT_HARDEN_STATE

pytestmark = pytest.mark.usefixtures("ft_sandbox")


@pytest.fixture
def state(ft_sandbox, run_script):
    """The script under test, plus readers for the file it writes."""

    class State:
        path = ft_sandbox.harden_state

        def run(self, *args):
            return run_script(FT_HARDEN_STATE, *args)

        def init(self, *args):
            assert self.run("init", "gh:shepherd", *args).status == 0

        def add(self, path, *args):
            assert self.run("add-target", "gh:shepherd", path, *args).status == 0

        def set(self, path, field, value, *args):
            return self.run("set", "gh:shepherd", path, field, value, *args)

        def document(self):
            return json.loads(self.path.read_text(encoding="utf-8"))

        def targets(self):
            return self.document()["targets"]

        def field(self, name, index=0):
            return self.targets()[index][name]

        def one_target(self):
            self.init()
            self.add("/repos/widgets")

        def two_targets(self):
            self.one_target()
            self.add("/repos/gadgets")

    return State()


# --- location ----------------------------------------------------------------


def test_derives_the_path_from_the_skill_under_the_state_dir(state):
    """derives the path from the skill under the state dir"""
    result = state.run("path", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == f"{state.path}\n"


def test_falls_back_to_claude_plugin_data(ft_sandbox, run_script):
    """falls back to CLAUDE_PLUGIN_DATA when FT_STATE_DIR is unset"""
    ft_sandbox.delenv("FT_STATE_DIR")
    ft_sandbox.setenv("CLAUDE_PLUGIN_DATA", ft_sandbox.path / "data")
    result = run_script(FT_HARDEN_STATE, "path", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == f"{ft_sandbox.path / 'data'}/harden/gh__shepherd.json\n"


def test_refuses_to_guess_a_location_when_neither_is_set(ft_sandbox, run_script):
    """refuses to guess a location when neither is set"""
    ft_sandbox.delenv("FT_STATE_DIR")
    result = run_script(FT_HARDEN_STATE, "path", "gh:shepherd")
    assert result.status == 2
    assert "CLAUDE_PLUGIN_DATA" in result.stderr


def test_needs_a_target_skill(state):
    """needs a target skill"""
    result = state.run("path")
    assert result.status == 2
    assert "needs a <plugin:skill> target" in result.stderr


def test_rejects_a_target_that_is_not_plugin_skill(state):
    """rejects a target that is not plugin:skill"""
    result = state.run("path", "shepherd")
    assert result.status == 2
    assert "must be plugin:skill" in result.stderr


# --- usage -------------------------------------------------------------------


def test_prints_usage_for_help(state):
    """prints usage for --help"""
    result = state.run("--help")
    assert result.status == 0
    assert "ft-harden-state.py init" in result.stdout


def test_exits_2_with_usage_when_given_no_command(state):
    """exits 2 with usage when given no command"""
    result = state.run()
    assert result.status == 2
    assert "ft-harden-state.py init" in result.stderr


def test_rejects_an_unknown_command(state):
    """rejects an unknown command"""
    result = state.run("restart", "gh:shepherd")
    assert result.status == 2
    assert "unknown command: restart" in result.stderr


def test_path_rejects_a_stray_argument(state):
    """a third word after the target is a typo, not a question to answer"""
    result = state.run("path", "gh:shepherd", "extra")
    assert result.status == 2
    assert "path: unknown argument: extra" in result.stderr


def test_show_rejects_a_stray_argument(state):
    """the same, for show"""
    state.one_target()
    result = state.run("show", "gh:shepherd", "extra")
    assert result.status == 2
    assert "show: unknown argument: extra" in result.stderr


# --- init --------------------------------------------------------------------


def test_writes_an_empty_run_sized_opus_and_high_by_default(state):
    """writes an empty run sized opus and high by default"""
    result = state.run("init", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == f"{state.path}\n"
    document = state.document()
    assert document["version"] == 1
    assert document["skill"] == "gh:shepherd"
    assert (document["model"], document["effort"]) == ("opus", "high")
    assert document["targets"] == []


def test_takes_a_model_and_effort(state):
    """takes a model and effort"""
    result = state.run("init", "gh:shepherd", "--model", "sonnet", "--effort", "medium")
    assert result.status == 0
    assert "gh__shepherd.json" in result.stdout
    document = state.document()
    assert (document["model"], document["effort"]) == ("sonnet", "medium")


def test_rejects_a_model_outside_the_list(state):
    """rejects a model outside the list"""
    result = state.run("init", "gh:shepherd", "--model", "gpt")
    assert result.status == 2
    assert "model must be one of" in result.stderr


def test_rejects_an_effort_outside_the_list(state):
    """rejects an effort outside the list"""
    result = state.run("init", "gh:shepherd", "--effort", "extreme")
    assert result.status == 2
    assert "effort must be low, medium, or high" in result.stderr


def test_init_rejects_an_unknown_argument(state):
    """rejects an unknown argument"""
    result = state.run("init", "gh:shepherd", "--resume")
    assert result.status == 2
    assert "unknown argument: --resume" in result.stderr


def test_init_rejects_a_flag_with_no_value(state):
    """rejects a flag with no value"""
    result = state.run("init", "gh:shepherd", "--model")
    assert result.status == 2
    assert "--model needs a value" in result.stderr


def test_refuses_to_throw_away_a_run_in_progress(state):
    """refuses to throw away a run in progress"""
    state.one_target()
    result = state.run("init", "gh:shepherd")
    assert result.status == 3
    assert "--force to start over" in result.stderr
    assert len(state.targets()) == 1


def test_starts_over_with_force(state):
    """starts over with --force"""
    state.one_target()
    result = state.run("init", "gh:shepherd", "--force")
    assert result.status == 0
    assert "gh__shepherd.json" in result.stdout
    assert state.targets() == []


def test_reports_a_state_directory_it_cannot_create(ft_sandbox, run_script):
    """reports a state directory it cannot create"""
    blocked = ft_sandbox.path / "blocked"
    blocked.write_text("", encoding="utf-8")
    ft_sandbox.setenv("FT_STATE_DIR", blocked)
    result = run_script(FT_HARDEN_STATE, "init", "gh:shepherd")
    assert result.status == 1
    assert "cannot create" in result.stderr


# --- lifecycle: finished and archive -----------------------------------------


def archive_dir(state):
    return state.path.parent / "archive"


def archived(state):
    directory = archive_dir(state)
    return sorted(path.name for path in directory.glob("*.json")) if directory.is_dir() else []


def archived_document(state):
    files = sorted(archive_dir(state).glob("*.json"))
    assert len(files) == 1, files
    return json.loads(files[0].read_text(encoding="utf-8"))


def test_finished_says_nothing_and_exits_0_when_every_target_is_terminal(state):
    state.two_targets()
    assert state.set("/repos/widgets", "status", "done").status == 0
    assert state.set("/repos/gadgets", "status", "failed").status == 0
    result = state.run("finished", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == ""


def test_finished_exits_1_while_a_target_is_paused(state):
    """A paused target is waiting on a person, so the run is not over."""
    state.one_target()
    assert state.set("/repos/widgets", "status", "paused").status == 0
    result = state.run("finished", "gh:shepherd")
    assert result.status == 1
    assert "is not finished" in result.stderr
    assert result.stdout == ""


def test_finished_exits_1_with_a_message_when_there_is_no_run(state):
    result = state.run("finished", "gh:shepherd")
    assert result.status == 1
    assert "run init first" in result.stderr
    assert result.stdout == ""


def test_finished_rejects_a_stray_argument(state):
    state.init()
    result = state.run("finished", "gh:shepherd", "--force")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_archive_moves_a_finished_run_and_prints_where_it_went(state):
    state.one_target()
    assert state.set("/repos/widgets", "status", "done").status == 0
    before = state.document()
    result = state.run("archive", "gh:shepherd")
    assert result.status == 0
    assert not state.path.exists()
    moved = result.stdout.strip()
    assert moved == str(archive_dir(state) / archived(state)[0])
    assert json.loads(open(moved, encoding="utf-8").read()) == before


def test_archive_refuses_a_run_in_progress_and_leaves_it_where_it_is(state):
    """The refusing half of a destructive command, beside the acting half above."""
    state.one_target()
    before = state.path.read_text(encoding="utf-8")
    result = state.run("archive", "gh:shepherd")
    assert result.status == 3
    assert "pass --force" in result.stderr
    assert state.path.read_text(encoding="utf-8") == before
    assert archived(state) == []


def test_archive_moves_a_run_in_progress_with_force(state):
    state.one_target()
    assert state.run("archive", "gh:shepherd", "--force").status == 0
    assert not state.path.exists()
    assert archived_document(state)["targets"][0]["status"] == "pending"


def test_archive_rejects_an_unknown_argument(state):
    state.init()
    result = state.run("archive", "gh:shepherd", "--now")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_archive_reports_an_archive_directory_it_cannot_create(state):
    state.init()
    archive_dir(state).write_text("", encoding="utf-8")
    result = state.run("archive", "gh:shepherd")
    assert result.status == 1
    assert "cannot create" in result.stderr
    assert state.path.is_file()


def test_archive_reports_a_move_it_could_not_make(state):
    """A directory already standing where the archived run would go.

    The run stays where it is: a move that could not be made must not read as one
    that was, or the next `init` starts over a run still in progress.
    """
    state.one_target()
    assert state.set("/repos/widgets", "status", "done").status == 0
    created = state.document()["created"].replace(":", "-")
    blocker = archive_dir(state) / f"gh__shepherd.{created}.json"
    blocker.mkdir(parents=True)
    (blocker / "occupied").write_text("", encoding="utf-8")
    result = state.run("archive", "gh:shepherd")
    assert result.status == 1
    assert "cannot archive" in result.stderr
    assert state.path.is_file()


def test_archive_refuses_a_destination_that_is_already_a_file(state):
    """An archive already filed under this name is not this command's to replace.

    The name is the skill and the run's `created` second, which two runs can
    share, and os.replace would overwrite the earlier one silently. Both files
    survive instead.
    """
    state.one_target()
    assert state.set("/repos/widgets", "status", "done").status == 0
    created = state.document()["created"].replace(":", "-")
    occupied = archive_dir(state) / f"gh__shepherd.{created}.json"
    occupied.parent.mkdir(parents=True)
    occupied.write_text('{"an": "earlier run"}', encoding="utf-8")
    before = state.path.read_text(encoding="utf-8")
    result = state.run("archive", "gh:shepherd")
    assert result.status == 1
    assert "already exists" in result.stderr
    assert state.path.read_text(encoding="utf-8") == before
    assert occupied.read_text(encoding="utf-8") == '{"an": "earlier run"}'


def test_init_archives_a_finished_run_and_starts_a_new_one(state):
    """A hardening run that is over no longer has to be forced out of the way."""
    state.one_target()
    assert state.set("/repos/widgets", "status", "done").status == 0
    before = state.document()
    result = state.run("init", "gh:shepherd")
    assert result.status == 0
    assert "archived the finished run to" in result.stderr
    assert state.targets() == []
    assert archived_document(state) == before


def test_init_force_archives_the_run_it_replaces(state):
    """--force keeps what it replaces: the run is gone from where the skill looks
    for it, not gone from disk."""
    state.one_target()
    result = state.run("init", "gh:shepherd", "--force")
    assert result.status == 0
    assert "archived the unfinished run to" in result.stderr
    assert state.targets() == []
    assert archived_document(state)["targets"][0]["path"] == "/repos/widgets"


def test_init_force_archives_a_file_it_could_not_parse(state):
    """A file another tool left at the path is still not this script's to destroy."""
    state.init()
    state.path.write_text("{not json at all", encoding="utf-8")
    result = state.run("init", "gh:shepherd", "--force")
    assert result.status == 0
    assert "archived the unfinished run to" in result.stderr
    assert [
        path.read_text(encoding="utf-8") for path in sorted(archive_dir(state).glob("*.json"))
    ] == ["{not json at all"]


# --- add-target --------------------------------------------------------------


def test_appends_a_target_ready_for_its_first_phase(state):
    """appends a target ready for its first phase"""
    state.init()
    result = state.run("add-target", "gh:shepherd", "/repos/widgets", "--repo", "acme-org/widgets")
    assert result.status == 0
    assert state.field("status") == "pending"
    assert state.field("phase") == "field-test"
    assert state.field("repo") == "acme-org/widgets"


def test_keeps_the_order_it_was_given(state):
    """keeps the order it was given, because the order is the plan"""
    state.two_targets()
    assert [target["path"] for target in state.targets()] == ["/repos/widgets", "/repos/gadgets"]


def test_ignores_a_path_that_is_already_listed(state):
    """ignores a path that is already listed rather than duplicating it"""
    state.one_target()
    result = state.run("add-target", "gh:shepherd", "/repos/widgets")
    assert result.status == 0
    assert len(state.targets()) == 1


def test_leaves_the_repo_null_when_it_was_not_given_one(state):
    """leaves the repo null when it was not given one"""
    state.one_target()
    assert state.field("repo") is None


def test_add_target_needs_a_path(state):
    """needs a path"""
    state.init()
    result = state.run("add-target", "gh:shepherd")
    assert result.status == 2
    assert "needs a repository path" in result.stderr


def test_add_target_rejects_an_unknown_argument(state):
    """rejects an unknown argument"""
    state.init()
    result = state.run("add-target", "gh:shepherd", "/repos/widgets", "--now")
    assert result.status == 2
    assert "unknown argument: --now" in result.stderr


def test_add_target_refuses_before_init(state):
    """refuses before init, rather than writing a state file of its own"""
    result = state.run("add-target", "gh:shepherd", "/repos/widgets")
    assert result.status == 1
    assert "run init first" in result.stderr
    assert not state.path.exists()


def test_add_target_refuses_a_state_file_that_is_not_field_test_json(state):
    """refuses a state file that is not field-test JSON"""
    state.init()
    state.path.write_text('{"nope": true}', encoding="utf-8")
    result = state.run("add-target", "gh:shepherd", "/repos/widgets")
    assert result.status == 1
    assert "not valid field-test JSON" in result.stderr


@pytest.mark.skipif(os.geteuid() == 0, reason="running as root, permissions do not apply")
def test_refuses_a_state_file_it_cannot_open_by_naming_that(state):
    """names a file it could not open as unreadable, not as JSON it disagreed with

    "not valid field-test JSON" sends the reader to the contents of a file they
    were never able to open; the fix here is a permission.
    """
    state.one_target()
    state.path.chmod(0o000)
    try:
        result = state.run("next", "gh:shepherd")
    finally:
        state.path.chmod(0o600)
    assert result.status == 1
    assert f"cannot read {state.path}" in result.stderr
    assert "not valid field-test JSON" not in result.stderr


def test_add_target_refuses_a_state_file_that_is_not_json_at_all(state):
    """a half-written file reports as unreadable rather than as a traceback"""
    state.init()
    state.path.write_text("{", encoding="utf-8")
    result = state.run("add-target", "gh:shepherd", "/repos/widgets")
    assert result.status == 1
    assert "not valid field-test JSON" in result.stderr


# --- set ---------------------------------------------------------------------


def test_records_a_phase_transition(state):
    """records a phase transition"""
    state.one_target()
    assert state.set("/repos/widgets", "phase", "fix").status == 0
    assert state.field("phase") == "fix"


def test_stores_the_pull_request_as_a_number(state):
    """stores the pull request as a number without being told"""
    state.one_target()
    assert state.set("/repos/widgets", "pr", "44").status == 0
    assert state.field("pr") == 44


def test_clears_the_pull_request_back_to_null(state):
    """clears the pull request back to null"""
    state.one_target()
    state.set("/repos/widgets", "pr", "44")
    assert state.set("/repos/widgets", "pr", "null").status == 0
    assert state.field("pr") is None


def test_counts_the_review_rounds_as_a_number(state):
    """the review phase bounds itself at one repeat, and a resumed session reads
    the count from the state file rather than starting over"""
    state.one_target()
    assert state.field("review_rounds") is None
    assert state.set("/repos/widgets", "review_rounds", "1").status == 0
    assert state.field("review_rounds") == 1


def test_rejects_a_review_round_count_that_is_not_a_number(state):
    """rejects a count written as a word, which would compare against a number"""
    state.one_target()
    result = state.set("/repos/widgets", "review_rounds", "once")
    assert result.status == 2
    assert "review_rounds takes a number or null" in result.stderr


def test_rejects_a_pull_request_that_is_not_a_number(state):
    """rejects a pull request that is not a number"""
    state.one_target()
    result = state.set("/repos/widgets", "pr", "forty-four")
    assert result.status == 2
    assert "pr takes a number or null" in result.stderr


def test_stores_the_issues_as_a_json_array(state):
    """stores the issues as a JSON array"""
    state.one_target()
    assert state.set("/repos/widgets", "issues", "[25,32]").status == 0
    assert state.field("issues") == [25, 32]


def test_rejects_invalid_json_and_leaves_the_target_alone(state):
    """rejects invalid JSON and leaves the target alone"""
    state.one_target()
    result = state.set("/repos/widgets", "issues", "[25,")
    assert result.status == 2
    assert "not valid JSON" in result.stderr
    assert state.field("issues") == []


def test_validates_the_status(state):
    """validates the status"""
    state.one_target()
    result = state.set("/repos/widgets", "status", "finished")
    assert result.status == 2
    assert "invalid status" in result.stderr


def test_validates_the_phase(state):
    """validates the phase"""
    state.one_target()
    result = state.set("/repos/widgets", "phase", "merging")
    assert result.status == 2
    assert "invalid phase" in result.stderr


def test_rejects_a_field_outside_the_schema(state):
    """rejects a field outside the schema, so a typo cannot create one"""
    state.one_target()
    result = state.set("/repos/widgets", "stauts", "done")
    assert result.status == 2
    assert "unknown field: stauts" in result.stderr


def test_rejects_a_fourth_argument_other_than_json(state):
    """rejects a fourth argument other than --json"""
    state.one_target()
    result = state.set("/repos/widgets", "summary", "text", "--force")
    assert result.status == 2
    assert "unknown argument: --force" in result.stderr


def test_set_needs_three_arguments(state):
    """needs three arguments"""
    state.one_target()
    result = state.run("set", "gh:shepherd", "/repos/widgets", "status")
    assert result.status == 2
    assert "set needs" in result.stderr


def test_rejects_two_statuses_in_one_value(state):
    """rejects two statuses in one value, which would match the list and be skipped by next"""
    state.one_target()
    result = state.set("/repos/widgets", "status", "pending done")
    assert result.status == 2
    assert "invalid status" in result.stderr


def test_rejects_a_phase_with_a_space_in_it(state):
    """rejects a phase with a space in it"""
    state.one_target()
    result = state.set("/repos/widgets", "phase", "fix review")
    assert result.status == 2
    assert "invalid phase" in result.stderr


def test_rejects_issues_that_are_valid_json_but_not_an_array(state):
    """rejects issues that are valid JSON but not an array"""
    state.one_target()
    result = state.set("/repos/widgets", "issues", '{"a": 1}')
    assert result.status == 2
    assert "issues takes a JSON array" in result.stderr


def test_fails_for_a_target_that_was_never_added(state):
    """fails for a target that was never added"""
    state.one_target()
    result = state.set("/repos/gadgets", "status", "done")
    assert result.status == 1
    assert "unknown target" in result.stderr


def test_leaves_no_temp_file_behind(state):
    """leaves no temp file behind"""
    state.one_target()
    assert state.set("/repos/widgets", "status", "running").status == 0
    assert [entry.name for entry in state.path.parent.iterdir() if ".tmp." in entry.name] == []


def test_keeps_the_old_state_when_the_update_cannot_be_written(state):
    """keeps the old state when the update cannot be written"""
    state.one_target()
    directory = state.path.parent
    os.chmod(directory, 0o500)
    try:
        result = state.set("/repos/widgets", "status", "done")
    finally:
        os.chmod(directory, 0o700)
    assert result.status == 1
    assert "cannot write" in result.stderr
    assert state.field("status") == "pending"


def test_stores_a_summary_holding_a_non_ascii_character(state):
    """a summary is text the target wrote, and it is written back as it came"""
    state.one_target()
    assert state.set("/repos/widgets", "summary", "the café target is clean").status == 0
    assert state.field("summary") == "the café target is clean"


# --- bump --------------------------------------------------------------------


def test_bump_adds_one_and_prints_the_new_value(state):
    """The harden skill counts review rounds through this rather than by hand.

    Reading the count, adding one, and writing it back puts the arithmetic in
    the skill, where a tick that stopped between the read and the write leaves
    the count behind by one and the next round repeats a review already run.
    """
    state.one_target()
    result = state.run("bump", "gh:shepherd", "/repos/widgets", "review_rounds")
    assert result.status == 0
    assert result.stdout == "1\n"
    assert state.field("review_rounds") == 1
    assert state.run("bump", "gh:shepherd", "/repos/widgets", "review_rounds").stdout == "2\n"
    assert state.field("review_rounds") == 2


def test_bump_counts_from_zero_when_the_field_is_null(state):
    """add-target writes review_rounds as null, and null is not one round."""
    state.one_target()
    assert state.field("review_rounds") is None
    assert state.run("bump", "gh:shepherd", "/repos/widgets", "review_rounds").stdout == "1\n"


def test_bump_touches_only_the_target_it_was_given(state):
    state.two_targets()
    assert state.run("bump", "gh:shepherd", "/repos/gadgets", "pr").status == 0
    assert state.field("pr", 0) is None
    assert state.field("pr", 1) == 1


def test_bump_refuses_a_field_that_does_not_hold_a_number(state):
    state.one_target()
    result = state.run("bump", "gh:shepherd", "/repos/widgets", "status")
    assert result.status == 2
    assert "not a numeric field" in result.stderr
    assert state.field("status") == "pending"


def test_bump_refuses_a_field_outside_the_schema(state):
    """The same guard `set` has: a typo must not invent a field."""
    state.one_target()
    result = state.run("bump", "gh:shepherd", "/repos/widgets", "rounds")
    assert result.status == 2
    assert "unknown field: rounds" in result.stderr
    assert "rounds" not in state.targets()[0]


def test_bump_refuses_a_target_that_was_never_added(state):
    state.one_target()
    result = state.run("bump", "gh:shepherd", "/repos/gadgets", "review_rounds")
    assert result.status == 1
    assert "bump: unknown target: /repos/gadgets" in result.stderr


def test_bump_needs_a_target_and_a_field(state):
    state.one_target()
    for arguments in (
        ("bump", "gh:shepherd"),
        ("bump", "gh:shepherd", "/repos/widgets"),
        ("bump", "gh:shepherd", "/repos/widgets", "review_rounds", "2"),
    ):
        result = state.run(*arguments)
        assert result.status == 2, arguments
        assert "bump needs <path> <numeric-field>" in result.stderr


def test_bump_leaves_the_state_alone_when_the_field_holds_something_else(state):
    """A state file written by something else is not this script's to overwrite."""
    state.one_target()
    document = state.document()
    document["targets"][0]["review_rounds"] = "two"
    state.path.write_text(json.dumps(document), encoding="utf-8")
    result = state.run("bump", "gh:shepherd", "/repos/widgets", "review_rounds")
    assert result.status == 1
    assert "review_rounds is not a number on /repos/widgets" in result.stderr
    assert state.field("review_rounds") == "two"


def test_bump_refuses_a_run_that_does_not_exist(state):
    state.one_target()
    result = state.run("bump", "workstreams:run", "/repos/widgets", "review_rounds")
    assert result.status == 1
    assert "run init first" in result.stderr


# --- next and show -----------------------------------------------------------


def test_prints_the_first_target_still_to_do(state):
    """prints the first target still to do"""
    state.two_targets()
    result = state.run("next", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == "/repos/widgets\n"


def test_moves_on_once_a_target_is_done(state):
    """moves on once a target is done"""
    state.two_targets()
    state.set("/repos/widgets", "status", "done")
    assert state.run("next", "gh:shepherd").stdout == "/repos/gadgets\n"


def test_steps_over_a_target_that_failed(state):
    """steps over a target that failed"""
    state.two_targets()
    state.set("/repos/widgets", "status", "failed")
    assert state.run("next", "gh:shepherd").stdout == "/repos/gadgets\n"


def test_returns_a_target_still_running(state):
    """returns a target still running, so a session that stopped mid-target resumes it"""
    state.two_targets()
    state.set("/repos/widgets", "status", "running")
    assert state.run("next", "gh:shepherd").stdout == "/repos/widgets\n"


def test_still_returns_a_paused_target(state):
    """still returns a paused target, so its question is not stepped over"""
    state.two_targets()
    state.set("/repos/widgets", "status", "paused")
    assert state.run("next", "gh:shepherd").stdout == "/repos/widgets\n"


def test_prints_nothing_when_every_target_is_finished(state):
    """prints nothing when every target is finished"""
    state.two_targets()
    state.set("/repos/widgets", "status", "done")
    state.set("/repos/gadgets", "status", "done")
    result = state.run("next", "gh:shepherd")
    assert result.status == 0
    assert result.stdout == ""


def test_next_refuses_a_target_whose_status_it_cannot_read(state):
    """refuses a hand-edited status rather than reading as "everything finished"

    `set` will not write this, but a hand edit or a half-applied patch does, and
    a status outside the vocabulary is neither finished nor unfinished: `next`
    stepped over it and printed nothing, which the skill reads as a run that is
    done and summarises with the work not started.
    """
    state.one_target()
    document = state.document()
    document["targets"][0]["status"] = "pending done"
    state.path.write_text(json.dumps(document), encoding="utf-8")
    result = state.run("next", "gh:shepherd")
    assert result.status == 1
    assert "/repos/widgets: status is not one of" in result.stderr
    assert result.stdout == ""


def test_next_refuses_a_target_whose_path_is_not_a_string(state):
    """a path that is not a string is a target no later command could name"""
    state.one_target()
    document = state.document()
    document["targets"][0]["path"] = None
    state.path.write_text(json.dumps(document), encoding="utf-8")
    result = state.run("next", "gh:shepherd")
    assert result.status == 1
    assert "path is not a string, got: null" in result.stderr


def test_rejects_an_argument_after_next(state):
    """rejects an argument after next"""
    state.two_targets()
    result = state.run("next", "gh:shepherd", "--all")
    assert result.status == 2
    assert "unknown argument: --all" in result.stderr


def test_pretty_prints_the_whole_run(state):
    """pretty-prints the whole run"""
    state.two_targets()
    result = state.run("show", "gh:shepherd")
    assert result.status == 0
    assert '"skill": "gh:shepherd"' in result.stdout
    assert '"path": "/repos/widgets"' in result.stdout


def test_refuses_to_show_a_run_that_does_not_exist(state):
    """refuses to show a run that does not exist"""
    state.two_targets()
    result = state.run("show", "workstreams:run")
    assert result.status == 1
    assert "run init first" in result.stderr


# --- the wrapper around the work ---------------------------------------------


def test_answers_under_a_locale_that_cannot_encode_its_answer(state, run_script):
    """prints a run holding a non-ASCII summary under PYTHONIOENCODING=ascii

    `show` writes back what the target wrote, and a summary can hold anything.
    Without the reconfigure this raises on the way out and reports an internal
    error for a run that is perfectly good.
    """
    state.one_target()
    state.set("/repos/widgets", "summary", "the café target is clean")
    result = run_script(FT_HARDEN_STATE, "show", "gh:shepherd", env={"PYTHONIOENCODING": "ascii"})
    assert result.status == 0, result.stderr
    assert "internal error" not in result.stderr
    assert "café" in result.stdout


def test_a_closed_reader_stops_the_output_of_init_and_not_its_work(ft_sandbox, run_with_no_reader):
    """writes the state file even when nobody is reading the path it prints

    `ft-harden-state.py init ... | head` is the case. A run that was never
    written, because the reader of its path walked away, is the state the whole
    loop resumes from.
    """
    completed = run_with_no_reader(FT_HARDEN_STATE, "init", "gh:shepherd")
    assert completed.returncode == 0
    assert completed.stderr == b""
    assert json.loads(ft_sandbox.harden_state.read_text(encoding="utf-8"))["targets"] == []
