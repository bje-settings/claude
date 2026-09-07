"""Canned input for the field-test tests.

Every fixture this plugin's tests read lives here, beside them. Each writer
produces one fixture; `ft_sandbox` wires them together for one test: a temp
state directory holding a live run marker for session `ft-session`, a fake HOME
with Claude's plugin registry, the canned enterprise answer, the pull requests
and reports the harden side checks, and `tests/field-test/bin/gh` ahead of any
real gh on PATH. Tests replace individual pieces to build the negative cases.

Two kinds of fixture live here. `ft_fixture_events` produces one events file per
branch of `plugins/field-test/scripts/lib/collect.py`, so every finding has an
example that reaches it end to end as well as a unit test. `ft_fixture_repo`
builds a real git repository, because the redaction table is derived from real
remotes, branches and commit subjects and a mocked git would prove nothing about
it.

The shapes are reconstructed from field tests of /gh:shepherd and
/workstreams:run, not copied from them: no repo name, PR number, or commit
subject here came from a repository outside the bje enterprise, per CLAUDE.md.
`test_fixtures.py` asserts the claims made here, so the other tests cannot pass
for the wrong reason.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = ROOT / "plugins" / "field-test" / "scripts"
HOOKS = ROOT / "plugins" / "field-test" / "hooks"
STUB_BIN = Path(__file__).resolve().parent / "bin"
COMMANDS = Path(__file__).resolve().parent / "commands"

FT_RUN = SCRIPTS / "ft-run.py"
FT_RESOLVE = SCRIPTS / "ft-resolve.py"
FT_COLLECT = SCRIPTS / "ft-collect.py"
FT_ENTERPRISE = SCRIPTS / "ft-enterprise.py"
FT_REDACT = SCRIPTS / "ft-redact.py"
FT_ISSUE = SCRIPTS / "ft-issue.py"
FT_PREFLIGHT = SCRIPTS / "ft-preflight.py"
FT_HARDEN_STATE = SCRIPTS / "ft-harden-state.py"
FT_VERIFY_REPORT = SCRIPTS / "ft-verify-report.py"
FT_WAIT_PR = SCRIPTS / "ft-wait-pr.py"
HOOK_IO = HOOKS / "hook-io.py"
DENY_LIST = HOOKS / "deny-list.txt"

SESSION = "ft-session"


def load_lib_module(name: str, path):
    """Load one of this plugin's `scripts/lib/` modules by path, under `name`.

    A script puts its own directory on `sys.path` and imports `lib`, which is
    right for a process running one plugin. pytest runs every plugin's tests in
    one process, where the next plugin's `scripts/lib/` would land on the same
    `sys.modules["lib"]` and one of the two would silently win. A path and a
    plugin-unique name cannot collide; registering the module keeps any import
    from inside the package working.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


RESOLVED = {
    "kind": "plugin-skill",
    "plugin": "gh",
    "skill": "shepherd",
    "version": "0.2.0",
    "commit": "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
    "repo": "bje-settings/claude",
    "marketplace_path": "/checkout",
}


def _post(command, exit_code, tool_use_id, stderr="", agent=None):
    record = {
        "ts": "2026-01-02T03:04:06Z",
        "event": "PostToolUse",
        "agent_id": agent[0] if agent else None,
        "agent_type": agent[1] if agent else None,
        "tool_use_id": tool_use_id,
        "command": command,
        "exit_code": exit_code,
        "stderr_tail": stderr,
    }
    return record


def _stop(message, agent=("agent-1", "shepherd-repo")):
    return {
        "ts": "2026-01-02T03:04:08Z",
        "event": "SubagentStop",
        "agent_id": agent[0] if agent else None,
        "agent_type": agent[1] if agent else None,
        "transcript_path": "/transcripts/agent-1.jsonl",
        "last_assistant_message": message,
    }


DENIED_EVENT = {
    "ts": "2026-01-02T03:04:07Z",
    "event": "denied",
    "agent_id": None,
    "agent_type": None,
    "command": "git push --force origin main",
    "reason": "Force-pushing rewrites history other people may already have.",
    "pattern": "force",
}
FETCH_OK = _post("git fetch origin", 0, "t1")
MERGE_FAILED = "GraphQL: Pull request is in unstable status"
SPEC_RUN = "bash spec/run.sh"
AGENT = ("agent-1", "shepherd-repo")
CLAIM = "All four pull requests were merged and the branch is clean."

