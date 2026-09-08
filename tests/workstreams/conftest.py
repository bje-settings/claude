"""Canned GitHub data for the workstreams tests.

What `fixtures/workstreams/fixtures.sh` and `setup_ws_sandbox` in
`spec/spec_helper.sh` were before the plugin's scripts became Python and both
were deleted (#55). Most writers produce one fixture
file that `tests/workstreams/bin/gh` serves; the installed-plugins and home
writers do not go through the stub at all, but feed `ws-preflight` through
`WS_INSTALLED_PLUGINS` and `HOME`. `ws_sandbox` wires them together for one
test: a temp dir with the canned data, an empty state dir, a fake HOME, and the
stub ahead of any real gh on PATH. Tests remove or replace individual pieces to
build the negative cases.

The shapes are reconstructed from the field test in issue #7 (a debugging
session that produced two bugs, a chore, a refactor, and a spike) without
copying anything from that repository. `test_ws_fixtures.py` asserts the claims
made here, so the other tests cannot pass for the wrong reason.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
WS_SCRIPTS = ROOT / "plugins" / "workstreams" / "scripts"
WS_LIB = WS_SCRIPTS / "lib"
WS_STATE = WS_SCRIPTS / "ws-state.py"
WS_ISSUES = WS_SCRIPTS / "ws-issues.py"
WS_PR_STATUS = WS_SCRIPTS / "ws-pr-status.py"
WS_PR_COMMENTS = WS_SCRIPTS / "ws-pr-comments.py"
WS_PREFLIGHT = WS_SCRIPTS / "ws-preflight.py"
STUB_BIN = Path(__file__).resolve().parent / "bin"


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
#   19 closed without merging, so `reconcile` has all three PR states to read
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
    {
        "number": 19,
        "url": "https://example.invalid/p/19",
        "title": "chore: pin the linter",
        "state": "CLOSED",
        "isDraft": False,
        "baseRefName": "main",
        "headRefName": "wktr-2-pin-linter-again",
        "headRefOid": "ddd111",
        "mergeable": "UNKNOWN",
        "reviewDecision": None,
        "statusCheckRollup": [],
    },
]


# One pull request's reviews, issue comments, and review threads, as gh answers
# the query in lib/pr_comments.py. Every arm the fold decides between is here:
#   a bot review typed Bot, and a human review beside it
#   a review whose body is empty (the record GitHub keeps for a batch of inline
#     comments), which the fold drops
#   an issue comment from a machine user, a bot only by its [bot] login suffix
#   an issue comment whose author deleted their account (author: null)
#   an unresolved thread with two comments, the second of them outdated (line
#     null), and a resolved thread beside it
def _author(login, typename="User"):
    return {"login": login, "__typename": typename}


def _page_info(has_next=False, cursor=None):
    return {"hasNextPage": has_next, "endCursor": cursor}


COMMENTS_PAGE = {
    "data": {
        "repository": {
            "pullRequest": {
                "reviews": {
                    "pageInfo": _page_info(cursor="r1"),
                    "nodes": [
                        {
                            "databaseId": 5001,
                            "body": "Two blocking issues, both in the parser.",
                            "state": "CHANGES_REQUESTED",
                            "author": _author("coderabbitai", "Bot"),
                        },
                        {
                            "databaseId": 5002,
                            "body": "Reads well otherwise.",
                            "state": "COMMENTED",
                            "author": _author("aoife"),
                        },
                        {
                            "databaseId": 5003,
                            "body": "",
                            "state": "COMMENTED",
                            "author": _author("aoife"),
                        },
                    ],
                },
                "comments": {
                    "pageInfo": _page_info(cursor="c1"),
                    "nodes": [
                        {
                            "databaseId": 6001,
                            "body": "Coverage fell to 94.2% on this branch.",
                            "author": _author("codecov[bot]"),
                        },
                        {
                            "databaseId": 6002,
                            "body": "Filed as #31 so it does not get lost.",
                            "author": None,
                        },
                    ],
                },
                "reviewThreads": {
                    "pageInfo": _page_info(cursor="t1"),
                    "nodes": [
                        {
                            "isResolved": False,
                            "comments": {
                                "nodes": [
                                    {
                                        "databaseId": 7001,
                                        "body": "This drops the trailing field.",
                                        "path": "src/parser.py",
                                        "line": 42,
                                        "author": _author("coderabbitai", "Bot"),
                                    },
                                    {
                                        "databaseId": 7002,
                                        "body": "Agreed, and the test above misses it.",
                                        "path": "src/parser.py",
                                        "line": None,
                                        "author": _author("aoife"),
                                    },
                                ]
                            },
                        },
                        {
                            "isResolved": True,
                            "comments": {
                                "nodes": [
                                    {
                                        "databaseId": 7003,
                                        "body": "Nit: spelling.",
                                        "path": "README.md",
                                        "line": 8,
                                        "author": _author("aoife"),
                                    }
                                ]
                            },
                        },
                    ],
                },
            }
        }
    }
}


CONNECTION_NAMES = ("reviews", "comments", "reviewThreads")


def comments_page(reviews=(), comments=(), threads=(), has_next=False):
    """A page of the query's answer, for the tests that build their own.

    `has_next` is either a bool, which sets the flag on all three connections at
    once, or the names of the connections that carry it (`reviews`, `comments`,
    `reviewThreads`). GitHub pages the three independently, and a fixture that
    can only page them together cannot tell a script that keeps a finished
    connection's cursor from one that falls back to null.
    """
    if has_next is True:
        more = set(CONNECTION_NAMES)
    elif has_next is False:
        more = set()
    else:
        more = set(has_next)
        unknown = more - set(CONNECTION_NAMES)
        assert not unknown, f"no such connection: {sorted(unknown)}"
    return {
        "data": {
            "repository": {
                "pullRequest": {
                    "reviews": {
                        "pageInfo": _page_info("reviews" in more, "r-next"),
                        "nodes": list(reviews),
                    },
                    "comments": {
                        "pageInfo": _page_info("comments" in more, "c-next"),
                        "nodes": list(comments),
                    },
                    "reviewThreads": {
                        "pageInfo": _page_info("reviewThreads" in more, "t-next"),
                        "nodes": list(threads),
                    },
                }
            }
        }
    }


def ws_graphql_calls(gh_dir):
    """The variables of every `gh api graphql` call the stub answered, in order."""
    log = Path(gh_dir) / ".graphql-calls"
    if not log.is_file():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line]


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


def ws_fixture_comments(path, pages=None) -> None:
    """The pages `gh api graphql` serves, one per call, in order."""
    write_json(path, {"pages": list(pages) if pages else [COMMENTS_PAGE]})


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
    """One test's workstreams world, built the way `setup_ws_sandbox` built it
    for the shell specs before #55."""
    gh_dir = sandbox.path / "gh"
    state_dir = sandbox.path / "state"
    home = sandbox.path / "ws-home"
    gh_dir.mkdir()
    monkeypatch.setenv("WS_GH_FIXTURE_DIR", str(gh_dir))
    monkeypatch.setenv("WS_STATE_DIR", str(state_dir))
    monkeypatch.setenv("HOME", str(home))
    # WS_SKILLS_DIR is not read by ws-state.py, but ws-preflight.py is: inherited
    # from the developer's own environment it would point a test at a real
    # skills directory. WS_ISSUE_LIMIT is ws-issues.py's, for the same reason.
    for name in (
        "WS_GH_FIXTURE_FAIL",
        "WS_GH_FIXTURE_NOAUTH",
        "WS_GH_FIXTURE_REPO",
        "WS_ISSUE_LIMIT",
        "WS_REPO",
        "WS_SKILLS_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    ws_fixture_issues(gh_dir / "issues.json")
    ws_fixture_prs(gh_dir / "prs.json")
    ws_fixture_comments(gh_dir / "comments.json")
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


def _runner(run_script, script):
    def run(*args, env=None):
        return run_script(script, *args, env=env)

    return run


@pytest.fixture
def ws_state(run_script):
    """Run ws-state.py with the current environment."""
    return _runner(run_script, WS_STATE)


@pytest.fixture
def ws_issues(run_script):
    """Run ws-issues.py with the current environment."""
    return _runner(run_script, WS_ISSUES)


@pytest.fixture
def ws_pr_status(run_script):
    """Run ws-pr-status.py with the current environment."""
    return _runner(run_script, WS_PR_STATUS)


@pytest.fixture
def ws_pr_comments(run_script):
    """Run ws-pr-comments.py with the current environment."""
    return _runner(run_script, WS_PR_COMMENTS)


@pytest.fixture
def ws_preflight(run_script):
    """Run ws-preflight.py with the current environment."""
    return _runner(run_script, WS_PREFLIGHT)
