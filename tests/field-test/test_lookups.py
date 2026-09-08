"""Unit tests for the field-test lookup libraries, one per arm.

`gitinfo.py`, `registry.py`, `enterprise.py` and `run.py` hold what the shell
did with parameter expansion and what jq did with `INSTALLED_ROWS_JQ`,
`MARKETPLACE_PATH_JQ` and the two enterprise readers. Each arm is named here
because none of them moved a coverage number before
(`.claude/rules/type-py.md`), and because a wrong answer from any of them is a
repository name in a public issue or an issue filed against nothing.
"""

from __future__ import annotations

import json
import os

import pytest
from conftest import SCRIPTS, ft_fixture_repo, load_lib_module

gitinfo = load_lib_module("field_test_lib_gitinfo", SCRIPTS / "lib" / "gitinfo.py")
registry = load_lib_module("field_test_lib_registry", SCRIPTS / "lib" / "registry.py")
enterprise = load_lib_module("field_test_lib_enterprise", SCRIPTS / "lib" / "enterprise.py")
run_lib = load_lib_module("field_test_lib_run", SCRIPTS / "lib" / "run.py")

ROOT_USER = os.geteuid() == 0
not_as_root = pytest.mark.skipif(ROOT_USER, reason="running as root, permissions do not apply")


# --- gitinfo.owner_repo_of ---------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("git@github.com:acme-org/widgets.git", "acme-org/widgets"),
        ("https://github.com/acme-org/widgets.git", "acme-org/widgets"),
        ("https://github.com/acme-org/widgets", "acme-org/widgets"),
        # An ssh host alias, which is how one machine holds two GitHub accounts.
        # Anchored on "github.com" this reads as the owner "-work:acme-org".
        ("git@github.com-work:acme-org/widgets.git", "acme-org/widgets"),
        ("ssh://git@github.com/acme-org/widgets.git", "acme-org/widgets"),
    ],
)
def test_owner_repo_of_reads_every_spelling(url, expected):
    assert gitinfo.owner_repo_of(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "",
        "git@github.com:singleton.git",
        "https://example.invalid/a/b/c/d.git",
    ],
)
def test_owner_repo_of_answers_nothing_for_a_url_naming_no_repository(url):
    assert gitinfo.owner_repo_of(url) == ""


# --- gitinfo against a real checkout -----------------------------------------


def test_owner_of_reads_the_origin_remote(tmp_path):
    directory = ft_fixture_repo(tmp_path / "r", "acme-org/widgets")
    assert gitinfo.owner_of(str(directory)) == "acme-org"


def test_owner_of_a_checkout_with_no_remote_is_nothing(tmp_path):
    directory = ft_fixture_repo(tmp_path / "r", "acme-org/widgets", "none")
    assert gitinfo.owner_of(str(directory)) == ""


def test_git_of_a_directory_that_is_not_a_checkout_answers_nothing(tmp_path):
    assert gitinfo.git(str(tmp_path), "rev-parse", "--git-dir") == ""


def test_git_that_cannot_be_run_answers_nothing(tmp_path, monkeypatch):
    """A machine with no git is not a reason to fail with a traceback."""
    monkeypatch.setenv("PATH", str(tmp_path))
    assert gitinfo.git(str(tmp_path), "rev-parse", "HEAD") == ""


# --- registry.installed_rows -------------------------------------------------


def registry_document(**plugins):
    return {"version": 2, "plugins": plugins}


def test_installed_rows_names_every_copy_of_the_plugin():
    document = registry_document(
        **{
            "gh@bje": [
                {"installPath": "/a", "version": "0.1.0"},
                {"installPath": "/b", "version": "0.2.0"},
            ]
        }
    )
    assert registry.installed_rows(document, "gh") == [
        ("bje", "/a", "0.1.0"),
        ("bje", "/b", "0.2.0"),
    ]


def test_installed_rows_ignores_another_plugin():
    document = registry_document(**{"workstreams@bje": [{"installPath": "/a"}]})
    assert registry.installed_rows(document, "gh") == []


def test_installed_rows_ignores_a_plugin_whose_name_only_starts_the_same():
    document = registry_document(**{"gh-security@bje": [{"installPath": "/a"}]})
    assert registry.installed_rows(document, "gh") == []