# One events file per branch of collect.py:
#
#   clean          two Bash calls, both exit 0                     -> no findings
#   nonzero        one exit 0 and the same failing call twice      -> one bash_nonzero, count 2
#   failure        a tool call that failed outright                -> tool_failure
#   denied         a command the PreToolUse hook refused           -> denied
#   deny-error     a deny-list rule that did not compile           -> deny_list_error
#   contradiction  subagent claims success, failure never resolved -> subagent_contradiction
#   retried        same, but the command later succeeded           -> no contradiction
#   honest         subagent reports status failed                  -> no contradiction
#   status-ok      subagent reports a status that is not failed    -> subagent_contradiction
#   args-used      a call carrying --dry-run                       -> no args_dropped
#   no-command     a failed call whose command was never recorded  -> the rest survive
#   hook-error     a hook that raised on one tool call             -> hook_error
#   preceding      five calls before a failure, one with no command-> evidence trail
#   null-agent     a failure and a claim, neither from a subagent  -> no contradiction
#   mixed          one of each severity                            -> ordering and dedupe
EVENTS = {
    "clean": [FETCH_OK, _post("gh pr list --state open", 0, "t2")],
    "nonzero": [
        FETCH_OK,
        _post("gh pr merge --auto --squash 11", 1, "t2", MERGE_FAILED),
        _post("gh pr merge --auto --squash 12", 1, "t3", MERGE_FAILED),
    ],
    "failure": [
        {
            "ts": "2026-01-02T03:04:06Z",
            "event": "PostToolUseFailure",
            "agent_id": None,
            "agent_type": None,
            "tool_use_id": "t1",
            "command": "bash scripts/does-not-exist.sh",
            "exit_code": 127,
            "stderr_tail": "No such file or directory",
        }
    ],
    "denied": [FETCH_OK, DENIED_EVENT],
    "deny-error": [
        {
            "ts": "2026-01-02T03:04:06Z",
            "event": "deny_list_error",
            "agent_id": None,
            "agent_type": None,
            "pattern": "[unclosed",
            "line": 2,
            "error": "unterminated character set at position 0",
            "deny_list": "/plugin/hooks/deny-list.txt",
        },
        _post("git fetch origin", 0, "t1"),
    ],
    "contradiction": [
        _post(SPEC_RUN, 1, "t1", "1 example failed", AGENT),
        _stop(CLAIM),
    ],
    "retried": [
        _post(SPEC_RUN, 1, "t1", "1 example failed", AGENT),
        _post(SPEC_RUN, 0, "t2", "", AGENT),
        _stop(CLAIM),
    ],
    "honest": [
        _post(SPEC_RUN, 1, "t1", "1 example failed", AGENT),
        _stop('{"status": "failed", "question": "the suite does not pass on this branch"}'),
    ],
    "status-ok": [
        _post(SPEC_RUN, 1, "t1", "1 example failed", AGENT),
        _stop('{"status": "ok", "summary": "nothing worth reporting"}'),
    ],
    "preceding": [
        _post("git fetch origin", 0, "t1"),
        _post("git status --short", 0, "t2"),
        _post("gh pr list --state open", 0, "t3"),
        _post("gh pr checks 11", 0, "t4"),
        {"ts": "2026-01-02T03:04:05Z", "event": "Stop", "agent_id": None, "agent_type": None},
        _post("gh pr merge --auto --squash 11", 1, "t5", MERGE_FAILED),
    ],
    "null-agent": [
        _post(SPEC_RUN, 1, "t1", "1 example failed"),
        _stop("All done, merged.", None),
    ],
    "hook-error": [
        {
            "ts": "2026-01-02T03:04:06Z",
            "event": "hook_error",
            "agent_id": None,
            "agent_type": None,
            "hook": "PreToolUse",
            "error": (
                "Traceback (most recent call last):\n"
                '  File "hook-io.py", line 206, in handle_pre_tool_use\n'
                "TypeError: expected string or bytes-like object"
            ),
        },
        _post("git fetch origin", 0, "t1"),
    ],
    "no-command": [
        {
            "ts": "2026-01-02T03:04:06Z",
            "event": "PostToolUseFailure",
            "agent_id": None,
            "agent_type": None,
            "tool_use_id": "t1",
            "command": None,
            "exit_code": None,
            "stderr_tail": "",
        },
        _post("", 2, "t2", "nothing to run"),
        DENIED_EVENT,
    ],
    "args-used": [_post("bash scripts/gh-shepherd-pr.sh status --dry-run", 0, "t1")],
    "mixed": [
        _post("git fetch origin", 0, "t1", "", AGENT),
        _post("gh pr merge --auto --squash 11", 1, "t2", MERGE_FAILED, AGENT),
        {
            "ts": "2026-01-02T03:04:08Z",
            "event": "PostToolUseFailure",
            "agent_id": "agent-1",
            "agent_type": "shepherd-repo",
            "tool_use_id": "t3",
            "command": "bash scripts/does-not-exist.sh",
            "exit_code": 127,
            "stderr_tail": "No such file or directory",
        },
        dict(DENIED_EVENT, agent_id="agent-1", agent_type="shepherd-repo"),
        _stop("Done: every pull request merged."),
    ],
}

