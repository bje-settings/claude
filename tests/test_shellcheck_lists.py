"""The shellcheck file list is written out three times, so a test keeps the copies equal.

`.github/workflows/ci.yml` lints the shell scripts in CI; `.pre-commit-config.yaml` lints the
same ones before a commit; `spec/run.sh` lints them again for a contributor who has not opted
into pre-commit, minus `spec/run.sh` itself since a script cannot lint itself. A file added to
one list and forgotten in the others is only discovered once it is already broken, so this
compares all three, checks that every shell script on disk is actually listed somewhere, and
checks the `plugin-validate` command is identical between the pre-commit hook and its workflow.
Issue #61 deletes the `shellcheck` hook together with the rest of the shell harness -- the
shellcheck CI job, `spec/`, and `fixtures/` -- and this test with it.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

CI_MARKER = "shellcheck -S warning \\"


def _continuation_list(text: str, start: int) -> list[str]:
    """Parse a `cmd \\\n    a \\\n    b \\\n    c` style continuation list."""
    body = text[start:]
    files = []
    for line in body.splitlines()[1:]:
        stripped = line.strip()
        if not stripped:
            break
        files.append(stripped.rstrip("\\").strip())
        if not stripped.endswith("\\"):
            break
    return files


def _ci_shellcheck_files() -> list[str]:
    """The arguments to the `shellcheck -S warning \\` command in the lint job."""
    text = (REPO / ".github/workflows/ci.yml").read_text()
    start = text.index(CI_MARKER)
    return _continuation_list(text, start)


def _spec_run_shellcheck_files() -> list[str]:
    """The arguments to `spec/run.sh`'s own `shellcheck -S warning \\` invocation."""
    text = (REPO / "spec/run.sh").read_text()
    start = text.index(CI_MARKER)
    return _continuation_list(text, start)


def _shellcheck_severity(text: str) -> str:
    match = re.search(r"shellcheck (-\S+ \S+)", text)
    assert match, "no shellcheck severity flag found"
    return match.group(1)


def _pre_commit_shellcheck_block() -> str:
    """The `- id: shellcheck` hook block, bounded by the next top-level hook."""
    text = (REPO / ".pre-commit-config.yaml").read_text()
    start = text.index("- id: shellcheck")
    rest = text[start:]
    next_hook = re.search(r"\n\s*- id:", rest[1:])
    end = next_hook.start() + 1 if next_hook else len(rest)
    return rest[:end]


def _pre_commit_shellcheck_files() -> list[str]:
    """The `args:` entries of the shellcheck hook."""
    block = _pre_commit_shellcheck_block()
    args = block.index("args:")
    files = []
    for line in block[args:].splitlines()[1:]:
        match = re.match(r"^\s+- (\S+)$", line)
        if not match:
            break
        files.append(match.group(1))
    return files


def _pre_commit_shellcheck_files_regex() -> str:
    block = _pre_commit_shellcheck_block()
    match = re.search(r"files:\s*(\S+)", block)
    assert match, "no files: pattern found on the shellcheck hook"
    return match.group(1)


def _repo_shell_scripts() -> set[str]:
    """Every `.sh` file and `bin/gh` stub under plugins/, fixtures/, and spec/.

    Excludes the shellspec spec files themselves (`*_spec.sh`) and the shared
    `spec/spec_helper.sh`, neither of which is a script shellcheck should lint.
    """
    found: set[str] = set()
    for base in ("plugins", "fixtures", "spec"):
        root = REPO / base
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            is_sh = path.suffix == ".sh"
            is_gh_stub = path.name == "gh" and path.parent.name == "bin"
            if not (is_sh or is_gh_stub):
                continue
            rel = path.relative_to(REPO).as_posix()
            if rel.startswith("spec/") and (
                rel.endswith("_spec.sh") or rel == "spec/spec_helper.sh"
            ):
                continue
            found.add(rel)
    return found


def _normalize_shell(text: str) -> str:
    """Collapse `;` and newlines to plain whitespace and squeeze runs of it.

    Lets a command written across several lines in a YAML block scalar compare
    equal to the same command written with `;` in a single-quoted `bash -c`
    string, regardless of exactly where the line breaks or semicolons fall.
    """
    return " ".join(text.replace(";", " ").replace("\n", " ").split())