def test_installed_rows_of_a_registry_with_no_plugins_is_empty():
    assert registry.installed_rows({"version": 2}, "gh") == []


def test_installed_rows_ignores_a_copy_that_is_not_an_object():
    document = registry_document(**{"gh@bje": ["not a copy"]})
    assert registry.installed_rows(document, "gh") == []


def test_installed_rows_ignores_an_entry_that_is_not_a_list():
    document = registry_document(**{"gh@bje": {"installPath": "/a"}})
    assert registry.installed_rows(document, "gh") == []


def test_installed_rows_refuses_a_registry_that_is_not_an_object():
    with pytest.raises(registry.RegistryError):
        registry.installed_rows([], "gh")


def test_installed_rows_refuses_plugins_that_is_not_an_object():
    """A registry whose shape has changed is not a plugin that is not installed."""
    with pytest.raises(registry.RegistryError):
        registry.installed_rows({"plugins": [{"name": "gh"}]}, "gh")


# --- registry.marketplace_path -----------------------------------------------


def test_marketplace_path_reads_a_directory_source():
    document = {"bje": {"source": {"source": "directory", "path": "/checkout"}}}
    assert registry.marketplace_path(document, "bje") == "/checkout"


def test_marketplace_path_falls_back_to_the_install_location():
    document = {"bje": {"source": {"source": "directory"}, "installLocation": "/elsewhere"}}
    assert registry.marketplace_path(document, "bje") == "/elsewhere"


def test_marketplace_path_of_a_github_marketplace_is_nothing():
    """There is no checkout to name a commit against."""
    document = {"bje": {"source": {"source": "github", "repo": "bje-settings/claude"}}}
    assert registry.marketplace_path(document, "bje") == ""


def test_marketplace_path_of_an_unknown_marketplace_is_nothing():
    assert registry.marketplace_path({}, "bje") == ""


def test_marketplace_path_of_a_document_that_is_not_an_object_is_nothing():
    assert registry.marketplace_path([], "bje") == ""


def test_marketplace_path_of_an_entry_with_no_source_is_nothing():
    assert registry.marketplace_path({"bje": {"installLocation": "/x"}}, "bje") == ""


# --- enterprise --------------------------------------------------------------


def viewer(nodes):
    return {"data": {"viewer": {"enterprises": {"nodes": nodes}}}}


def an_enterprise(slug, logins, more=False, cursor=None):
    return {
        "slug": slug,
        "organizations": {
            "pageInfo": {"hasNextPage": more, "endCursor": cursor},
            "nodes": [{"login": login} for login in logins],
        },
    }


def test_enterprise_nodes_of_an_answer_with_none_is_none():
    """Not an empty list: a token without the scope must not read as "no enterprise"."""
    assert enterprise.enterprise_nodes({"data": {"viewer": {}}}) is None


def test_enterprise_nodes_of_something_that_is_not_an_answer_is_none():
    assert enterprise.enterprise_nodes(None) is None


def test_enterprise_nodes_of_an_empty_list_is_an_empty_list():
    assert enterprise.enterprise_nodes(viewer([])) == []


def test_enterprise_rows_carry_the_slug_and_the_cursor():
    document = viewer([an_enterprise("acme", ["acme-org"], True, "CURSOR1")])
    assert enterprise.enterprise_rows(document) == [("acme", True, "CURSOR1")]


def test_enterprise_rows_report_no_next_page_when_there_is_none():
    document = viewer([an_enterprise("acme", ["acme-org"])])
    assert enterprise.enterprise_rows(document) == [("acme", False, "")]


def test_enterprise_rows_skip_a_node_that_is_not_an_object():
    assert enterprise.enterprise_rows(viewer(["nope"])) == []


def test_logins_of_reads_one_enterprise():
    document = viewer(
        [an_enterprise("other", ["unrelated"]), an_enterprise("acme", ["acme-org", "acme-tools"])]
    )
    assert enterprise.logins_of(document, "acme") == ["acme-org", "acme-tools"]


def test_logins_of_an_enterprise_that_is_not_there_is_empty():
    assert enterprise.logins_of(viewer([an_enterprise("acme", ["a"])]), "other") == []