# The session transcript, as Claude Code writes it: one JSON object per line. The
# truncated form ends mid-object, which is what a transcript still being written
# looks like when it is read. The tool-tail form ends on an assistant turn holding
# only thinking and tool_use blocks, which is how a real transcript usually ends.
REPORT_TABLE = "| PR | Outcome |\n| --- | --- |\n| #11 | merged |\n| #12 | skipped |"
TRANSCRIPTS = {
    "with-report": (
        '{"type":"user","message":{"content":[{"type":"text","text":"run it"}]}}\n'
        '{"type":"assistant","message":{"content":'
        '[{"type":"text","text":"Starting the round."}]}}\n'
        + json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": REPORT_TABLE}]}}
        )
        + "\n"
    ),
    "no-assistant": '{"type":"user","message":{"content":[{"type":"text","text":"run it"}]}}\n',
    "tool-tail": (
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [{"type": "text", "text": "| PR | Outcome |\n| #11 | merged |"}]
                },
            }
        )
        + "\n"
        + json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "thinking", "thinking": "one more check"},
                        {
                            "type": "tool_use",
                            "name": "Bash",
                            "input": {"command": "gh pr view 11"},
                        },
                    ]
                },
            }
        )
        + "\n"
    ),
    "truncated": (
        '{"type":"assistant","message":{"content":[{"type":"text","text":"the whole line"}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","tex\n'
    ),
}


def hook_payloads(session=SESSION):
    """One payload per shape a hook is handed."""
    return {
        "post-ok": {
            "session_id": session,
            "transcript_path": "/transcripts/main.jsonl",
            "tool_name": "Bash",
            "tool_use_id": "t1",
            "tool_input": {"command": "git fetch origin"},
            "tool_response": {"stdout": "", "stderr": "", "exit_code": 0},
        },
        "post-bool-code": {
            "session_id": session,
            "transcript_path": "/transcripts/main.jsonl",
            "tool_name": "Bash",
            "tool_use_id": "t1",
            "tool_input": {"command": "git fetch origin"},
            "tool_response": {"stdout": "", "stderr": "", "code": True},
        },
        "post-fail": {
            "session_id": session,
            "transcript_path": "/transcripts/main.jsonl",
            "tool_name": "Bash",
            "agent_id": "agent-1",
            "agent_type": "shepherd-repo",
            "tool_use_id": "t2",
            "tool_input": {"command": "gh pr merge --auto --squash 11"},
            "tool_response": {"stdout": "", "stderr": MERGE_FAILED, "exitCode": 1},
        },
        # The real shape: a PostToolUseFailure payload carries no tool_response at
        # all. The failure arrives as a top-level error string whose first line is
        # the exit code and whose remainder is the command's output.
        "post-failure": {
            "session_id": session,
            "tool_name": "Bash",
            "tool_use_id": "t3",
            "tool_input": {"command": "bash scripts/does-not-exist.sh"},
            "error": "Exit code 127\nbash: scripts/does-not-exist.sh: No such file or directory",
            "is_interrupt": False,
            "duration_ms": 12,
        },
        # The same event for a tool whose error text does not open with an exit code.
        "post-failure-no-code": {
            "session_id": session,
            "tool_name": "Bash",
            "tool_use_id": "t4",
            "tool_input": {"command": "sleep 30"},
            "error": "The user interrupted the command",
            "is_interrupt": True,
            "duration_ms": 900,
        },
        "pre-deny": {
            "session_id": session,
            "tool_name": "Bash",
            "tool_input": {"command": "git push --force origin main"},
        },
        "pre-allow": {
            "session_id": session,
            "tool_name": "Bash",
            "tool_input": {"command": "git push --force-with-lease origin wktr-9-fix"},
        },
        "pre-other": {
            "session_id": session,
            "tool_name": "Read",
            "tool_input": {"file_path": "/checkout/README.md"},
        },
        # transcript_path on a SubagentStop is the main session's; the subagent's
        # own is agent_transcript_path.
        "subagent-stop": {
            "session_id": session,
            "agent_id": "agent-1",
            "agent_type": "shepherd-repo",
            "transcript_path": "/transcripts/main.jsonl",
            "agent_transcript_path": "/transcripts/agent-1.jsonl",
            "last_assistant_message": "All four pull requests were merged.",
        },
        "stop": {
            "session_id": session,
            "transcript_path": "/transcripts/main.jsonl",
            "last_assistant_message": "Rebased and pushed; waiting on checks.",
        },
    }


