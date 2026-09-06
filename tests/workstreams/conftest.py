"""Canned GitHub data for the workstreams tests.

The Python counterpart of `fixtures/workstreams/fixtures.sh` and of
`setup_ws_sandbox` in `spec/spec_helper.sh`. Each writer produces one fixture
file that `tests/workstreams/bin/gh` serves; `ws_sandbox` wires them together
for one test: a temp dir with the canned data, an empty state dir, a fake HOME,
and the stub ahead of any real gh on PATH. Tests remove or replace individual
pieces to build the negative cases.

The shapes are reconstructed from the field test in issue #7 (a debugging
session that produced two bugs, a chore, a refactor, and a spike) without
copying anything from that repository. `test_fixtures.py` asserts the claims
made here, so the other tests cannot pass for the wrong reason.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
WS_STATE = ROOT / "plugins" / "workstreams" / "scripts" / "ws-state.py"
STUB_BIN = Path(__file__).resolve().parent / "bin"

# Seven records:
#   1 bug      open   refs #2 and #4 in its body                    (work now, touches src/parser)
#   2 chore    open   no body                                       (mechanical)
#   3 refactor open   refs #1, and mentions itself as #3            (collides with #1)
#   4 spike    open   milestone "observe"                           (defer)
#   5 bug      closed refs nothing                                  (already done)
#   6 docs     open   label "docs", body has a `#7` inside a url    (not a reference)
#   7 pull request, open: gh issue view answers with a /pull/ url   (not an issue)
ISSUES = [
    {
        "number": 1,
        "title": "fix: parser drops trailing field",
        "state": "OPEN",
        "url": "https://example.invalid/i/1",
        "labels": [{"name": "bug"}],
        "milestone": None,
        "body": (
            "Seen in the logs from #2. Touches src/parser.sh. Might be the same root cause as #4."
        ),
    },
    {
        "number": 2,
        "title": "chore: pin the linter",
        "state": "OPEN",
        "url": "https://example.invalid/i/2",
        "labels": [{"name": "chore"}],
        "milestone": None,
        "body": None,
    },
    {
        "number": 3,
        "title": "refactor: split parser into read and emit",
        "state": "OPEN",
        "url": "https://example.invalid/i/3",
        "labels": [{"name": "refactor"}],
        "milestone": None,
        "body": (
            "Depends on the fix in #1 landing first so the split (tracked here as #3) "
            "does not move the bug. See #1 again for the logs."
        ),
    },
    {
        "number": 4,
        "title": "spike: measure parser throughput on device",
        "state": "OPEN",
        "url": "https://example.invalid/i/4",
        "labels": [{"name": "spike"}],
        "milestone": {"title": "observe"},
        "body": "Needs the hardware. Collect a week of data before deciding.",
    },
    {
        "number": 5,
        "title": "fix: typo in usage text",
        "state": "CLOSED",
        "url": "https://example.invalid/i/5",
        "labels": [{"name": "bug"}],
        "milestone": None,
        "body": "Fixed already.",
    },
    {
        "number": 6,
        "title": "docs: describe the parser",
        "state": "OPEN",
        "url": "https://example.invalid/i/6",
        "labels": [{"name": "docs"}],
        "milestone": None,
        "body": (
            "See https://example.invalid/wiki/#7 for the old page; that anchor is not an issue."
        ),
    },
    {
        "number": 7,
        "title": "fix: parser drops trailing field",
        "state": "OPEN",
        "url": "https://example.invalid/pull/7",
        "labels": [],
        "milestone": None,
        "body": "Closes #1",
    },
]


# Pull requests covering every checks outcome:
#   10 draft, checks pass (SUCCESS and SKIPPED)
#   11 draft, checks fail (one FAILURE beside one SUCCESS), CONFLICTING, CHANGES_REQUESTED
#   12 draft, checks pending (a CheckRun still IN_PROGRESS, a StatusContext PENDING), on 10
#   13 ready, no checks, review APPROVED, mergeable null
#   14 merged, StatusContext SUCCESS only
#   15 draft, checks fail (CANCELLED beside SUCCESS)
#   16 draft, checks pass (NEUTRAL beside SUCCESS)
#   17 draft, checks pending (COMPLETED CheckRun with no conclusion)
#   18 draft, checks fail (STALE)
def _check_run(name, status, conclusion):
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


def _status_context(context, state):
    return {"__typename": "StatusContext", "context": context, "state": state}


PRS = [
    {
        "number": 10,
        "url": "https://example.invalid/p/10",
        "title": "fix: parser drops trailing field",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-1-parser-fix",
        "headRefOid": "aaa111",
        "mergeable": "MERGEABLE",
        "reviewDecision": None,
        "statusCheckRollup": [
            _check_run("test", "COMPLETED", "SUCCESS"),
            _check_run("lint", "COMPLETED", "SKIPPED"),
        ],
    },
    {
        "number": 11,
        "url": "https://example.invalid/p/11",
        "title": "chore: pin the linter",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-2-pin-linter",
        "headRefOid": "bbb222",
        "mergeable": "CONFLICTING",
        "reviewDecision": "CHANGES_REQUESTED",
        "statusCheckRollup": [
            _check_run("test", "COMPLETED", "SUCCESS"),
            _check_run("lint", "COMPLETED", "FAILURE"),
        ],
    },
    {
        "number": 12,
        "url": "https://example.invalid/p/12",
        "title": "refactor: split parser",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "wktr-1-parser-fix",
        "headRefName": "wktr-3-split-parser",
        "headRefOid": "ccc333",
        "mergeable": "UNKNOWN",
        "reviewDecision": None,
        "statusCheckRollup": [
            _check_run("test", "IN_PROGRESS", None),
            _status_context("coverage", "PENDING"),
        ],
    },
    {
        "number": 13,
        "url": "https://example.invalid/p/13",
        "title": "docs: describe the parser",
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": "main",
        "headRefName": "wktr-6-parser-docs",
        "headRefOid": "ddd444",
        "mergeable": None,
        "reviewDecision": "APPROVED",
        "statusCheckRollup": [],
    },
    {
        "number": 14,
        "url": "https://example.invalid/p/14",
        "title": "fix: typo in usage text",
        "state": "MERGED",
        "isDraft": False,
        "baseRefName": "main",
        "headRefName": "wktr-5-typo",
        "headRefOid": "eee555",
        "mergeable": "UNKNOWN",
        "reviewDecision": "APPROVED",
        "statusCheckRollup": [_status_context("ci", "SUCCESS")],
    },
    {
        "number": 15,
        "url": "https://example.invalid/p/15",
        "title": "cancelled run",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-15-cancelled",
        "headRefOid": "fff666",
        "mergeable": "MERGEABLE",
        "reviewDecision": None,
        "statusCheckRollup": [
            _check_run("test", "COMPLETED", "SUCCESS"),
            _check_run("lint", "COMPLETED", "CANCELLED"),
        ],
    },
    {
        "number": 16,
        "url": "https://example.invalid/p/16",
        "title": "neutral run",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-16-neutral",
        "headRefOid": "aaa777",
        "mergeable": "MERGEABLE",
        "reviewDecision": None,
        "statusCheckRollup": [
            _check_run("test", "COMPLETED", "SUCCESS"),
            _check_run("advisory", "COMPLETED", "NEUTRAL"),
        ],
    },
    {
        "number": 17,
        "url": "https://example.invalid/p/17",
        "title": "completed without conclusion",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-17-noconclusion",
        "headRefOid": "bbb888",
        "mergeable": "MERGEABLE",
        "reviewDecision": None,
        "statusCheckRollup": [_check_run("test", "COMPLETED", None)],
    },
    {
        "number": 18,
        "url": "https://example.invalid/p/18",
        "title": "stale run",
        "state": "OPEN",
        "isDraft": True,
        "baseRefName": "main",
        "headRefName": "wktr-18-stale",
        "headRefOid": "ccc999",
        "mergeable": "MERGEABLE",
        "reviewDecision": None,
        "statusCheckRollup": [_check_run("test", "COMPLETED", "STALE")],
    },
]

EXTENSIONS_WITH_STACK = "gh stack\tgithub/gh-stack\tv0.1.0\ngh dash\tdlvhdr/gh-dash\tv4.0.0\n"
EXTENSIONS_WITHOUT_STACK = (
    "gh dash\tdlvhdr/gh-dash\tv4.0.0\ngh stacker\tgithub/gh-stack-anything\tv1.0.0\n"
)

INSTALLED_PLUGINS_WITH_REVIEW = {
    "version": 2,
    "plugins": {
        "pr-review-toolkit@claude-plugins-official": [{"scope": "user", "version": "abc123"}],
        "gh@bje": [{"scope": "user", "version": "def456"}],
    },
}
INSTALLED_PLUGINS_WITHOUT_REVIEW = {
    "version": 2,
    "plugins": {"gh@bje": [{"scope": "user", "version": "def456"}]},
}


def write_json(path, document) -> None:
    Path(path).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def ws_fixture_issues(path) -> None:
    write_json(path, ISSUES)


def ws_fixture_prs(path) -> None:
    write_json(path, PRS)


def ws_fixture_extensions(path, variant: str = "with-stack") -> None:
    """Tab-separated like the real `gh extension list`: name, repo, version."""
    text = EXTENSIONS_WITH_STACK if variant == "with-stack" else EXTENSIONS_WITHOUT_STACK
    Path(path).write_text(text, encoding="utf-8")


def ws_fixture_installed_plugins(path, variant: str = "with-review") -> None:
    """Mirrors the shape of ~/.claude/plugins/installed_plugins.json."""
    write_json(
        path,
        INSTALLED_PLUGINS_WITH_REVIEW
        if variant == "with-review"
        else INSTALLED_PLUGINS_WITHOUT_REVIEW,
    )


def ws_fixture_home(directory, variant: str = "with-skill") -> None:
    """A fake $HOME with (or without) the gh-stack skill where gh skill install puts it."""
    home = Path(directory)
    (home / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (home / ".claude" / "plugins").mkdir(parents=True, exist_ok=True)
    if variant == "with-skill":
        skill = home / ".claude" / "skills" / "gh-stack"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text("---\nname: gh-stack\n---\n", encoding="utf-8")


class WsSandbox:
    """One test's workstreams world: canned gh data, an empty state dir, a fake HOME."""

    def __init__(self, sandbox, monkeypatch, gh_dir: Path, state_dir: Path, home: Path) -> None:
        self.sandbox = sandbox
        self.monkeypatch = monkeypatch
        self.path = sandbox.path
        self.gh_dir = gh_dir
        self.state_dir = state_dir
        self.home = home
        self.installed_plugins = home / ".claude" / "plugins" / "installed_plugins.json"

    def state_file(self, repo: str = "bje-settings/example") -> Path:
        """Where ws-state.py keeps this repository's state."""
        return self.state_dir / (repo.replace("/", "__") + ".json")

    def read_state(self, repo: str = "bje-settings/example"):
        return json.loads(self.state_file(repo).read_text(encoding="utf-8"))

    def setenv(self, name: str, value: str) -> None:
        self.monkeypatch.setenv(name, value)

    def delenv(self, name: str) -> None:
        self.monkeypatch.delenv(name, raising=False)