def test_page_of_reads_the_next_page():
    page = {
        "data": {
            "enterprise": {
                "organizations": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [{"login": "acme-tools"}],
                }
            }
        }
    }
    assert enterprise.page_of(page) == (["acme-tools"], False, "")


def test_page_of_an_answer_with_no_enterprise_is_empty():
    assert enterprise.page_of({"data": {}}) == ([], False, "")


# --- run ---------------------------------------------------------------------


def test_state_dir_prefers_ft_state_dir():
    assert run_lib.state_dir({"FT_STATE_DIR": "/a", "CLAUDE_PLUGIN_DATA": "/b"}) == "/a"


def test_state_dir_falls_back_to_claude_plugin_data():
    assert run_lib.state_dir({"CLAUDE_PLUGIN_DATA": "/b"}) == "/b"


def test_state_dir_of_neither_is_empty():
    assert run_lib.state_dir({}) == ""


def test_live_run_dir_finds_an_unfinished_run(tmp_path):
    directory = tmp_path / "runs" / "s1"
    directory.mkdir(parents=True)
    (directory / "run.json").write_text(json.dumps({"finished_at": None}))
    assert run_lib.live_run_dir("s1", {"FT_STATE_DIR": str(tmp_path)}) == str(directory)


def test_live_run_dir_of_a_finished_run_is_none(tmp_path):
    directory = tmp_path / "runs" / "s1"
    directory.mkdir(parents=True)
    (directory / "run.json").write_text(json.dumps({"finished_at": "2026-01-02T04:00:00Z"}))
    assert run_lib.live_run_dir("s1", {"FT_STATE_DIR": str(tmp_path)}) is None


def test_live_run_dir_without_a_marker_is_none(tmp_path):
    assert run_lib.live_run_dir("s1", {"FT_STATE_DIR": str(tmp_path)}) is None


def test_live_run_dir_without_a_session_is_none(tmp_path):
    assert run_lib.live_run_dir("", {"FT_STATE_DIR": str(tmp_path)}) is None


def test_live_run_dir_without_a_state_dir_is_none():
    assert run_lib.live_run_dir("s1", {}) is None


def test_load_marker_of_a_file_that_is_not_json_is_none(tmp_path):
    path = tmp_path / "run.json"
    path.write_text("nope")
    assert run_lib.load_marker(str(path)) is None


def test_load_marker_of_json_that_is_not_an_object_is_none(tmp_path):
    path = tmp_path / "run.json"
    path.write_text("[]")
    assert run_lib.load_marker(str(path)) is None


def test_write_json_leaves_no_temp_file_behind(tmp_path):
    path = tmp_path / "run.json"
    run_lib.write_json(str(path), {"a": 1})
    assert json.loads(path.read_text()) == {"a": 1}
    assert list(tmp_path.iterdir()) == [path]


@not_as_root
def test_write_json_cleans_up_after_a_write_it_cannot_finish(tmp_path):
    directory = tmp_path / "locked"
    directory.mkdir()
    directory.chmod(0o555)
    try:
        with pytest.raises(OSError):
            run_lib.write_json(str(directory / "run.json"), {"a": 1})
        assert list(directory.iterdir()) == []
    finally:
        directory.chmod(0o755)


def test_note_transcript_records_the_path_once(tmp_path):
    path = tmp_path / "run.json"
    path.write_text(json.dumps({"finished_at": None}))
    assert run_lib.note_transcript(str(tmp_path), "/transcripts/main.jsonl") == (True, "")
    # The second hook to see one finds it already there, which is a success and
    # not a write: only the first hook of a run records it.
    assert run_lib.note_transcript(str(tmp_path), "/transcripts/second.jsonl") == (True, "")
    assert json.loads(path.read_text())["transcript_path"] == "/transcripts/main.jsonl"


def test_note_transcript_with_nothing_to_record_does_nothing(tmp_path):
    path = tmp_path / "run.json"
    path.write_text(json.dumps({"finished_at": None}))
    assert run_lib.note_transcript(str(tmp_path), None) == (True, "")
    assert "transcript_path" not in json.loads(path.read_text())