# Five issues: two open field-test issues carrying a signature the duplicate
# search must find, one of them holding the quotes a real command holds, and
# three near misses it must not match.
ISSUES = [
    {
        "number": 40,
        "title": "fix: gh:shepherd: gh pr merge --auto --squash N",
        "state": "OPEN",
        "labels": [{"name": "bug"}, {"name": "field-test"}],
        "body": (
            "Signature: `bash_nonzero:gh pr merge --auto --squash N`\n\nSeen on an earlier round."
        ),
    },
    {
        "number": 41,
        "title": "fix: gh:shepherd: something else entirely",
        "state": "OPEN",
        "labels": [{"name": "bug"}, {"name": "field-test"}],
        "body": "Signature: `bash_nonzero:git fetch origin`",
    },
    {
        "number": 42,
        "title": "fix: gh:shepherd: gh pr merge --auto --squash N",
        "state": "CLOSED",
        "labels": [{"name": "bug"}, {"name": "field-test"}],
        "body": "Signature: `bash_nonzero:gh pr merge --auto --squash N`\n\nAlready fixed.",
    },
    {
        "number": 43,
        "title": "chore: unrelated",
        "state": "OPEN",
        "labels": [{"name": "chore"}],
        "body": (
            "Mentions bash_nonzero:gh pr merge --auto --squash N but is not a field-test issue."
        ),
    },
    {
        "number": 44,
        "title": "fix: gh:shepherd: gh pr comment",
        "state": "OPEN",
        "labels": [{"name": "bug"}, {"name": "field-test"}],
        "body": (
            'Signature: `bash_nonzero:gh pr comment -b "done" N`\n\nA signature holding quotes.'
        ),
    },
]


# Twelve pull requests, one per arm of `lib/checks.py` plus the states and the
# two that change across polls:
#
#   50 open, every check green, skipped, or neutral      checks pass
#   51 open, a FAILURE beside a SUCCESS                  checks fail
#   52 open, a run still in progress and a PENDING       checks pending
#   53 open, no checks at all                            checks none
#   54 merged                                            state MERGED
#   55 closed unmerged                                   state CLOSED
#   56 open, a COMPLETED run with no conclusion          checks pending
#   57 open, CANCELLED beside SUCCESS                    checks fail
#   58 open, pending on the first look then green        a sequence; green stays
#   59 open, a commit status in FAILURE beside a green   checks fail (StatusContext)
#   60 open, a FAILURE beside a run still in progress    checks fail, not pending
#   61 open, no checks on the first look, then a run     a sequence; none then pending
def _check(name, status, conclusion):
    return {
        "__typename": "CheckRun",
        "name": name,
        "status": status,
        "conclusion": conclusion,
    }


def _context(context, state):
    return {"__typename": "StatusContext", "context": context, "state": state}


