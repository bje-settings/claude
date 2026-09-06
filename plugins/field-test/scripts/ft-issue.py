#!/usr/bin/env python3
"""ft-issue.py: the pieces of filing a field-test finding as an issue.

  ft-issue.py names <target-repo-dir> [--run <run-dir>]
  ft-issue.py search <repo> <signature>
  ft-issue.py render <record.json> <run.json> <names.json> [--inside]
  ft-issue.py ensure-label <repo>

Nothing here creates an issue. Creating one is a side effect the user confirms,
so it stays in the skill where the user can see what is about to be published;
these are the deterministic parts around it.

names   collects every string that identifies the repository under test: its
        remote, owner, name, owner/name, checkout path, branches, recent commit
        subjects, and the #N references seen in the run. Redaction is literal, so
        a name that is not collected here is a name that survives into a public
        issue: err towards collecting too much.
search  looks for an open issue on the plugin's repo with the same signature, so
        a second run of the same bug comments instead of opening a duplicate.
render  fills the issue template from one finding and redacts it. The first line
        of the output is the title; the rest is the body.
ensure-label  creates the field-test label, or updates the colour and description
        of one already there. `bug` is expected to exist already.

Exit 0 on success, 1 on failure, 2 on usage.

Overridable for tests: FT_GH (the gh command, default `gh`).

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, gitinfo, redact  # noqa: E402  (needs HERE on sys.path first)
from lib import names as names_lib  # noqa: E402
from lib import render as render_lib  # noqa: E402

PROG = "ft-issue.py"
TEMPLATE = os.path.join(HERE, "..", "skills", "run", "issue-template.md")
SUBJECTS = 20
# Said whenever the events file cannot be read in full: the point is not the read
# but the `#N` references the unread part names, which redaction would then miss.
UNREADABLE = "could not read {}; the #N references it names would survive redaction"


class Failure(Exception):
    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def gh_command():
    return os.environ.get("FT_GH") or "gh"


def refs_text(events_path: str) -> str:
    """The fields of every recorded event that can carry a `#N`, joined.

    Checked, not read best-effort: a truncated last line would drop the entries
    after it, and the numbers they name would survive into a public issue
    unremarked.
    """
    try:
        with open(events_path, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().split("\n")
    except OSError:
        die(UNREADABLE.format(events_path))
    parts = []
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            die(UNREADABLE.format(events_path))
        if not isinstance(event, dict):
            continue
        for key in ("command", "last_assistant_message", "reason"):
            value = event.get(key)
            if isinstance(value, str):
                parts.append(value)
    return " ".join(parts)


def cmd_names(argv):
    directory = argv[0] if argv else ""
    if not directory or not os.path.isdir(directory):
        die("names needs an existing repository directory", 2)
    # Everything below is collected with git. Without a checkout the table comes
    # back nearly empty and redaction would still append its note saying the
    # names were replaced, which is how a real name reaches a public issue.
    if not gitinfo.git(directory, "rev-parse", "--git-dir"):
        die(
            f"names needs a git checkout, and {directory} is not one; nothing could be redacted",
            2,
        )
    run_dir = ""
    index = 1
    while index < len(argv):
        if argv[index] == "--run":
            value = argv[index + 1] if index + 1 < len(argv) else ""
            if not value:
                die("--run needs a value", 2)
            run_dir = value
            index += 2
            continue
        die(f"names: unknown argument: {argv[index]}", 2)

    top = gitinfo.git(directory, "rev-parse", "--show-toplevel") or directory
    # Both spellings of the checkout: git resolves symlinks in --show-toplevel and
    # the caller's own path may not be resolved, and a path that is only half
    # collected is a path that survives into a public issue.
    absolute = os.path.abspath(directory)
    paths = [top] + ([absolute] if absolute and absolute != top else [])

    remote = gitinfo.origin_url(directory)
    slug = gitinfo.owner_repo_of(remote)
    owner, _, name = slug.partition("/") if slug else ("", "", "")
    if not name:
        name = os.path.basename(top)

    refs = []
    if run_dir:
        # Once --run is given the events file is expected: ft-run.py start creates
        # it for every run, so its absence means the caller named the wrong
        # directory. Collecting no <pr> entries from it looks identical to a run
        # that mentioned none, and the numbers it would have named survive into a
        # public issue.
        events_path = os.path.join(run_dir, "events.jsonl")
        if not os.path.isfile(events_path):
            die(
                f"no events file at {events_path}; "
                "the #N references it names would survive redaction",
                2,
            )
        refs = names_lib.refs_in(refs_text(events_path))

    table = names_lib.names_table(
        {
            "remote": remote,
            "repo": slug,
            "owner": owner,
            "name": name,
            "branches": names_lib.lines(
                gitinfo.git(directory, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
            ),
            "paths": paths,
            "refs": refs,
            "subjects": names_lib.lines(
                gitinfo.git(directory, "log", "--format=%s", f"-{SUBJECTS}")
            ),
        }
    )
    cli.write_out(json.dumps(table, indent=2, ensure_ascii=False) + "\n")


def cmd_search(argv):
    repo = argv[0] if argv else ""
    signature = argv[1] if len(argv) > 1 else ""
    if not repo or not signature:
        die("search needs <repo> <signature>", 2)
    # The signature is in the issue body verbatim, so a substring search on it is
    # exact enough; anything gh cannot answer means "no match", and the caller
    # opens a new issue rather than silently attaching to the wrong one.
    try:
        finished = subprocess.run(
            [
                gh_command(),
                "issue",
                "list",
                "--repo",
                repo,
                "--state",
                "open",
                "--label",
                "field-test",
                "--search",
                signature,
                "--json",
                "number,body",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return
    if finished.returncode != 0:
        return
    try:
        issues = json.loads(finished.stdout.decode("utf-8", "replace"))
    except ValueError:
        return
    if not isinstance(issues, list):
        return
    for issue in issues:
        if isinstance(issue, dict) and signature in (issue.get("body") or ""):
            number = issue.get("number")
            # `// empty` in the shell's jq: a match with no number printed
            # nothing at all. The caller tests for empty output and opens a new
            # issue, and the string "None" would read to it as issue None.
            if number is not None:
                cli.write_out(str(number) + "\n")
            return


def cmd_render(argv):
    if len(argv) < 3 or not all(os.path.isfile(path) for path in argv[:3]):
        die("render needs <record.json> <run.json> <names.json>", 2)
    record_path, run_path, names_path = argv[:3]
    mode = argv[3] if len(argv) > 3 else ""
    if mode not in ("", "--inside"):
        die(f"render: unknown argument: {mode}", 2)
    if not os.path.isfile(TEMPLATE):
        die(f"no issue template at {TEMPLATE}")
    record = read_json(record_path, "record")
    run = read_json(run_path, "run marker")
    with open(TEMPLATE, encoding="utf-8", errors="replace") as handle:
        template = handle.read()
    # Rendered whole before anything is written. Streaming it into redaction
    # publishes whatever was written before a failure, with redaction's note
    # appended to it, so a failed render still looks like an issue.
    body = render_lib.render(template, record, run)
    # Exactly one trailing newline before redaction, whatever the template ends
    # with. The shell got this from `$(...)`, which strips every trailing newline,
    # and `printf '%s\n'`, which puts one back. It is not cosmetic: outside the
    # enterprise the note is appended after this newline, so an issue's last two
    # lines would otherwise depend on how the template file happens to end.
    body = body.rstrip("\n") + "\n"
    try:
        redact.check_present(names_path)
        cli.write_out(redact.redact(body, names_path, mode == "--inside"))
    except redact.RedactError as error:
        die(error.message, error.status)


def read_json(path: str, label: str):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        die(f"{label} is not valid JSON: {path}", 2)


def cmd_ensure_label(argv):
    repo = argv[0] if argv else ""
    if not repo:
        die("ensure-label needs <repo>", 2)
    try:
        finished = subprocess.run(
            [
                gh_command(),
                "label",
                "create",
                "field-test",
                "--repo",
                repo,
                "--force",
                "--color",
                "BFD4F2",
                "--description",
                "Found while running a skill under /field-test:run",
            ],
            check=False,
        )
    except OSError:
        die(f"could not create the field-test label on {repo}")
    if finished.returncode != 0:
        die(f"could not create the field-test label on {repo}")


COMMANDS = {
    "names": cmd_names,
    "search": cmd_search,
    "render": cmd_render,
    "ensure-label": cmd_ensure_label,
}


def run(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if command == "":
        sys.stderr.write(__doc__)
        return 2
    if command not in COMMANDS:
        die(f"unknown command: {command}", 2)
    COMMANDS[command](argv[2:])
    return 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather than
        # in the interpreter's own shutdown flush, which prints its own trace.
        sys.stdout.flush()
    except Failure as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        # Only the flush above and the usage text can reach this: every line this
        # script prints as an answer goes through cli.write_out, which stops the
        # output and lets the work finish. By here there is no work left, so
        # losing stderr with it costs nothing.
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The docstring promises this script's own message, not a traceback. An
        # arm nobody anticipated still reports one line and exit 1, the way every
        # anticipated one does. The class name is there so an exception with an
        # empty message still names what happened instead of printing a bare colon.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