def test_note_transcript_without_a_marker_does_nothing(tmp_path):
    assert run_lib.note_transcript(str(tmp_path), "/transcripts/main.jsonl") == (True, "")
    assert list(tmp_path.iterdir()) == []


@not_as_root
def test_note_transcript_reports_a_marker_it_cannot_write(tmp_path):
    """Reported, not swallowed: this is the only place the transcript is learned.

    A run whose marker never took the path is why `ft-collect.py --report` says
    afterwards that no hook event carried one. Silent, that message is untrue, and
    it is the one output whose whole job is telling "the target said nothing"
    apart from "this could not find out".
    """
    path = tmp_path / "run.json"
    path.write_text(json.dumps({"finished_at": None}))
    tmp_path.chmod(0o555)
    try:
        ok, error = run_lib.note_transcript(str(tmp_path), "/transcripts/main.jsonl")
    finally:
        tmp_path.chmod(0o755)
    assert ok is False
    assert error
    assert "transcript_path" not in json.loads(path.read_text())


def test_append_event_writes_one_line_per_record(tmp_path):
    run_lib.append_event(str(tmp_path), {"event": "Stop"})
    run_lib.append_event(str(tmp_path), {"event": "PostToolUse"})
    lines = (tmp_path / "events.jsonl").read_text().strip().split("\n")
    assert [json.loads(line)["event"] for line in lines] == ["Stop", "PostToolUse"]


def test_append_event_gives_up_quietly_when_it_cannot_write(tmp_path):
    """A hook that cannot record must still let the tool call through."""
    ok, error = run_lib.append_event(str(tmp_path / "nowhere"), {"event": "Stop"})
    assert ok is False
    # Reported rather than swallowed: an event that was never recorded is a
    # finding that never reaches an issue, and only the caller can say so.
    assert error


def test_append_event_says_so_when_the_record_cannot_be_encoded(tmp_path):
    """A record json.dumps refuses is a failure to report, not a traceback.

    ValueError is caught beside OSError so that a record which does not serialise
    is one unrecorded event rather than the reason a session stops.
    """
    record = {"event": "Stop"}
    record["self"] = record
    ok, error = run_lib.append_event(str(tmp_path), record)
    assert ok is False
    assert error


def test_append_event_escapes_a_lone_surrogate_rather_than_failing(tmp_path):
    """A tool_response can carry a lone surrogate; escaped, it is only ASCII.

    With ensure_ascii=False this write would raise on the way to a UTF-8 file and
    the event would be lost, which is the second reason the shell's spelling is
    the right one here.
    """
    ok, error = run_lib.append_event(str(tmp_path), {"event": "Stop", "note": "a\ud800b"})
    assert (ok, error) == (True, "")
    assert b"\\ud800" in (tmp_path / "events.jsonl").read_bytes()


def test_append_event_escapes_a_record_the_way_jq_did(tmp_path):
    """Escaped, not written as raw UTF-8: jq's own output, and the bytes the shell wrote."""
    ok, error = run_lib.append_event(str(tmp_path), {"event": "Stop", "note": "caf\u00e9"})
    assert (ok, error) == (True, "")
    written = (tmp_path / "events.jsonl").read_bytes()
    assert b"caf\\u00e9" in written
    assert "café".encode() not in written


def test_write_json_escapes_a_marker_the_way_the_hook_did(tmp_path):
    """The marker is written compact and ASCII-escaped, as the hook on main wrote it."""
    path = tmp_path / "run.json"
    run_lib.write_json(str(path), {"cwd": "/tmp/caf\u00e9"})
    assert path.read_bytes() == b'{"cwd": "/tmp/caf\\u00e9"}\n'


def test_write_json_cleans_up_after_a_document_it_cannot_encode(tmp_path):
    """The temp file goes on a ValueError too, not only on an OSError.

    Half a marker left behind under a .tmp name is not the failure; the failure is
    the next run finding it and having to guess what it was.
    """
    path = tmp_path / "run.json"
    document = {}
    document["self"] = document
    with pytest.raises(ValueError):
        run_lib.write_json(str(path), document)
    assert list(tmp_path.iterdir()) == []


def test_now_is_the_marker_timestamp_format():
    stamp = run_lib.now()
    assert len(stamp) == 20
    assert stamp.endswith("Z")