PRS = [
    {
        "number": 50,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("bash-5", "COMPLETED", "SUCCESS"),
            _check("shellcheck", "COMPLETED", "SKIPPED"),
            _check("codeql", "COMPLETED", "NEUTRAL"),
            _context("coverage", "SUCCESS"),
        ],
    },
    {
        "number": 51,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("bash-5", "COMPLETED", "SUCCESS"),
            _check("coverage", "COMPLETED", "FAILURE"),
        ],
    },
    {
        "number": 52,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("bash-3.2", "IN_PROGRESS", None),
            _context("coverage", "PENDING"),
        ],
    },
    {"number": 53, "state": "OPEN", "isDraft": False, "statusCheckRollup": []},
    {
        "number": 54,
        "state": "MERGED",
        "isDraft": False,
        "statusCheckRollup": [_context("ci", "SUCCESS")],
    },
    {"number": 55, "state": "CLOSED", "isDraft": False, "statusCheckRollup": []},
    {
        "number": 56,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [_check("bash-5", "COMPLETED", None)],
    },
    {
        "number": 57,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("bash-5", "COMPLETED", "SUCCESS"),
            _check("coverage", "COMPLETED", "CANCELLED"),
        ],
    },
    {
        "number": 58,
        "state": "OPEN",
        "isDraft": True,
        "statusCheckRollup": [_check("bash-5", "COMPLETED", "SUCCESS")],
        "sequence": [
            {"statusCheckRollup": [_check("bash-5", "IN_PROGRESS", None)]},
            {"statusCheckRollup": [_check("bash-5", "COMPLETED", "SUCCESS")]},
        ],
    },
    {
        "number": 59,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("bash-5", "COMPLETED", "SUCCESS"),
            _context("coverage", "FAILURE"),
        ],
    },
    {
        "number": 60,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [
            _check("coverage", "COMPLETED", "FAILURE"),
            _check("bash-3.2", "IN_PROGRESS", None),
        ],
    },
    {
        "number": 61,
        "state": "OPEN",
        "isDraft": False,
        "statusCheckRollup": [_check("bash-5", "IN_PROGRESS", None)],
        "sequence": [{"statusCheckRollup": []}],
    },
    # A state no reader here knows, with nothing in the rollup: the shape that
    # used to fall through the state arms and be reported as a pass.
    {"number": 62, "state": "LOCKED", "isDraft": False, "statusCheckRollup": []},
]

