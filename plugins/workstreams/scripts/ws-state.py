#!/usr/bin/env python3
"""ws-state.py: read and write the workstreams state file for the current repo.

  ws-state.py path
  ws-state.py init [--force] [--repo <owner/name>]
  ws-state.py show
  ws-state.py meta <field> <value>
  ws-state.py add-stream <id> --issues <n,n,...> --kind independent|stack
                         --model <alias> --effort low|medium|high [--reason <text>]
                         [--stack <name> --order <n> [--base <branch>]]
  ws-state.py set <stream-id> <field> <value> [--json]
  ws-state.py list-streams [--status <status>]
  ws-state.py defer <issue> <reason>

One state file per repository, at
  ${WS_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/<owner>__<name>.json
where owner/name comes from --repo (init only), then WS_REPO, then `gh repo view`.
Writes go to a temp file and are moved into place, so a crash mid-write leaves
the old state intact. `init` refuses to overwrite an existing file without
--force.

A stacked stream is one layer of a stack: --stack names the stack (shared by its
layers), --order is the position from the bottom starting at 1, and --base is the
branch of the layer below. The run skill starts one worker per stack.

`set` accepts only the fields below. pr, attempts, and order take a number or
null; prs takes a JSON array (pass --json); every other field is stored as a
string unless --json is given. meta values are stored as strings, except
loop_delay, which must be an integer from 60 to 3600 and is stored as a number.
  status branch worktree pr prs agent question attempts model effort reason base order stack
Stream statuses: planned running draft reviewing paused done failed
Models: haiku sonnet opus fable inherit

Exit 0 on success, 1 on any other failure (missing or corrupt state file, unknown
stream, gh failure, unwritable directory), 2 on usage, 3 when init would
overwrite without --force.

Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import state as st  # noqa: E402  (needs HERE on sys.path first)

PROG = "ws-state.py"


class Usage(Exception):
    """Wrong arguments: the message, and the status to exit with."""

    def __init__(self, message: str, status: int = 2) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Usage(message, status)


def need(flag: str, value):
    """A flag given last with no value is an error, not an empty string."""
    if value is None or value == "" or value.startswith("-"):
        die(f"{flag} needs a value", 2)
    return value


# --- repository and paths -----------------------------------------------------


def resolve_repo(given: str) -> str:
    """owner/name, from the argument, else from gh."""
    repo = given or gh_repo()
    if "/" not in repo:
        die(f"repo must be owner/name, got: {repo}", 2)
    return repo


def gh_repo() -> str:
    """The current repository's nameWithOwner, as gh reports it.

    gh's stderr is folded into its stdout and quoted back in the failure
    message, so the real cause (no remote, an expired token, offline) reaches
    the user instead of a generic hint.
    """
    try:
        finished = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as error:
        unresolvable(f"gh: {error}")
    output = finished.stdout.decode("utf-8", "replace").rstrip("\n")
    if finished.returncode != 0:
        unresolvable(output)
    try:
        return json.loads(output)["nameWithOwner"]
    except (ValueError, KeyError, TypeError):
        unresolvable(output)


def unresolvable(detail: str):
    """The message every way of failing to name the repository ends in."""
    folded = " ".join(detail.split("\n"))
    die(f"cannot resolve the repository ({folded}); pass --repo owner/name or set WS_REPO")


def state_dir() -> str:
    directory = os.environ.get("WS_STATE_DIR") or os.environ.get("CLAUDE_PLUGIN_DATA") or ""
    if not directory:
        die("set CLAUDE_PLUGIN_DATA (or WS_STATE_DIR) to locate the state file", 2)
    return directory


def state_path(directory: str, repo: str) -> str:
    return os.path.join(directory, repo.replace("/", "__") + ".json")


def dumps(document) -> str:
    """The pretty JSON `jq .` printed: two-space indent, one trailing newline."""
    return json.dumps(document, indent=2) + "\n"


def write_state(path: str, document) -> None:
    """Atomic in-place update: write a temp file beside it, then move it over.

    A crash or a full disk mid-write leaves the old state intact, and an
    unwritable directory fails before anything is destroyed.
    """
    tmp = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(dumps(document))
    except OSError:
        die(f"cannot write {tmp}")
    try:
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        die(f"cannot write {path}")


def require_state(path: str):
    """The parsed state file, or the script's own message rather than a traceback."""
    if not os.path.isfile(path):
        die(f"no state file at {path}; run init first")
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        die(f"state file is not valid workstreams JSON: {path}")
    if not st.is_state(document):
        die(f"state file is not valid workstreams JSON: {path}")
    return document