@pytest.fixture
def ws_sandbox(sandbox, monkeypatch) -> WsSandbox:
    """The pytest counterpart of `setup_ws_sandbox`."""
    gh_dir = sandbox.path / "gh"
    state_dir = sandbox.path / "state"
    home = sandbox.path / "ws-home"
    gh_dir.mkdir()
    monkeypatch.setenv("WS_GH_FIXTURE_DIR", str(gh_dir))
    monkeypatch.setenv("WS_STATE_DIR", str(state_dir))
    monkeypatch.setenv("HOME", str(home))
    for name in ("WS_GH_FIXTURE_FAIL", "WS_GH_FIXTURE_NOAUTH", "WS_GH_FIXTURE_REPO", "WS_REPO"):
        monkeypatch.delenv(name, raising=False)
    ws_fixture_issues(gh_dir / "issues.json")
    ws_fixture_prs(gh_dir / "prs.json")
    ws_fixture_extensions(gh_dir / "extensions.txt")
    ws_fixture_home(home)
    ws_fixture_installed_plugins(home / ".claude" / "plugins" / "installed_plugins.json")
    monkeypatch.setenv(
        "WS_INSTALLED_PLUGINS", str(home / ".claude" / "plugins" / "installed_plugins.json")
    )
    sandbox.stub_path(STUB_BIN)
    return WsSandbox(sandbox, monkeypatch, gh_dir, state_dir, home)


@pytest.fixture
def run_gh(run_script):
    """Run the stub gh the way a script on PATH would, and report as run_script does."""

    def run(*args, env=None):
        return run_script(STUB_BIN / "gh", *args, env=env)

    return run


@pytest.fixture
def ws_state(run_script):
    """Run ws-state.py with the current environment."""

    def run(*args, env=None):
        return run_script(WS_STATE, *args, env=env)

    return run