# What a field-test report claimed about the pull requests of one round.
#
#   accurate   every claim holds against PRS
#   wrong      claims a pull request merged that is still open
#   unknown    uses a word the verifier cannot check
#   missing    names a pull request that does not exist
REPORTS = {
    "accurate": {
        "repo": "acme-org/plugins",
        "prs": [
            {"number": 54, "claimed": "merged"},
            {"number": 50, "claimed": "skipped"},
            {"number": 55, "claimed": "closed"},
        ],
    },
    "wrong": {"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "merged"}]},
    "unknown": {"repo": "acme-org/plugins", "prs": [{"number": 50, "claimed": "shepherded"}]},
    "missing": {"repo": "acme-org/plugins", "prs": [{"number": 999, "claimed": "merged"}]},
}


def write_json(path, document) -> None:
    Path(path).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def ft_fixture_run(path, target="gh:shepherd", args=None, resolved=RESOLVED) -> None:
    """One run marker, unfinished."""
    write_json(
        path,
        {
            "version": 1,
            "session_id": SESSION,
            "target": target,
            "args": ["--dry-run"] if args is None else args,
            "cwd": "/checkout",
            "resolved": resolved,
            "claude_version": "2.1.263 (Claude Code)",
            "started_at": "2026-01-02T03:04:05Z",
            "finished_at": None,
        },
    )


def ft_fixture_events(path, case="clean") -> None:
    """One events.jsonl per branch of collect.py."""
    if case not in EVENTS:
        raise KeyError(f"ft_fixture_events: unknown case: {case}")
    text = "".join(json.dumps(event) + "\n" for event in EVENTS[case])
    Path(path).write_text(text, encoding="utf-8")


def ft_fixture_transcript(path, case="with-report") -> None:
    if case not in TRANSCRIPTS:
        raise KeyError(f"ft_fixture_transcript: unknown case: {case}")
    Path(path).write_text(TRANSCRIPTS[case], encoding="utf-8")


def ft_fixture_hook_input(case, session=SESSION) -> str:
    """One hook payload, as the JSON text a hook reads on stdin."""
    payloads = hook_payloads(session)
    if case not in payloads:
        raise KeyError(f"ft_fixture_hook_input: unknown case: {case}")
    return json.dumps(payloads[case])


def ft_fixture_installed_plugins(path, install, variant="with-skill") -> None:
    """The shape of ~/.claude/plugins/installed_plugins.json, version 2."""
    if variant == "with-skill":
        skill = Path(install) / "skills" / "shepherd"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text("---\nname: shepherd\n---\n", encoding="utf-8")
    write_json(
        path,
        {
            "version": 2,
            "plugins": {
                "gh@bje": [{"scope": "user", "installPath": str(install), "version": "0.2.0"}],
                "pr-review-toolkit@official": [
                    {"scope": "user", "installPath": f"{install}-other", "version": "abc123"}
                ],
            },
        },
    )


def ft_fixture_marketplaces(path, directory, kind="directory") -> None:
    """The shape of ~/.claude/plugins/known_marketplaces.json."""
    if kind == "directory":
        document = {
            "bje": {
                "source": {"source": "directory", "path": str(directory)},
                "installLocation": str(directory),
                "lastUpdated": "2026-01-02T03:04:05Z",
            },
            "official": {
                "source": {"source": "github", "repo": "anthropics/claude-plugins-official"},
                "installLocation": f"{directory}-cache",
                "lastUpdated": "2026-01-02T03:04:05Z",
            },
        }
    else:
        document = {
            "bje": {
                "source": {"source": "github", "repo": "bje-settings/claude"},
                "installLocation": f"{directory}-cache",
                "lastUpdated": "2026-01-02T03:04:05Z",
            }
        }
    write_json(path, document)


def ft_fixture_git(directory, *args):
    """git with identity supplied per command, so no global config is needed."""
    return subprocess.run(
        [
            "git",
            "-C",
            str(directory),
            "-c",
            "user.name=Field Test",
            "-c",
            "user.email=field-test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
            *args,
        ],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8", "replace")


def ft_fixture_repo(directory, slug="acme-org/widgets", form="ssh"):
    """A real repository with a remote, two branches, and two commits.

    That is what the redaction table is built from, and a mocked git would prove
    nothing about it. `alias` writes the remote through an ssh host alias, which
    is how one machine holds two GitHub accounts.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    ft_fixture_git(directory, "init", "-q", "-b", "main")
    (directory / "README.md").write_text("one\n", encoding="utf-8")
    ft_fixture_git(directory, "add", "README.md")
    ft_fixture_git(directory, "commit", "-q", "-m", "feat: the first commit subject")
    ft_fixture_git(directory, "checkout", "-q", "-b", "wktr-9-widget-fix")
    (directory / "README.md").write_text("one\ntwo\n", encoding="utf-8")
    ft_fixture_git(directory, "commit", "-q", "-am", "fix: the widget drops its last field")
    urls = {
        "ssh": f"git@github.com:{slug}.git",
        "https": f"https://github.com/{slug}.git",
        "alias": f"git@github.com-work:{slug}.git",
    }
    if form in urls:
        ft_fixture_git(directory, "remote", "add", "origin", urls[form])
    return directory


def ft_fixture_enterprise(directory, mode="both") -> None:
    """The canned answer tests/field-test/bin/gh gives to the enterprise query."""
    Path(directory).mkdir(parents=True, exist_ok=True)
    (Path(directory) / "enterprise-mode").write_text(mode, encoding="utf-8")


def ft_fixture_issues(path) -> None:
    write_json(path, ISSUES)


def ft_fixture_prs(path, prs=None) -> None:
    """The pull requests tests/field-test/bin/gh serves to `gh pr view`."""
    write_json(path, PRS if prs is None else prs)


def ft_fixture_report(path, case="accurate") -> None:
    """One round's report, as the harden loop writes it before verifying it."""
    if case not in REPORTS:
        raise KeyError(f"ft_fixture_report: unknown case: {case}")
    write_json(path, REPORTS[case])


class FtSandbox:
    """One test's field-test world: a live run, a fake HOME, canned gh answers."""

    def __init__(self, sandbox, monkeypatch, state_dir, home, gh_dir) -> None:
        self.sandbox = sandbox
        self.monkeypatch = monkeypatch
        self.path = sandbox.path
        self.state_dir = state_dir
        self.home = home
        self.gh_dir = gh_dir
        self.run_dir = state_dir / "runs" / SESSION
        self.installed_plugins = home / ".claude" / "plugins" / "installed_plugins.json"
        self.marketplaces = home / ".claude" / "plugins" / "known_marketplaces.json"
        self.user_dir = home / ".claude"
        self.install_dir = sandbox.path / "installed" / "gh"
        self.prs = gh_dir / "prs.json"
        self.report = sandbox.path / "report.json"
        self.harden_state = state_dir / "harden" / "gh__shepherd.json"
        self.plugin_checkout = sandbox.path / "plugin-repo"

    @property
    def marker(self) -> Path:
        return self.run_dir / "run.json"

    @property
    def events(self) -> Path:
        return self.run_dir / "events.jsonl"

    def read_marker(self):
        return json.loads(self.marker.read_text(encoding="utf-8"))

    def read_events(self):
        return [
            json.loads(line)
            for line in self.events.read_text(encoding="utf-8").split("\n")
            if line.strip()
        ]

    def setenv(self, name, value) -> None:
        self.monkeypatch.setenv(name, str(value))

    def delenv(self, name) -> None:
        self.monkeypatch.delenv(name, raising=False)


@pytest.fixture
def ft_sandbox(sandbox, monkeypatch) -> FtSandbox:
    """One wired-up sandbox: state directory, HOME, and the stub gh on PATH."""
    state_dir = sandbox.path / "state"
    home = sandbox.path / "ft-home"
    gh_dir = sandbox.path / "gh"
    (home / ".claude" / "plugins").mkdir(parents=True)
    gh_dir.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("FT_STATE_DIR", str(state_dir))
    monkeypatch.setenv("FT_GH_FIXTURE_DIR", str(gh_dir))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SESSION)
    for name in ("FT_GH_FIXTURE_FAIL", "CLAUDE_PLUGIN_DATA", "FT_GH", "FT_DENY_LIST"):
        monkeypatch.delenv(name, raising=False)

    ft = FtSandbox(sandbox, monkeypatch, state_dir, home, gh_dir)
    monkeypatch.setenv("FT_INSTALLED_PLUGINS", str(ft.installed_plugins))
    monkeypatch.setenv("FT_MARKETPLACES", str(ft.marketplaces))
    monkeypatch.setenv("FT_USER_DIR", str(ft.user_dir))
    ft.run_dir.mkdir(parents=True)
    ft_fixture_enterprise(gh_dir, "both")
    ft_fixture_issues(gh_dir / "issues.json")
    ft_fixture_prs(ft.prs)
    ft_fixture_installed_plugins(ft.installed_plugins, ft.install_dir)
    ft_fixture_marketplaces(ft.marketplaces, ft.plugin_checkout)
    ft_fixture_run(ft.marker)
    ft.events.write_text("", encoding="utf-8")
    sandbox.stub_path(STUB_BIN)
    return ft


@pytest.fixture
def run_with_no_reader():
    """Run a script whose stdout is a pipe nobody is reading.

    `ft-run.py show | head` is the real case, and a hook whose stdout Claude Code
    stopped reading is the other. A pipe with its read end already closed is the
    deterministic version: the first write gets EPIPE, and Python raises
    BrokenPipeError rather than dying on the signal the shell relied on.
    """

    def run(path, *args, env=None, stdin=b""):
        read_fd, write_fd = os.pipe()
        os.close(read_fd)
        child_env = dict(os.environ)
        child_env.update({key: str(value) for key, value in (env or {}).items()})
        if isinstance(stdin, str):
            stdin = stdin.encode("utf-8")
        try:
            return subprocess.run(
                [sys.executable, str(path), *[str(argument) for argument in args]],
                input=stdin,
                stdout=write_fd,
                stderr=subprocess.PIPE,
                env=child_env,
                check=False,
            )
        finally:
            os.close(write_fd)

    return run


@pytest.fixture
def ft_hook(run_script):
    """Run hook-io.py for one event with a payload on stdin, as Claude Code does."""

    def run(event, payload, script=HOOK_IO, env=None):
        if isinstance(payload, dict):
            payload = json.dumps(payload)
        args = [] if event is None else [event]
        return run_script(script, *args, stdin=payload, env=env)

    return run


@pytest.fixture
def run_gh(run_script):
    """Run the stub gh the way a script on PATH would."""

    def run(*args, env=None):
        return run_script(STUB_BIN / "gh", *args, env=env)

    return run


def deny_patterns():
    """Every pattern in the plugin's deny list, in file order."""
    return [
        line.strip()
        for line in DENY_LIST.read_text(encoding="utf-8").split("\n")
        if line.strip() and not line.strip().startswith("#")
    ]


def sample_commands(name):
    """One command per line from tests/field-test/commands/<name>."""
    return [
        line for line in (COMMANDS / name).read_text(encoding="utf-8").split("\n") if line.strip()
    ]