def open_state(repo_arg: str = ""):
    """The path of the current repo's state file and its parsed contents."""
    path = state_path(state_dir(), resolve_repo(repo_arg or os.environ.get("WS_REPO", "")))
    return path, require_state(path)


# --- commands -----------------------------------------------------------------


def cmd_init(args):
    force = False
    repo_arg = ""
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--force":
            force = True
        elif argument == "--repo":
            repo_arg = need(argument, args[index + 1] if index + 1 < len(args) else None)
            index += 1
        else:
            die(f"init: unknown argument: {argument}", 2)
        index += 1

    directory = state_dir()
    repo = resolve_repo(repo_arg or os.environ.get("WS_REPO", ""))
    path = state_path(directory, repo)
    if os.path.isfile(path) and not force:
        die(f"state already exists at {path}; pass --force to start over", 3)
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        die(f"cannot create {directory}")
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_state(path, st.new_state(repo, created))
    print(path)


def cmd_path(args):
    if args:
        die(f"path: unknown argument: {args[0]}", 2)
    print(state_path(state_dir(), resolve_repo(os.environ.get("WS_REPO", ""))))


def cmd_show(args):
    if args:
        die(f"show: unknown argument: {args[0]}", 2)
    _, document = open_state()
    sys.stdout.write(dumps(document))


def cmd_meta(args):
    if len(args) != 2:
        die("meta needs <field> <value>", 2)
    field, raw = args
    value = st.meta_value(field, raw)
    path, document = open_state()
    write_state(path, st.set_meta(document, field, value))


def cmd_add_stream(args):
    stream_id = args[0] if args else ""
    if not stream_id or stream_id.startswith("-"):
        die("add-stream needs a stream id first", 2)
    values = {
        "issues": "",
        "kind": "",
        "model": "",
        "effort": "",
        "reason": "",
        "base": "",
        "order": "",
        "stack": "",
    }
    index = 1
    while index < len(args):
        flag = args[index]
        name = flag[2:] if flag.startswith("--") else ""
        if name not in values:
            die(f"add-stream: unknown argument: {flag}", 2)
        values[name] = need(flag, args[index + 1] if index + 1 < len(args) else None)
        index += 2

    if not (values["issues"] and values["kind"] and values["model"] and values["effort"]):
        die("add-stream needs --issues, --kind, --model, and --effort", 2)
    st.check_choice(values["kind"], values["effort"], values["model"])
    st.parse_issues(values["issues"])
    st.check_order(values["order"])
    st.check_layer(values["kind"], values["stack"], values["order"], values["base"])

    path, document = open_state()
    record = st.stream_record(
        stream_id,
        values["issues"],
        values["kind"],
        values["stack"],
        values["order"],
        values["base"],
        values["model"],
        values["effort"],
        values["reason"],
    )
    write_state(path, st.add_stream(document, record))


def cmd_set(args):
    if len(args) < 3 or not args[0] or not args[1]:
        die("set needs <stream-id> <field> <value> [--json]", 2)
    stream_id, field, raw = args[0], args[1], args[2]
    mode = args[3] if len(args) > 3 else ""
    if mode not in ("", "--json"):
        die(f"set: unknown argument: {mode}", 2)
    st.check_field(field)
    if field == "status":
        st.check_status(raw, "set")
    if field in st.NUMERIC_FIELDS:
        value = st.numeric_field_value(field, raw)
    elif field == "prs" or mode == "--json":
        value = st.json_value(raw)
    else:
        value = raw

    path, document = open_state()
    write_state(path, st.set_stream_field(document, stream_id, field, value))


def cmd_list_streams(args):
    status = ""
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--status":
            status = need(argument, args[index + 1] if index + 1 < len(args) else None)
            index += 1
        else:
            die(f"list-streams: unknown argument: {argument}", 2)
        index += 1
    if status:
        st.check_status(status, "list-streams")
    _, document = open_state()
    sys.stdout.write(dumps(st.filter_streams(document, status)))


def cmd_defer(args):
    if len(args) != 2 or not st.DIGITS.match(args[0]):
        die("defer needs <issue-number> <reason>", 2)
    path, document = open_state()
    write_state(path, st.defer(document, int(args[0]), args[1]))


COMMANDS = {
    "init": cmd_init,
    "path": cmd_path,
    "show": cmd_show,
    "meta": cmd_meta,
    "add-stream": cmd_add_stream,
    "set": cmd_set,
    "list-streams": cmd_list_streams,
    "defer": cmd_defer,
}


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if command == "":
        sys.stderr.write(__doc__)
        return 2
    try:
        if command not in COMMANDS:
            die(f"unknown command: {command}", 2)
        COMMANDS[command](argv[2:])
    except (Usage, st.Invalid) as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
