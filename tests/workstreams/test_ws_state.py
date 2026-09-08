"""Black-box tests for ws-state.py.

Ported from the 68 `It` blocks in `spec/workstreams/ws_state_spec.sh` (72
shellspec examples: the loop_delay `Parameters` block expands to five), whose
`It` description each ported test carries in its docstring. One did not come
across: "requires jq", which asserted the shell script's dependency check. The
Python script parses and writes JSON itself, so there is no such dependency and
nothing left to assert; the tests below run with jq absent from PATH instead.
Every test with more to say than its `It` line says it, and a test with no `It`
line at all is one the shell spec never had.

Every test drives the script as its own process through `ws_state`, the way
Claude Code runs it, and reads the state file back with the helpers here.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import stat
import subprocess
import sys

import pytest
from conftest import STUB_BIN, WS_STATE, load_lib_module

pytestmark = pytest.mark.usefixtures("ws_sandbox")

ROOT_USER = os.geteuid() == 0
not_as_root = pytest.mark.skipif(ROOT_USER, reason="running as root, permissions do not apply")

INDEPENDENT_S1 = (
    '{"id": "s1", "issues": [1, 3], "kind": "independent", "stack": null, "order": null, '
    '"base": null, "model": "sonnet", "effort": "low", "reason": "mechanical", '
    '"status": "planned", "branch": null, "worktree": null, "pr": null, "prs": null, '
    '"agent": null, "question": null, "attempts": 0, "review_rounds": 0}'
)


def add_s1(ws_state, *extra):
    """The stack layer every `set` test starts from."""
    return ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1,3",
        "--kind",
        "stack",
        "--stack",
        "parser",
        "--order",
        "1",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--reason",
        "mechanical",
        *extra,
    )


def stream(ws_sandbox, index=0):
    return ws_sandbox.read_state()["streams"][index]


def field(ws_sandbox, name):
    return stream(ws_sandbox)[name]


def snapshot(ws_sandbox):
    return ws_sandbox.state_file().read_text(encoding="utf-8")


def temp_files(ws_sandbox):
    return sorted(path.name for path in ws_sandbox.state_dir.glob("*.tmp.*"))


def load_ws_state_module():
    """ws-state.py loaded in-process, for the few tests that need `main` or
    `write_state` directly rather than through a subprocess.

    Loaded by path under its own name, as `load_lib_module` is (see its
    docstring in conftest.py): the script's own `sys.path.insert` plus `from
    lib import state` still runs, so this also imports the real `lib.state`
    into `sys.modules` under the shared `lib` name, which the root conftest
    resets before every test.
    """
    return load_lib_module("workstreams_ws_state_module", WS_STATE)


# --- location -----------------------------------------------------------------


def test_derives_the_path_from_gh_repo_view(ws_sandbox, ws_state):
    """derives the path from gh repo view under the state dir"""
    result = ws_state("path")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_file())


def test_falls_back_to_claude_plugin_data(ws_sandbox, ws_state):
    """falls back to CLAUDE_PLUGIN_DATA when WS_STATE_DIR is unset"""
    ws_sandbox.delenv("WS_STATE_DIR")
    ws_sandbox.setenv("CLAUDE_PLUGIN_DATA", str(ws_sandbox.path / "data"))
    result = ws_state("path")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.path / "data" / "bje-settings__example.json")


def test_refuses_to_guess_a_location(ws_sandbox, ws_state):
    """refuses to guess a location when neither is set"""
    ws_sandbox.delenv("WS_STATE_DIR")
    result = ws_state("path")
    assert result.status == 2
    assert "CLAUDE_PLUGIN_DATA" in result.stderr


def test_takes_the_repo_from_ws_repo_without_calling_gh(ws_sandbox, ws_state):
    """takes the repo from WS_REPO without calling gh"""
    ws_sandbox.setenv("WS_REPO", "acme/widgets")
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_state("path")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_dir / "acme__widgets.json")


def test_reports_the_gh_error_when_the_repository_cannot_be_resolved(ws_sandbox, ws_state):
    """reports the gh error when the repository cannot be resolved"""
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_state("path")
    assert result.status == 1
    assert "cannot resolve the repository (gh: simulated failure)" in result.stderr
    assert "set WS_REPO" in result.stderr


def test_reports_an_unreadable_gh_answer_the_same_way(ws_sandbox, ws_state):
    """reports an answer from gh that is not the JSON it asked for

    Not in the shell spec: there, jq turned any such answer into the same
    failure. Here the parse is the script's own, so its failure needs its own
    test.
    """
    stubs = ws_sandbox.path / "broken-gh"
    stubs.mkdir()
    (stubs / "gh").write_text("#!/bin/sh\necho 'not json at all'\n", encoding="utf-8")
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    result = ws_state("path")
    assert result.status == 1
    assert "cannot resolve the repository (not json at all)" in result.stderr


def test_keeps_a_gh_warning_on_stderr_out_of_the_answer(ws_sandbox, ws_state):
    """resolves the repository when gh also writes to stderr, and passes the
    warning on to our own stderr unchanged

    Not in the shell spec. gh writes progress and warnings to stderr, so folding
    the two streams together would turn a perfectly good answer into an
    unparseable one; the streams are captured apart and only stdout is read for
    the answer. The warning itself is not dropped though: a skill reads our
    stderr, and the shell version passed a gh warning through the same way, so
    ws-state.py forwards it too rather than swallowing it just because gh still
    answered.
    """
    stubs = ws_sandbox.path / "chatty-gh"
    stubs.mkdir()
    (stubs / "gh").write_text(
        '#!/bin/sh\necho "gh: upgrade available" >&2\necho \'{"nameWithOwner": "acme/widgets"}\'\n',
        encoding="utf-8",
    )
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    result = ws_state("path")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_dir / "acme__widgets.json")
    assert result.stderr.strip() == "gh: upgrade available"


def test_reports_the_exit_code_when_gh_fails_silently(ws_sandbox, ws_state):
    """reports gh's exit code when it fails with no output at all

    Not in the shell spec. gh failing with nothing on either stream is still a
    failure to explain: without this the message would be
    "cannot resolve the repository ()", empty parentheses and no clue what
    happened.
    """
    stubs = ws_sandbox.path / "silent-gh"
    stubs.mkdir()
    (stubs / "gh").write_text("#!/bin/sh\nexit 7\n", encoding="utf-8")
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    result = ws_state("path")
    assert result.status == 1
    assert "cannot resolve the repository (gh exited 7)" in result.stderr


@pytest.mark.parametrize(
    ("answer", "why"),
    [('{"nameWithOwner": null}', "null"), ('{"nameWithOwner": 42}', "not a string")],
)
def test_rejects_a_name_with_owner_that_is_not_a_repository(ws_sandbox, ws_state, answer, why):
    """rejects a nameWithOwner that is not a name

    Not in the shell spec, where jq's own output was the value. gh answering the
    field with null or a number is gh answering a different question, and it has
    to fail the same way rather than as a TypeError further down.
    """
    stubs = ws_sandbox.path / "odd-gh"
    stubs.mkdir()
    (stubs / "gh").write_text(f"#!/bin/sh\necho '{answer}'\n", encoding="utf-8")
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    result = ws_state("path")
    assert result.status == 1
    assert "cannot resolve the repository" in result.stderr
    assert why  # names the arm in the test id


def test_rejects_a_repo_that_is_not_owner_name(ws_state):
    """rejects a repo that is not owner/name"""
    result = ws_state("init", "--repo", "widgets")
    assert result.status == 2
    assert "owner/name" in result.stderr


def test_reports_gh_missing_from_path(ws_sandbox, ws_state):
    """says the repository cannot be resolved when gh is not installed

    Not in the shell spec, which covered the missing-tool branch for jq only.
    """
    bare = ws_sandbox.sandbox.path_without("gh")
    result = ws_state("path", env={"PATH": bare})
    assert result.status == 1
    # The `gh: ` prefix is what separates "gh could not answer" from "gh is not
    # there at all"; without it the message reads as an empty failure.
    assert "cannot resolve the repository (gh: " in result.stderr


# --- init ---------------------------------------------------------------------


def test_creates_the_state_file_and_prints_its_path(ws_sandbox, ws_state):
    """creates the state file and prints its path"""
    result = ws_state("init")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_file())
    assert ws_sandbox.state_file().is_file()
    document = ws_sandbox.read_state()
    assert [document["repo"], document["version"]] == ["bje-settings/example", 1]
    assert document["streams"] == []
    assert document["deferred"] == []


def test_stamps_created_as_a_utc_second(ws_sandbox, ws_state):
    """stamps created with a whole UTC second, as `date -u` did

    Not in the shell spec, which only asserted the field was there. The skills
    read it back, and a microsecond tail or a local offset would be a different
    format from the one the shell wrote.
    """
    assert ws_state("init").status == 0
    created = ws_sandbox.read_state()["created"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", created)


def test_refuses_to_overwrite_an_existing_plan(ws_sandbox, ws_state):
    """refuses to overwrite an existing plan and leaves it untouched"""
    ws_state("init")
    add_s1(ws_state)
    before = snapshot(ws_sandbox)
    result = ws_state("init")
    assert result.status == 3
    assert "pass --force" in result.stderr
    assert snapshot(ws_sandbox) == before


def test_starts_over_with_force(ws_sandbox, ws_state):
    """starts over with --force"""
    ws_state("init")
    add_s1(ws_state)
    result = ws_state("init", "--force")
    assert result.status == 0
    assert ws_sandbox.read_state()["streams"] == []


def test_accepts_repo_explicitly(ws_sandbox, ws_state):
    """accepts --repo explicitly"""
    result = ws_state("init", "--repo", "acme/widgets")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_dir / "acme__widgets.json")


def test_honours_ws_repo_like_every_other_command(ws_sandbox, ws_state):
    """honours WS_REPO like every other command"""
    ws_sandbox.setenv("WS_REPO", "acme/widgets")
    result = ws_state("init")
    assert result.status == 0
    assert result.stdout.strip() == str(ws_sandbox.state_dir / "acme__widgets.json")


def test_rejects_repo_without_a_value(ws_state):
    """rejects --repo without a value"""
    result = ws_state("init", "--repo")
    assert result.status == 2
    assert "--repo needs a value" in result.stderr


def test_rejects_repo_swallowing_the_next_flag(ws_state):
    """rejects --repo taking the flag after it as its value

    The arm of `need` that refuses a value beginning with a dash: `--repo
    --force` is a dropped argument, not a repository called --force.
    """
    result = ws_state("init", "--repo", "--force")
    assert result.status == 2
    assert "--repo needs a value" in result.stderr


def test_rejects_unknown_init_arguments(ws_state):
    """rejects unknown arguments"""
    result = ws_state("init", "--now")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_fails_when_the_state_dir_cannot_be_created(ws_sandbox, ws_state):
    """fails, and says so, when the state dir cannot be created"""
    blocker = ws_sandbox.path / "blocker"
    blocker.write_text("", encoding="utf-8")
    ws_sandbox.setenv("WS_STATE_DIR", str(blocker / "state"))
    result = ws_state("init")
    assert result.status == 1
    assert "cannot create" in result.stderr
    assert result.stdout == ""


@not_as_root
def test_fails_when_the_state_file_cannot_be_written(ws_sandbox, ws_state):
    """fails, and says so, when the state file cannot be written"""
    ws_sandbox.state_dir.mkdir(parents=True)
    ws_sandbox.state_dir.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        result = ws_state("init")
        assert result.status == 1
        assert "cannot write" in result.stderr
        assert result.stdout == ""
        assert not ws_sandbox.state_file().exists()
    finally:
        ws_sandbox.state_dir.chmod(0o755)


def test_fails_and_cleans_up_when_the_state_file_cannot_be_moved_into_place(ws_sandbox, ws_state):
    """fails, and leaves no temp file, when the finished file cannot be moved into place

    Not in the shell spec, which only reached the write half of the atomic
    update. A directory where the state file belongs fails the rename instead,
    which is the arm that has to clean the temp file up.
    """
    ws_sandbox.state_file().mkdir(parents=True)
    result = ws_state("init")
    assert result.status == 1
    assert f"cannot write {ws_sandbox.state_file()}" in result.stderr
    assert temp_files(ws_sandbox) == []


# --- without a usable state file ----------------------------------------------


def test_show_fails_and_says_to_init(ws_state):
    """show fails and says to init"""
    result = ws_state("show")
    assert result.status == 1
    assert "run init first" in result.stderr


def test_add_stream_fails_the_same_way(ws_state):
    """add-stream fails the same way"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "haiku",
        "--effort",
        "low",
    )
    assert result.status == 1
    assert "run init first" in result.stderr


def test_rejects_a_corrupt_state_file(ws_sandbox, ws_state):
    """rejects a corrupt state file with its own message, not a jq trace"""
    ws_sandbox.state_dir.mkdir(parents=True)
    ws_sandbox.state_file().write_text('{"streams": [', encoding="utf-8")
    result = ws_state("show")
    assert result.status == 1
    assert "not valid workstreams JSON" in result.stderr


def test_rejects_json_that_is_not_a_workstreams_state(ws_sandbox, ws_state):
    """rejects a JSON file that is not a workstreams state"""
    ws_sandbox.state_dir.mkdir(parents=True)
    ws_sandbox.state_file().write_text('{"plugins": {}}', encoding="utf-8")
    result = ws_state("set", "s1", "status", "done")
    assert result.status == 1
    assert "not valid workstreams JSON" in result.stderr


@pytest.mark.parametrize(
    ("document", "command"),
    [
        ('{"streams": [], "deferred": {"a": 1}}', ("defer", "9", "later")),
        ('{"streams": [], "deferred": "abc"}', ("defer", "9", "later")),
        ('{"streams": [], "meta": 5}', ("meta", "plan_path", "/tmp/plan.md")),
        ('{"streams": ["s1"]}', ("list-streams",)),
    ],
)
def test_rejects_a_state_file_whose_shape_is_wrong(ws_sandbox, ws_state, document, command):
    """rejects a state file whose deferred, meta or streams have the wrong shape

    Not in the shell spec, and not in the port until review found it: the check
    asked only for a streams array, so a deferred object was rewritten as a list
    and exited 0, a numeric meta raised a TypeError, and a stream that was not
    an object was silently skipped. The file is refused and left alone instead.
    """
    ws_sandbox.state_dir.mkdir(parents=True)
    ws_sandbox.state_file().write_text(document, encoding="utf-8")
    result = ws_state(*command)
    assert result.status == 1
    assert "not valid workstreams JSON" in result.stderr
    assert ws_sandbox.state_file().read_text(encoding="utf-8") == document


@not_as_root
def test_reports_a_state_file_it_cannot_read(ws_sandbox, ws_state):
    """reports a state file it cannot read as a read failure, not as bad JSON

    Not in the shell spec. A file that is there but unreadable is a different
    problem from one holding the wrong bytes, and the fix is a different one.
    """
    ws_sandbox.state_dir.mkdir(parents=True)
    ws_sandbox.state_file().write_text('{"streams": []}', encoding="utf-8")
    ws_sandbox.state_file().chmod(0)
    try:
        result = ws_state("show")
        assert result.status == 1
        assert f"cannot read {ws_sandbox.state_file()}" in result.stderr
        assert "not valid workstreams JSON" not in result.stderr
    finally:
        ws_sandbox.state_file().chmod(0o644)


# --- streams ------------------------------------------------------------------


@pytest.fixture
def planned(ws_state):
    """An initialised state file, as the streams describe block's BeforeEach did."""
    assert ws_state("init").status == 0


def test_adds_an_independent_stream_with_defaults_filled_in(planned, ws_sandbox, ws_state):
    """adds an independent stream with defaults filled in"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1,3",
        "--kind",
        "independent",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--reason",
        "mechanical",
    )
    assert result.status == 0
    assert stream(ws_sandbox) == json.loads(INDEPENDENT_S1)


def test_records_a_stack_layer_with_its_stack_order_and_base(planned, ws_sandbox, ws_state):
    """records a stack layer with its stack, order, and base"""
    result = ws_state(
        "add-stream",
        "s1b",
        "--issues",
        "3",
        "--kind",
        "stack",
        "--stack",
        "parser",
        "--order",
        "2",
        "--base",
        "wktr-1-parser",
        "--model",
        "sonnet",
        "--effort",
        "low",
    )
    assert result.status == 0
    record = stream(ws_sandbox)
    assert [record["stack"], record["order"], record["base"]] == ["parser", 2, "wktr-1-parser"]


def test_requires_stack_and_order_for_a_stack_layer(planned, ws_state):
    """requires --stack and --order for a stack layer"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "stack",
        "--model",
        "sonnet",
        "--effort",
        "low",
    )
    assert result.status == 2
    assert "needs --stack and --order" in result.stderr


def test_rejects_stack_flags_on_an_independent_stream(planned, ws_state):
    """rejects stack flags on an independent stream"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--order",
        "1",
    )
    assert result.status == 2
    assert "are for --kind stack" in result.stderr


def test_rejects_an_effort_that_has_no_stream_agent(planned, ws_state):
    """rejects an effort that has no stream agent"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "sonnet",
        "--effort",
        "max",
    )
    assert result.status == 2
    assert "effort must be low, medium, or high" in result.stderr


def test_rejects_an_unknown_model_alias(planned, ws_state):
    """rejects an unknown model alias"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "gpt",
        "--effort",
        "low",
    )
    assert result.status == 2
    assert "model must be one of" in result.stderr


def test_rejects_a_flag_given_last_with_no_value(planned, ws_state):
    """rejects a flag given last with no value"""
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--reason",
    )
    assert result.status == 2
    assert "--reason needs a value" in result.stderr


def test_rejects_a_flag_that_swallows_the_next_flag(planned, ws_state):
    """rejects a flag whose value is the flag after it

    The `need` arm for a value beginning with a dash: `--stack --order 1` names
    no stack, and reading "--order" as one would write a stack layer nothing
    could ever find.
    """
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "stack",
        "--stack",
        "--order",
        "1",
        "--model",
        "sonnet",
        "--effort",
        "low",
    )
    assert result.status == 2
    assert "--stack needs a value" in result.stderr


def test_keeps_a_non_ascii_reason_as_written(planned, ws_sandbox, ws_state):
    """keeps a non-ascii reason as raw UTF-8, in the file and in show

    jq wrote raw UTF-8, so `ensure_ascii=False` is what keeps the port at
    parity. Without it the file holds \\u escapes: still JSON, but no longer the
    bytes the shell wrote or a person can read.
    """
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "1",
        "--kind",
        "independent",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--reason",
        "caf\u00e9",
    )
    assert result.status == 0
    assert "caf\u00e9" in ws_sandbox.state_file().read_text(encoding="utf-8")
    assert "\\u00e9" not in ws_sandbox.state_file().read_text(encoding="utf-8")
    assert "caf\u00e9" in ws_state("show").stdout


def test_rejects_a_duplicate_id_and_keeps_the_first(planned, ws_sandbox, ws_state):
    """rejects a duplicate id and keeps the first"""
    add_s1(ws_state)
    result = ws_state(
        "add-stream",
        "s1",
        "--issues",
        "2",
        "--kind",
        "independent",
        "--model",
        "haiku",
        "--effort",
        "low",
    )
    assert result.status == 1
    assert "already exists: s1" in result.stderr
    assert len(ws_sandbox.read_state()["streams"]) == 1
    assert field(ws_sandbox, "issues") == [1, 3]


def test_rejects_a_missing_required_flag(planned, ws_state):
    """rejects a missing required flag"""
    result = ws_state(
        "add-stream", "s2", "--issues", "2", "--kind", "independent", "--model", "haiku"
    )
    assert result.status == 2
    assert "needs --issues, --kind, --model, and --effort" in result.stderr


def test_rejects_a_bad_kind(planned, ws_state):
    """rejects a bad kind"""
    result = ws_state(
        "add-stream",
        "s2",
        "--issues",
        "2",
        "--kind",
        "chain",
        "--model",
        "haiku",
        "--effort",
        "low",
    )
    assert result.status == 2
    assert "kind must be" in result.stderr


def test_rejects_malformed_issue_lists(planned, ws_state):
    """rejects malformed issue lists"""
    result = ws_state(
        "add-stream",
        "s2",
        "--issues",
        "2, 3",
        "--kind",
        "independent",
        "--model",
        "haiku",
        "--effort",
        "low",
    )
    assert result.status == 2
    assert "comma-separated numbers" in result.stderr


def test_rejects_a_non_numeric_or_zero_order(planned, ws_state):
    """rejects a non-numeric or zero order"""
    result = ws_state(
        "add-stream",
        "s2",
        "--issues",
        "2",
        "--kind",
        "stack",
        "--stack",
        "p",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--order",
        "0",
    )
    assert result.status == 2
    assert "--order must be a number from 1" in result.stderr


def test_rejects_a_missing_id(planned, ws_state):
    """rejects a missing id"""
    result = ws_state("add-stream", "--issues", "2")
    assert result.status == 2
    assert "needs a stream id" in result.stderr


def test_rejects_an_unknown_add_stream_flag(planned, ws_state):
    """rejects an unknown add-stream flag"""
    result = ws_state(
        "add-stream",
        "s2",
        "--issues",
        "2",
        "--kind",
        "independent",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--colour",
        "red",
    )
    assert result.status == 2
    assert "unknown argument: --colour" in result.stderr


# --- set ----------------------------------------------------------------------


@pytest.fixture
def with_s1(planned, ws_state):
    """A state file holding the stack layer s1, as the set block's BeforeEach did."""
    assert add_s1(ws_state).status == 0


def test_sets_a_string_field(with_s1, ws_sandbox, ws_state):
    """sets a string field"""
    result = ws_state("set", "s1", "branch", "wktr-1-parser")
    assert result.status == 0
    assert field(ws_sandbox, "branch") == "wktr-1-parser"


def test_stores_pr_as_a_number_without_json(with_s1, ws_sandbox, ws_state):
    """stores pr as a number without needing --json"""
    result = ws_state("set", "s1", "pr", "10")
    assert result.status == 0
    assert field(ws_sandbox, "pr") == 10


def test_counts_review_rounds_as_a_number(with_s1, ws_sandbox, ws_state):
    """Not in the shell spec: the field is new in #62. The run loop reads it to
    tell a first review pass from the one repeat it allows, and reads it from
    disk rather than from its own memory because the loop is resumable."""
    assert field(ws_sandbox, "review_rounds") == 0
    result = ws_state("set", "s1", "review_rounds", "1")
    assert result.status == 0
    assert field(ws_sandbox, "review_rounds") == 1


def test_rejects_a_non_numeric_review_rounds(with_s1, ws_state):
    """Not in the shell spec, for the same reason. A count stored as the string
    "two" would compare wrong against the round limit rather than fail."""
    result = ws_state("set", "s1", "review_rounds", "two")
    assert result.status == 2
    assert "review_rounds takes a number or null" in result.stderr


# --- bump ---------------------------------------------------------------------


def test_bump_adds_one_and_prints_the_new_value(with_s1, ws_sandbox, ws_state):
    """Not in the shell spec: the command is new in #62. The run loop counts
    review rounds through it so a skill never reads a value, adds one, and
    writes it back; a tick that stopped between the two would leave the count
    behind by one and repeat a round already run."""
    result = ws_state("bump", "s1", "review_rounds")
    assert result.status == 0
    assert result.stdout == "1\n"
    assert field(ws_sandbox, "review_rounds") == 1
    assert ws_state("bump", "s1", "review_rounds").stdout == "2\n"
    assert field(ws_sandbox, "review_rounds") == 2


def test_bump_counts_attempts_too(with_s1, ws_sandbox, ws_state):
    result = ws_state("bump", "s1", "attempts")
    assert result.status == 0
    assert field(ws_sandbox, "attempts") == 1


def test_bump_refuses_a_field_that_does_not_hold_a_number(with_s1, ws_state):
    result = ws_state("bump", "s1", "status")
    assert result.status == 2
    assert "not a numeric field" in result.stderr


def test_bump_refuses_a_field_outside_the_schema(with_s1, ws_state):
    """The same guard `set` has: a typo must not create a field."""
    result = ws_state("bump", "s1", "rounds")
    assert result.status == 2
    assert "unknown field: rounds" in result.stderr


def test_bump_refuses_an_unknown_stream(with_s1, ws_state):
    result = ws_state("bump", "s9", "review_rounds")
    assert result.status == 1
    assert "unknown stream: s9" in result.stderr


def test_bump_needs_a_stream_and_a_field(with_s1, ws_state):
    for arguments in (("bump",), ("bump", "s1"), ("bump", "s1", "attempts", "2")):
        result = ws_state(*arguments)
        assert result.status == 2, arguments
        assert "bump needs <stream-id> <numeric-field>" in result.stderr


def test_bump_leaves_the_state_alone_when_the_field_holds_something_else(
    with_s1, ws_sandbox, ws_state
):
    """A state file written by something else is not this script's to overwrite."""
    path = ws_sandbox.state_file()
    document = json.loads(path.read_text(encoding="utf-8"))
    document["streams"][0]["review_rounds"] = "two"
    path.write_text(json.dumps(document), encoding="utf-8")
    result = ws_state("bump", "s1", "review_rounds")
    assert result.status == 1
    assert "is not a number on stream s1" in result.stderr
    assert field(ws_sandbox, "review_rounds") == "two"


def test_clears_a_numeric_field_back_to_null(with_s1, ws_sandbox, ws_state):
    """clears a numeric field back to null"""
    ws_state("set", "s1", "pr", "10")
    result = ws_state("set", "s1", "pr", "null")
    assert result.status == 0
    assert field(ws_sandbox, "pr") is None


def test_rejects_a_non_numeric_pr(with_s1, ws_state):
    """rejects a non-numeric pr"""
    result = ws_state("set", "s1", "pr", "twelve")
    assert result.status == 2
    assert "pr takes a number or null" in result.stderr


def test_stores_prs_as_a_json_array(with_s1, ws_sandbox, ws_state):
    """stores prs as a JSON array"""
    result = ws_state("set", "s1", "prs", "[10, 12]")
    assert result.status == 0
    assert field(ws_sandbox, "prs") == [10, 12]


def test_accepts_null_through_json(with_s1, ws_sandbox, ws_state):
    """accepts null and false through --json"""
    result = ws_state("set", "s1", "question", "null", "--json")
    assert result.status == 0
    assert field(ws_sandbox, "question") is None
    assert ws_state("set", "s1", "question", "false", "--json").status == 0
    assert field(ws_sandbox, "question") is False


def test_rejects_invalid_json_and_leaves_the_stream_unchanged(with_s1, ws_sandbox, ws_state):
    """rejects invalid JSON with --json and leaves the stream unchanged"""
    before = stream(ws_sandbox)
    result = ws_state("set", "s1", "prs", "{oops")
    assert result.status == 2
    assert "not valid JSON" in result.stderr
    assert stream(ws_sandbox) == before


def test_rejects_an_empty_json_value(with_s1, ws_state):
    """rejects an empty --json value"""
    result = ws_state("set", "s1", "question", "", "--json")
    assert result.status == 2
    assert "not valid JSON" in result.stderr


def test_validates_status_values_and_leaves_the_stream_unchanged(with_s1, ws_sandbox, ws_state):
    """validates status values and leaves the stream unchanged"""
    before = stream(ws_sandbox)
    result = ws_state("set", "s1", "status", "shipped")
    assert result.status == 2
    assert "invalid status: shipped" in result.stderr
    assert stream(ws_sandbox) == before


def test_accepts_every_documented_status(with_s1, ws_sandbox, ws_state):
    """accepts every documented status"""
    for status in ("planned", "running", "draft", "reviewing", "paused", "done"):
        assert ws_state("set", "s1", "status", status).status == 0
    result = ws_state("set", "s1", "status", "failed")
    assert result.status == 0
    assert field(ws_sandbox, "status") == "failed"


def test_rejects_a_field_outside_the_schema(with_s1, ws_sandbox, ws_state):
    """rejects a field outside the schema, so a typo cannot create one"""
    before = stream(ws_sandbox)
    result = ws_state("set", "s1", "statu", "running")
    assert result.status == 2
    assert "unknown field: statu" in result.stderr
    assert stream(ws_sandbox) == before


def test_refuses_to_change_the_id(with_s1, ws_state):
    """refuses to change the id"""
    result = ws_state("set", "s1", "id", "s9")
    assert result.status == 2
    assert "unknown field: id" in result.stderr


def test_fails_for_an_unknown_stream(with_s1, ws_state):
    """fails for an unknown stream"""
    result = ws_state("set", "nope", "status", "done")
    assert result.status == 1
    assert "unknown stream: nope" in result.stderr


def test_stores_pr_as_a_number_even_with_json(with_s1, ws_sandbox, ws_state):
    """stores pr as a number whether or not --json is given

    Not in the shell spec. pr, attempts and order are checked as numbers before
    --json is looked at, so the flag changes nothing for them and cannot be used
    to write a string or an object into a numeric field.
    """
    result = ws_state("set", "s1", "pr", "10", "--json")
    assert result.status == 0
    assert field(ws_sandbox, "pr") == 10


def test_rejects_a_json_status_even_though_it_parses(with_s1, ws_sandbox, ws_state):
    """rejects a status given as JSON

    Not in the shell spec. `"running"` is valid JSON and would parse to the
    right string, but status is checked against the vocabulary before --json is
    read, so the quoted form is refused rather than half-working.
    """
    before = snapshot(ws_sandbox)
    result = ws_state("set", "s1", "status", '"running"', "--json")
    assert result.status == 2
    assert "invalid status" in result.stderr
    assert snapshot(ws_sandbox) == before


def test_rejects_a_fourth_argument_other_than_json(with_s1, ws_state):
    """rejects a fourth argument other than --json"""
    result = ws_state("set", "s1", "branch", "b", "--raw")
    assert result.status == 2
    assert "unknown argument: --raw" in result.stderr


def test_set_needs_three_arguments(with_s1, ws_state):
    """needs three arguments"""
    result = ws_state("set", "s1", "status")
    assert result.status == 2
    assert "set needs" in result.stderr


# --- list-streams -------------------------------------------------------------


def add_s2(ws_state):
    return ws_state(
        "add-stream",
        "s2",
        "--issues",
        "2",
        "--kind",
        "independent",
        "--model",
        "haiku",
        "--effort",
        "low",
    )


def test_lists_streams_by_status(planned, ws_state):
    """lists streams by status"""
    add_s1(ws_state)
    add_s2(ws_state)
    ws_state("set", "s2", "status", "draft")
    result = ws_state("list-streams", "--status", "draft")
    assert result.status == 0
    assert [record["id"] for record in json.loads(result.stdout)] == ["s2"]


def test_lists_every_stream_without_a_filter(planned, ws_state):
    """lists every stream without a filter"""
    add_s1(ws_state)
    add_s2(ws_state)
    result = ws_state("list-streams")
    assert result.status == 0
    assert len(json.loads(result.stdout)) == 2


def test_rejects_a_misspelled_status_filter(planned, ws_state):
    """rejects a misspelled status filter rather than returning nothing"""
    result = ws_state("list-streams", "--status", "runing")
    assert result.status == 2
    assert "invalid status: runing" in result.stderr


def test_rejects_unknown_list_streams_flags(planned, ws_state):
    """rejects unknown list-streams flags"""
    result = ws_state("list-streams", "--kind", "stack")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_rejects_status_with_no_value(planned, ws_state):
    """rejects --status with no value"""
    result = ws_state("list-streams", "--status")
    assert result.status == 2
    assert "--status needs a value" in result.stderr


# --- deferred and meta --------------------------------------------------------


def test_records_a_deferred_issue_replacing_an_earlier_entry(planned, ws_sandbox, ws_state):
    """records a deferred issue with its reason, replacing an earlier entry"""
    ws_state("defer", "4", "needs hardware")
    result = ws_state("defer", "4", "needs a week of data")
    assert result.status == 0
    assert ws_sandbox.read_state()["deferred"] == [{"issue": 4, "reason": "needs a week of data"}]


def test_keeps_other_deferred_issues_when_adding_one(planned, ws_sandbox, ws_state):
    """keeps other deferred issues when adding one"""
    ws_state("defer", "4", "needs hardware")
    result = ws_state("defer", "5", "already closed")
    assert result.status == 0
    assert ws_sandbox.read_state()["deferred"] == [
        {"issue": 4, "reason": "needs hardware"},
        {"issue": 5, "reason": "already closed"},
    ]


def test_requires_a_numeric_issue_for_defer(planned, ws_state):
    """requires a numeric issue for defer"""
    result = ws_state("defer", "four", "reason")
    assert result.status == 2
    assert "defer needs" in result.stderr


def test_stores_plan_level_metadata_as_strings(planned, ws_sandbox, ws_state):
    """stores plan-level metadata as strings"""
    result = ws_state("meta", "plan_path", "/tmp/plan.md")
    assert result.status == 0
    assert ws_sandbox.read_state()["meta"] == {"plan_path": "/tmp/plan.md"}


def test_stores_loop_delay_as_a_json_number(planned, ws_sandbox, ws_state):
    """stores loop_delay as a JSON number

    The run skill passes loop_delay to ScheduleWakeup, which takes a number in
    this range, so the script stores a number and refuses anything outside it.
    """
    result = ws_state("meta", "loop_delay", "1800")
    assert result.status == 0
    assert ws_sandbox.read_state()["meta"] == {"loop_delay": 1800}


def test_drops_zero_padding_from_loop_delay(planned, ws_sandbox, ws_state):
    """drops zero padding rather than emitting invalid JSON"""
    result = ws_state("meta", "loop_delay", "0600")
    assert result.status == 0
    assert ws_sandbox.read_state()["meta"] == {"loop_delay": 600}


@pytest.mark.parametrize(
    ("value", "why"),
    [
        ("5m", "a duration suffix"),
        ("thirty", "a word"),
        ("59", "one below the range"),
        ("3601", "one above the range"),
        ("-1", "a negative number"),
    ],
)
def test_rejects_a_loop_delay_that_is_not_in_range(planned, ws_sandbox, ws_state, value, why):
    """rejects {why}"""
    result = ws_state("meta", "loop_delay", value)
    assert result.status == 2
    assert "integer from 60 to 3600" in result.stderr
    assert ws_sandbox.read_state()["meta"] == {}


def test_requires_a_field_and_value_for_meta(planned, ws_state):
    """requires a field and value for meta"""
    result = ws_state("meta", "loop_delay")
    assert result.status == 2
    assert "meta needs" in result.stderr


def test_pretty_prints_the_whole_file_with_show(planned, ws_sandbox, ws_state):
    """pretty-prints the whole file with show

    Byte for byte what `jq .` printed: a two-space indent, raw UTF-8, and one
    trailing newline. The skills pipe this into other tools, so the shape of the
    output is part of the contract, not just the values in it.
    """
    result = ws_state("show")
    assert result.status == 0
    assert '"repo": "bje-settings/example"' in result.stdout
    expected = json.dumps(ws_sandbox.read_state(), indent=2, ensure_ascii=False) + "\n"
    assert result.stdout == expected


# --- atomic writes ------------------------------------------------------------


def test_leaves_no_temp_file_behind_after_an_update(planned, ws_sandbox, ws_state):
    """leaves no temp file behind after an update"""
    result = ws_state("meta", "a", "b")
    assert result.status == 0
    assert temp_files(ws_sandbox) == []


@not_as_root
def test_keeps_the_old_state_when_the_update_cannot_be_written(planned, ws_sandbox, ws_state):
    """keeps the old state when the update cannot be written"""
    before = snapshot(ws_sandbox)
    ws_sandbox.state_dir.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        result = ws_state("meta", "a", "b")
        assert result.status == 1
        assert "cannot write" in result.stderr
        assert snapshot(ws_sandbox) == before
        assert temp_files(ws_sandbox) == []
    finally:
        ws_sandbox.state_dir.chmod(0o755)


def test_rejects_a_nan_state_file_as_invalid_json_rather_than_an_internal_error(
    planned, ws_sandbox, ws_state
):
    """rejects a NaN in the state file as invalid workstreams JSON, not an
    internal error

    Not in the shell spec. json.load accepts the bare literals NaN, Infinity
    and -Infinity by default, which are not JSON; require_state now parses with
    the same parse_constant refusal `set --json` already used, so a state file
    holding one reports the same "not valid workstreams JSON" message every
    other corrupt file gets, rather than surviving the parse and failing later,
    unrecognisably, when the file is written back out.
    """
    document = ws_sandbox.read_state()
    document["meta"] = {"seen": float("nan")}
    ws_sandbox.state_file().write_text(
        json.dumps(document, indent=2, allow_nan=True) + "\n", encoding="utf-8"
    )
    result = ws_state("meta", "a", "b")
    assert result.status == 1
    assert f"state file is not valid workstreams JSON: {ws_sandbox.state_file()}" in result.stderr
    assert temp_files(ws_sandbox) == []


def test_reports_a_value_error_writing_state_with_its_message(ws_sandbox):
    """reports a ValueError from write_state as "cannot write <path>: <error>"

    Not in the shell spec, and not reachable black-box any more: since
    require_state now refuses a NaN on the way in (previous test), nothing a
    command reads or is given can hand write_state a document dumps() cannot
    serialise. write_state itself still has to handle it -- a circular
    reference is one dumps() would still raise ValueError for -- so this drives
    write_state directly, the way test_state.py drives lib/state.py.
    """
    module = load_ws_state_module()
    circular = {}
    circular["self"] = circular
    ws_sandbox.state_dir.mkdir(parents=True, exist_ok=True)
    path = str(ws_sandbox.state_dir / "target.json")
    with pytest.raises(module.Failure) as excinfo:
        module.write_state(path, circular)
    assert excinfo.value.message.startswith(f"cannot write {path}: ")
    assert "Circular reference detected" in excinfo.value.message
    assert temp_files(ws_sandbox) == []


def test_keeps_the_temp_file_left_at_note_after_a_value_error(ws_sandbox, monkeypatch):
    """keeps the "temp file left at" note when unlink also fails after a
    ValueError

    Not in the shell spec. write_state's OSError branch already proves the note
    survives an unlink failure; before this change a ValueError from dumps()
    was not caught at all, so it propagated past the `finally` block's own note
    and lost it. Monkeypatching dumps() and os.unlink() avoids needing root or
    unwritable-directory tricks to provoke both failures together.
    """
    module = load_ws_state_module()
    ws_sandbox.state_dir.mkdir(parents=True, exist_ok=True)
    path = str(ws_sandbox.state_dir / "target.json")

    def failing_dumps(document):
        raise ValueError("boom")

    def failing_unlink(target):
        raise OSError("cannot remove")

    monkeypatch.setattr(module, "dumps", failing_dumps)
    monkeypatch.setattr(module.os, "unlink", failing_unlink)
    with pytest.raises(module.Failure) as excinfo:
        module.write_state(path, {})
    assert f"cannot write {path}: boom" in excinfo.value.message
    assert "temp file left at" in excinfo.value.message


def test_reports_an_unanticipated_failure_naming_its_class(monkeypatch, capsys):
    """reports an unanticipated failure with its own message, not a traceback,
    naming the exception's class even when its own message is empty

    Not in the shell spec. The usage text promises the script's own message for
    anything it refuses; the NaN-in-the-state-file trigger this test used to
    use is now caught earlier as invalid JSON (see the require_state test
    above), so this drives main() directly with a command handler that raises,
    the way test_state.py drives lib/state.py functions directly. A bare
    exception with no message (str(error) == "") must still name its class
    rather than printing a message that trails off after the colon.
    """
    module = load_ws_state_module()

    def boom(args):
        raise RuntimeError()

    monkeypatch.setitem(module.COMMANDS, "show", boom)
    status = module.main(["ws-state.py", "show"])
    captured = capsys.readouterr()
    assert status == 1
    assert captured.err == "ws-state.py: internal error: RuntimeError: \n"
    assert "Traceback" not in captured.err


@pytest.mark.parametrize("args", [("path",), ("show",)])
def test_exits_quietly_when_the_reader_closes_the_pipe_on_small_output(planned, ws_sandbox, args):
    """exits 0 and says nothing when a reader closes the pipe on output small
    enough to fit in one write

    Not in the shell spec. Without an explicit flush before returning, output
    that fits inside the pipe buffer is never actually written until the
    interpreter's own shutdown flush, which runs after main()'s own handler and
    prints "Exception ignored in..." rather than being caught quietly the way
    the large-output case below already was.
    """
    process = subprocess.Popen(
        [sys.executable, str(WS_STATE), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


def test_exits_quietly_when_the_reader_closes_the_pipe(planned, ws_sandbox, ws_state):
    """exits 0 and says nothing when show is piped into a reader that stops

    Not in the shell spec, where the shell was killed by SIGPIPE and nobody
    noticed. Python turns it into a BrokenPipeError, which without a handler is
    a traceback on stderr and a non-zero exit for `ws-state.py show | head`.
    """
    document = ws_sandbox.read_state()
    # Enough output that the write cannot fit in the pipe buffer, so the failure
    # is deterministic rather than a race with the reader closing.
    document["streams"] = [
        dict(json.loads(INDEPENDENT_S1), id=f"s{index}") for index in range(4000)
    ]
    ws_sandbox.state_file().write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    process = subprocess.Popen(
        [sys.executable, str(WS_STATE), "show"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ),
    )
    process.stdout.close()
    stderr = process.communicate()[1].decode("utf-8", "replace")
    assert process.returncode == 0
    assert stderr == ""


def test_shows_a_non_ascii_reason_under_a_non_utf8_locale(planned, ws_sandbox, ws_state):
    """prints a non-ASCII reason correctly even under a non-UTF-8 locale

    Not in the shell spec. dumps() writes with ensure_ascii=False, so an
    accented reason goes to stdout as raw UTF-8 rather than a \\u escape; without
    reconfiguring stdout, a non-UTF-8 locale (PYTHONIOENCODING=ascii here) makes
    that raw write raise UnicodeEncodeError, which without this change `show`
    would report as an internal error instead of just working.
    """
    assert add_s1(ws_state, "--reason", "café").status == 0
    result = ws_state(
        "show",
        env={"LC_ALL": "C", "PYTHONIOENCODING": "ascii", "PYTHONUTF8": "0"},
    )
    assert result.status == 0
    assert "café" in result.stdout


# --- lifecycle: finished, archive, reconcile ----------------------------------


@pytest.fixture
def lifecycle(ws_sandbox, ws_state):
    """A plan with streams whose statuses and PRs each test sets for itself."""

    class Lifecycle:
        def plan(self, *streams):
            """One stream record per (id, status, pr); pr None writes no pr."""
            assert ws_state("init").status == 0
            for stream_id, status, pr in streams:
                assert (
                    ws_state(
                        "add-stream",
                        stream_id,
                        "--issues",
                        "1",
                        "--kind",
                        "independent",
                        "--model",
                        "sonnet",
                        "--effort",
                        "low",
                    ).status
                    == 0
                )
                assert ws_state("set", stream_id, "status", status).status == 0
                if pr is not None:
                    assert ws_state("set", stream_id, "pr", str(pr)).status == 0

        def statuses(self):
            return [stream["status"] for stream in ws_sandbox.read_state()["streams"]]

        def archived(self):
            directory = ws_sandbox.state_dir / "archive"
            return (
                sorted(path.name for path in directory.glob("*.json")) if directory.is_dir() else []
            )

        def archived_document(self):
            files = sorted((ws_sandbox.state_dir / "archive").glob("*.json"))
            assert len(files) == 1, files
            return json.loads(files[0].read_text(encoding="utf-8"))

    return Lifecycle()


def test_finished_says_nothing_and_exits_0_when_every_stream_is_terminal(lifecycle, ws_state):
    lifecycle.plan(("s1", "done", 10), ("s2", "failed", None))
    result = ws_state("finished")
    assert result.status == 0
    assert result.stdout == ""


def test_finished_exits_1_while_a_stream_is_paused(lifecycle, ws_state):
    """A paused stream is a question the user owes an answer to, not a finished run."""
    lifecycle.plan(("s1", "done", 10), ("s2", "paused", 11))
    result = ws_state("finished")
    assert result.status == 1
    assert "is not finished" in result.stderr
    assert result.stdout == ""


def test_finished_exits_1_with_a_message_when_there_is_no_plan(ws_state):
    result = ws_state("finished")
    assert result.status == 1
    assert "run init first" in result.stderr
    assert result.stdout == ""


def test_finished_rejects_a_stray_argument(lifecycle, ws_state):
    lifecycle.plan(("s1", "done", 10))
    result = ws_state("finished", "--force")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_archive_moves_a_finished_plan_and_prints_where_it_went(lifecycle, ws_sandbox, ws_state):
    lifecycle.plan(("s1", "done", 10))
    before = ws_sandbox.read_state()
    result = ws_state("archive")
    assert result.status == 0
    assert not ws_sandbox.state_file().exists()
    moved = result.stdout.strip()
    assert moved == str(ws_sandbox.state_dir / "archive" / lifecycle.archived()[0])
    assert json.loads(pathlib.Path(moved).read_text(encoding="utf-8")) == before


def test_archive_refuses_an_unfinished_plan_and_leaves_it_where_it_is(
    lifecycle, ws_sandbox, ws_state
):
    """The refusing half of a destructive command, beside the acting half above."""
    lifecycle.plan(("s1", "reviewing", 12))
    before = snapshot(ws_sandbox)
    result = ws_state("archive")
    assert result.status == 3
    assert "pass --force" in result.stderr
    assert snapshot(ws_sandbox) == before
    assert lifecycle.archived() == []


def test_archive_moves_an_unfinished_plan_with_force(lifecycle, ws_sandbox, ws_state):
    lifecycle.plan(("s1", "reviewing", 12))
    assert ws_state("archive", "--force").status == 0
    assert not ws_sandbox.state_file().exists()
    assert lifecycle.archived_document()["streams"][0]["status"] == "reviewing"


def test_archive_rejects_an_unknown_argument(lifecycle, ws_state):
    lifecycle.plan(("s1", "done", 10))
    result = ws_state("archive", "--now")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_archive_reports_an_archive_directory_it_cannot_create(lifecycle, ws_sandbox, ws_state):
    lifecycle.plan(("s1", "done", 10))
    (ws_sandbox.state_dir / "archive").write_text("", encoding="utf-8")
    result = ws_state("archive")
    assert result.status == 1
    assert "cannot create" in result.stderr
    assert ws_sandbox.state_file().is_file()


def test_archive_reports_a_move_it_could_not_make(lifecycle, ws_sandbox, ws_state):
    """A directory already standing where the archived plan would go.

    The plan stays where it is: a move that could not be made must not read as
    one that was, or the next tick starts a plan over a run still in progress.
    """
    lifecycle.plan(("s1", "done", 10))
    created = ws_sandbox.read_state()["created"].replace(":", "-")
    blocker = ws_sandbox.state_dir / "archive" / f"bje-settings__example.{created}.json"
    blocker.mkdir(parents=True)
    (blocker / "occupied").write_text("", encoding="utf-8")
    result = ws_state("archive")
    assert result.status == 1
    assert "cannot archive" in result.stderr
    assert ws_sandbox.state_file().is_file()


def test_init_archives_a_finished_plan_and_starts_a_new_one(lifecycle, ws_sandbox, ws_state):
    """The case that made this worth doing: a finished run no longer asks."""
    lifecycle.plan(("s1", "done", 10))
    before = ws_sandbox.read_state()
    result = ws_state("init")
    assert result.status == 0
    assert "archived the finished plan to" in result.stderr
    assert ws_sandbox.read_state()["streams"] == []
    assert lifecycle.archived_document() == before


def test_init_still_refuses_an_unfinished_plan(lifecycle, ws_sandbox, ws_state):
    lifecycle.plan(("s1", "running", None))
    before = snapshot(ws_sandbox)
    result = ws_state("init")
    assert result.status == 3
    assert "pass --force" in result.stderr
    assert snapshot(ws_sandbox) == before
    assert lifecycle.archived() == []


def test_init_force_archives_the_unfinished_plan_before_overwriting_it(
    lifecycle, ws_sandbox, ws_state
):
    """--force keeps what it replaces: the plan is gone from where the skills
    look for it, not gone from disk."""
    lifecycle.plan(("s1", "running", None))
    result = ws_state("init", "--force")
    assert result.status == 0
    assert "archived the unfinished plan to" in result.stderr
    assert ws_sandbox.read_state()["streams"] == []
    assert lifecycle.archived_document()["streams"][0]["status"] == "running"


def test_init_force_archives_a_file_it_could_not_parse(ws_sandbox, ws_state):
    """A file another tool left at the path is still not this script's to destroy."""
    ws_sandbox.state_dir.mkdir(parents=True, exist_ok=True)
    ws_sandbox.state_file().write_text("{not json at all", encoding="utf-8")
    result = ws_state("init", "--force")
    assert result.status == 0
    assert "archived the unfinished plan to" in result.stderr
    archived = sorted((ws_sandbox.state_dir / "archive").glob("*.json"))
    assert [path.read_text(encoding="utf-8") for path in archived] == ["{not json at all"]


def test_reconcile_marks_a_merged_pr_done_and_a_closed_one_failed(lifecycle, ws_sandbox, ws_state):
    """PR 14 is merged in the fixtures and PR 19 was closed without merging."""
    lifecycle.plan(("s1", "reviewing", 14), ("s2", "draft", 19), ("s3", "running", 12))
    result = ws_state("reconcile")
    assert result.status == 0
    assert json.loads(result.stdout) == [
        {"stream": "s1", "from": "reviewing", "to": "done"},
        {"stream": "s2", "from": "draft", "to": "failed"},
    ]
    assert lifecycle.statuses() == ["done", "failed", "running"]
    assert ws_sandbox.read_state()["streams"][1]["question"] == "PR #19 was closed without merging"


def test_reconcile_leaves_an_open_pr_alone_and_prints_an_empty_array(
    lifecycle, ws_sandbox, ws_state
):
    lifecycle.plan(("s1", "reviewing", 12))
    before = snapshot(ws_sandbox)
    result = ws_state("reconcile")
    assert result.status == 0
    assert json.loads(result.stdout) == []
    assert snapshot(ws_sandbox) == before


def test_reconcile_does_not_ask_about_a_stream_with_no_pr(lifecycle, ws_state):
    """A running stream that has not pushed yet has nothing to reconcile, and
    asking gh about a null number would be an error, not an answer."""
    lifecycle.plan(("s1", "running", None), ("s2", "done", 14))
    result = ws_state("reconcile")
    assert result.status == 0
    assert json.loads(result.stdout) == []


def test_reconcile_exits_4_and_writes_nothing_when_gh_fails(lifecycle, ws_sandbox, ws_state):
    """A rate limit or an expired token is a tick to repeat, not a plan to fail.

    WS_REPO so the failure is the pull request read and not the repository one:
    naming the repository fails the way it does for every command, exit 1.
    """
    lifecycle.plan(("s1", "reviewing", 14))
    before = snapshot(ws_sandbox)
    ws_sandbox.setenv("WS_REPO", "bje-settings/example")
    ws_sandbox.setenv("WS_GH_FIXTURE_FAIL", "1")
    result = ws_state("reconcile")
    assert result.status == 4
    assert "gh pr view failed for #14" in result.stderr
    assert snapshot(ws_sandbox) == before


def test_reconcile_exits_4_for_a_pull_request_that_does_not_exist(lifecycle, ws_sandbox, ws_state):
    """The run skill fails a stream on a missing PR at its own review step, where
    it has the stream in hand; guessing here would fail one over a typo."""
    lifecycle.plan(("s1", "reviewing", 404))
    before = snapshot(ws_sandbox)
    result = ws_state("reconcile")
    assert result.status == 4
    assert "Could not resolve" in result.stderr
    assert snapshot(ws_sandbox) == before


def test_reconcile_exits_4_when_gh_answers_with_something_it_cannot_read(
    lifecycle, ws_sandbox, ws_state
):
    lifecycle.plan(("s1", "reviewing", 14))
    stubs = ws_sandbox.path / "chatty-pr-gh"
    stubs.mkdir()
    (stubs / "gh").write_text("#!/bin/sh\necho 'not json at all'\n", encoding="utf-8")
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    ws_sandbox.setenv("WS_REPO", "bje-settings/example")
    result = ws_state("reconcile")
    assert result.status == 4
    assert "did not answer with a state" in result.stderr


def test_reconcile_exits_4_on_a_state_it_does_not_know(lifecycle, ws_sandbox, ws_state):
    """gh answering with a state outside the three is gh answering another
    question, and acting on it would move a stream on a guess."""
    lifecycle.plan(("s1", "reviewing", 14))
    stubs = ws_sandbox.path / "odd-pr-gh"
    stubs.mkdir()
    (stubs / "gh").write_text('#!/bin/sh\necho \'{"state": "LOCKED"}\'\n', encoding="utf-8")
    (stubs / "gh").chmod(0o755)
    ws_sandbox.sandbox.stub_path(stubs)
    ws_sandbox.setenv("WS_REPO", "bje-settings/example")
    result = ws_state("reconcile")
    assert result.status == 4
    assert "unknown state: LOCKED" in result.stderr


def test_reconcile_reports_gh_missing_from_path(lifecycle, ws_sandbox, ws_state):
    lifecycle.plan(("s1", "reviewing", 14))
    bare = ws_sandbox.sandbox.path_without("gh")
    result = ws_state("reconcile", env={"PATH": bare, "WS_REPO": "bje-settings/example"})
    assert result.status == 4
    assert "gh pr view failed for #14" in result.stderr


def test_reconcile_rejects_a_stray_argument(lifecycle, ws_state):
    lifecycle.plan(("s1", "done", 14))
    result = ws_state("reconcile", "--force")
    assert result.status == 2
    assert "unknown argument" in result.stderr


# --- usage --------------------------------------------------------------------


def test_prints_usage_for_help(ws_state):
    """prints usage for --help"""
    result = ws_state("--help")
    assert result.status == 0
    assert "add-stream" in result.stdout
    assert "Stream statuses" in result.stdout


def test_prints_usage_with_no_command(ws_state):
    """prints usage with no command"""
    result = ws_state()
    assert result.status == 2
    assert "ws-state.py path" in result.stderr


def test_rejects_an_unknown_command(ws_state):
    """rejects an unknown command"""
    result = ws_state("frobnicate")
    assert result.status == 2
    assert "unknown command" in result.stderr


@pytest.mark.parametrize("command", ["path", "show"])
def test_rejects_arguments_the_read_commands_do_not_take(ws_state, command):
    """rejects a stray argument to path and show

    Not in the shell spec, where both commands ignored anything after them.
    """
    result = ws_state(command, "--force")
    assert result.status == 2
    assert "unknown argument" in result.stderr


def test_runs_with_jq_absent_from_path(planned, ws_sandbox, ws_state):
    """runs with jq absent from PATH

    Replaces the shell spec's "requires jq": the Python script parses and writes
    the state file itself, so jq is not a dependency at all. The stub gh is put
    back on the front of the stripped PATH, since resolving the repository still
    goes through gh.
    """
    bare = ws_sandbox.sandbox.path_without("jq")
    result = ws_state("meta", "a", "b", env={"PATH": f"{STUB_BIN}{os.pathsep}{bare}"})
    assert result.status == 0
    assert ws_sandbox.read_state()["meta"] == {"a": "b"}