def _pre_commit_plugin_validate_command() -> str:
    text = (REPO / ".pre-commit-config.yaml").read_text()
    start = text.index("id: plugin-validate")
    entry_line = re.search(r"entry: bash -c '(.*)'", text[start:])
    assert entry_line, "no plugin-validate entry found in .pre-commit-config.yaml"
    return entry_line.group(1)


def _workflow_plugin_validate_command() -> str:
    text = (REPO / ".github/workflows/plugin-validate.yml").read_text()
    start = text.index("Validate the marketplace manifest and every plugin")
    run_at = text.index("run: |", start)
    lines = text[run_at:].splitlines()[1:]
    indent = None
    body = []
    for line in lines:
        if not line.strip():
            continue
        this_indent = len(line) - len(line.lstrip(" "))
        if indent is None:
            indent = this_indent
        if this_indent < indent:
            break
        body.append(line)
    return "\n".join(body)


def test_the_ci_shellcheck_marker_appears_once() -> None:
    text = (REPO / ".github/workflows/ci.yml").read_text()
    assert text.count(CI_MARKER) == 1


def test_the_shellcheck_severity_flag_matches_everywhere() -> None:
    ci_text = (REPO / ".github/workflows/ci.yml").read_text()
    pre_commit_text = (REPO / ".pre-commit-config.yaml").read_text()
    spec_run_text = (REPO / "spec/run.sh").read_text()
    severities = {
        _shellcheck_severity(ci_text),
        _shellcheck_severity(pre_commit_text),
        _shellcheck_severity(spec_run_text),
    }
    assert len(severities) == 1, f"shellcheck severity flags disagree: {severities}"


def test_the_pre_commit_and_ci_shellcheck_lists_are_the_same() -> None:
    assert _pre_commit_shellcheck_files() == _ci_shellcheck_files()


def test_spec_run_lists_every_ci_file_except_itself() -> None:
    assert _spec_run_shellcheck_files() == [f for f in _ci_shellcheck_files() if f != "spec/run.sh"]


def test_every_listed_file_exists() -> None:
    listed = _ci_shellcheck_files()
    assert listed, "parsed an empty list out of ci.yml"
    missing = [f for f in listed if not (REPO / f).is_file()]
    assert missing == []


def test_every_shell_script_on_disk_is_listed() -> None:
    on_disk = _repo_shell_scripts()
    listed = set(_ci_shellcheck_files())
    assert on_disk == listed, (
        f"on disk but not listed: {on_disk - listed}; "
        f"listed but missing from disk: {listed - on_disk}"
    )


def test_every_listed_file_matches_the_hook_files_pattern() -> None:
    pattern = _pre_commit_shellcheck_files_regex()
    for f in _ci_shellcheck_files():
        assert re.search(pattern, f), f"{f!r} does not match files: {pattern!r}"


def test_the_plugin_validate_command_matches_the_workflow() -> None:
    hook_command = _normalize_shell(_pre_commit_plugin_validate_command())
    workflow_command = _normalize_shell(_workflow_plugin_validate_command())
    assert hook_command == workflow_command


def test_pre_commit_config_is_valid() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "pre_commit", "validate-config", ".pre-commit-config.yaml"],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_every_hook_key_is_one_pre_commit_knows() -> None:
    # validate-config accepts unknown hook keys (cfgv's Map has no
    # NoAdditionalKeys), so a typo such as `always_runs:` is ignored at run
    # time rather than rejected. Check the keys against pre-commit's own schema.
    from pre_commit.clientlib import CONFIG_HOOK_DICT

    allowed = {item.key for item in CONFIG_HOOK_DICT.items if hasattr(item, "key")}
    text = (REPO / ".pre-commit-config.yaml").read_text(encoding="utf-8")
    used = set(re.findall(r"^      (?:- |  )([a-z_]+):", text, flags=re.MULTILINE))
    assert used, "no hook keys parsed"
    assert used <= allowed, sorted(used - allowed)
