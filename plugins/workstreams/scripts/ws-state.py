#!/usr/bin/env python3
"""ws-state.py: read and write the workstreams state file for the current repo.

  ws-state.py path
  ws-state.py init [--force] [--repo <owner/name>]
  ws-state.py show
  ws-state.py finished
  ws-state.py archive [--force]
  ws-state.py reconcile
  ws-state.py meta <field> <value>
  ws-state.py add-stream <id> --issues <n,n,...> --kind independent|stack
                         --model <alias> --effort low|medium|high [--reason <text>]
                         [--stack <name> --order <n> [--base <branch>]]
  ws-state.py set <stream-id> <field> <value> [--json]
  ws-state.py bump <stream-id> <numeric-field>
  ws-state.py list-streams [--status <status>]
  ws-state.py defer <issue> <reason>

One state file per repository, at
  ${WS_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/<owner>__<name>.json
where owner/name comes from --repo (init only), then WS_REPO, then `gh repo view`.
Writes go to a temp file and are moved into place, so a crash mid-write leaves
the old state intact.

The file has a lifecycle, and these three commands are it. `finished` answers
whether every stream has reached `done` or `failed` (a `paused` stream has not:
it is waiting on the user). `archive` moves a finished plan to
  <state dir>/archive/<owner>__<name>.<created>.json
and prints where it went, so the next plan for the repository starts from
nothing while the last one is still readable. `init` archives a finished plan
itself and carries on, and refuses an unfinished one without --force; with
--force it archives that one too rather than discarding it. `reconcile` asks
GitHub about every pull request of a stream that is not finished, marking a
stream whose PR was merged `done` and one whose PR was closed `failed`, and
prints the transitions it applied as a JSON array. It is what notices a PR
merged outside the run loop.

A stacked stream is one layer of a stack: --stack names the stack (shared by its
layers), --order is the position from the bottom starting at 1, and --base is the
branch of the layer below. The run skill starts one worker per stack.

`set` accepts only the fields below. The numeric ones take a number or null;
prs takes a JSON array (pass --json); every other field is stored as a string
unless --json is given. meta values are stored as strings, except loop_delay,
which must be an integer from 60 to 3600 and is stored as a number.
  status branch worktree pr prs agent question attempts review_rounds model
  effort reason base order stack
Numeric fields: pr attempts order review_rounds
Stream statuses: planned running draft reviewing paused done failed
Models: haiku sonnet opus fable inherit

`bump` adds one to a numeric field and prints what it now holds, so a caller
counting rounds or attempts never reads a value, adds one, and writes it back:
a session that stopped between the read and the write would leave the count
behind by one. A field that is null or absent counts as 0.

Exit 0 on success, 1 on any other failure (missing or corrupt state file, unknown
stream, gh failure, unwritable directory), 2 on usage, 3 when a plan is
unfinished -- init or archive asked to act on one without --force, or `finished`
answering that it is not -- and 4 when `reconcile` could not read GitHub.

`finished` exits 0 when the plan is finished and 3 when it is not; it prints
nothing on stdout. A missing, corrupt or unreadable state file is 1, as it is
for every other command, so a caller can tell "there is work left" from "this
file needs a person": any status other than 0 or 3 is a failure to report and
stop on. `reconcile` exits 4, having
written nothing, whenever gh failed, answered with something it could not read,
or named a pull request that does not exist: 4 rather than 1 so the run loop can
tell a tick worth repeating from a plan it must stop on.
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
# It lives here rather than in the docstring above, which is what `--help`
# prints and is addressed to whoever is running the script, not editing it.

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli  # noqa: E402  (needs HERE on sys.path first)
from lib import state as st  # noqa: E402

PROG = "ws-state.py"

# Every failure the script reports as its own: the message and the status.
# Not usage alone. Status 2 is a usage error, 3 is `init` declining to
# overwrite, and 1 is everything else the script refuses or cannot do (an
# unreadable state file, a repository it cannot name, a directory it cannot
# write).
Failure = cli.Failure

# The pretty JSON `jq .` printed; see lib/cli.py for why it is spelled that way.
dumps = cli.dumps


def die(message: str, status: int = 1):
    raise Failure(message, status)


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

    The two streams are captured apart, so only stdout is ever parsed: gh writes
    progress and warnings to stderr, and folding those in would turn a perfectly
    good answer into an unparseable one. On failure stderr is quoted back in the
    message instead, so the real cause (no remote, an expired token, offline)
    reaches the user rather than a generic hint.
    """
    try:
        finished = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner"],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        unresolvable(f"gh: {error}")
    output = finished.stdout.decode("utf-8", "replace").strip()
    errors = finished.stderr.decode("utf-8", "replace").strip()
    if finished.returncode != 0:
        detail = " ".join(part for part in (errors, output) if part)
        unresolvable(detail or f"gh exited {finished.returncode}")
    if errors:
        # gh exited 0 but still had something to say (a warning, an update
        # notice): a skill reading our stderr should see it too, the way the
        # shell version passed it through.
        sys.stderr.write(errors + "\n")
    try:
        name = json.loads(output)["nameWithOwner"]
    except (ValueError, KeyError, TypeError):
        unresolvable(output)
    # A null or non-string nameWithOwner is gh answering something other than
    # the question, not a repository; it fails the same way, not with a
    # TypeError from os.path.join further down.
    if not isinstance(name, str) or not name:
        unresolvable(output)
    return name


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
    return os.path.join(directory, st.file_stem(repo) + ".json")


def archive_state(path: str, document, directory: str) -> str:
    """Move a plan into the archive dir, and say where it went.

    A move rather than a copy and a delete: the plan is gone from where the
    skills look for it the moment the rename lands, and it is never both places
    at once. The archive lives under the state dir, so it follows WS_STATE_DIR or
    CLAUDE_PLUGIN_DATA wherever those point and needs nothing of any particular
    machine's layout.

    An occupied destination is refused, and both files are left as they are. The
    name is the repository and the plan's `created` second, which two plans can
    share -- an unparseable file archived twice inside one second, two documents
    both filed under `unknown`, an archive restored and archived again -- and
    os.replace would overwrite the earlier one without a word.
    """
    destination_dir = os.path.join(directory, "archive")
    try:
        os.makedirs(destination_dir, exist_ok=True)
    except OSError:
        die(f"cannot create {destination_dir}")
    destination = os.path.join(destination_dir, st.archive_name(document))
    if os.path.lexists(destination):
        die(f"cannot archive {path}: {destination} already exists")
    try:
        os.replace(path, destination)
    except OSError as error:
        die(f"cannot archive {path}: {error}")
    return destination


def write_state(path: str, document) -> None:
    """Atomic in-place update: write a temp file beside it, then move it over.

    A crash or a full disk mid-write leaves the old state intact, and an
    unwritable directory fails before anything is destroyed. Whichever step
    fails -- the write, the close, or the rename -- the temp file goes with it,
    so a run that changed nothing leaves nothing behind either.
    """
    tmp = f"{path}.tmp.{os.getpid()}"
    trouble = ""
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(dumps(document))
        os.replace(tmp, path)
    except (OSError, ValueError) as error:
        # ValueError alongside OSError: dumps() itself can raise one (a
        # circular reference, say), and it must land here too so the finally
        # block's "temp file left at" note is not lost to an exception this
        # function never caught.
        trouble = f"cannot write {path}: {error}"
    finally:
        if os.path.lexists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                trouble += f" (temp file left at {tmp})"
    if trouble:
        die(trouble)


def require_state(path: str):
    """The parsed state file, or the script's own message rather than a traceback."""
    if not os.path.isfile(path):
        die(f"no state file at {path}; run init first")
    try:
        with open(path, encoding="utf-8") as handle:
            # parse_constant refuses NaN and both infinities by name, the same
            # as --json does for `set`: a state file holding one is not valid
            # JSON, and has to report as one rather than surviving the parse
            # and failing later, unrecognisably, when it is written back out.
            document = json.load(handle, parse_constant=st.no_constants)
    except OSError as error:
        # A file that is there but unreadable is a different problem from one
        # holding the wrong bytes, and the fix is a different one too.
        die(f"cannot read {path}: {error}")
    except ValueError:
        die(f"state file is not valid workstreams JSON: {path}")
    if not st.is_state(document):
        die(f"state file is not valid workstreams JSON: {path}")
    return document


def read_state(path: str):
    """The parsed state file, or None when it is not one this can read.

    `require_state` is the same read with a message and an exit status attached;
    this one is for `init`, which has somewhere to go either way: a file it
    cannot parse is still a file it must not silently destroy.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle, parse_constant=st.no_constants)
    except (OSError, ValueError):
        return None
    return document if st.is_state(document) else None


def locate(repo_arg: str = ""):
    """The state dir and the current repository's file inside it."""
    directory = state_dir()
    return directory, state_path(directory, resolve_repo(repo_arg or os.environ.get("WS_REPO", "")))


def open_state(repo_arg: str = ""):
    """The path of the current repo's state file and its parsed contents."""
    _, path = locate(repo_arg)
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
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if os.path.isfile(path):
        existing = read_state(path)
        finished = existing is not None and st.is_finished(existing)
        if not finished and not force:
            die(f"state already exists at {path}; pass --force to start over", 3)
        # Either the last run is over, or the user said to replace one that is
        # not. Both keep the file: a finished plan is the record of what ran, and
        # a replaced one is what the user would want back if replacing it was the
        # mistake. A file this could not parse is archived too, under the
        # repository and this moment, since there is no plan in it to read them
        # off.
        moved = archive_state(
            path,
            existing if existing is not None else {"repo": repo, "created": created},
            directory,
        )
        sys.stderr.write(
            "{}: archived the {} plan to {}\n".format(
                PROG, "finished" if finished else "unfinished", moved
            )
        )
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        die(f"cannot create {directory}")
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


def cmd_finished(args):
    """Exit 0 when every stream is done or failed, 3 when any is not.

    Nothing on stdout: the answer is the exit status, so a skill asks with `if`
    rather than by matching text. 3 is the status `init` and `archive` already
    use for "this plan is unfinished", and it is not 1 because 1 is what a
    missing, corrupt or unreadable file exits with: a caller that read every
    non-zero status as "not finished" would take a file it cannot parse for a
    plan still running.
    """
    if args:
        die(f"finished: unknown argument: {args[0]}", 2)
    path, document = open_state()
    if not st.is_finished(document):
        die(f"the plan at {path} is not finished", 3)


def cmd_archive(args):
    force = False
    index = 0
    while index < len(args):
        if args[index] == "--force":
            force = True
        else:
            die(f"archive: unknown argument: {args[index]}", 2)
        index += 1
    directory, path = locate()
    document = require_state(path)
    if not st.is_finished(document) and not force:
        die(f"the plan at {path} is not finished; pass --force to archive it anyway", 3)
    print(archive_state(path, document, directory))


def cmd_reconcile(args):
    """Ask GitHub about the pull requests the plan is still waiting on.

    One `gh pr view` per pull request, and the whole answer is assembled before
    anything is written: a plan half-reconciled against a GitHub that stopped
    answering part-way through is worse than one not reconciled at all, because
    the next tick cannot tell which half it is looking at.
    """
    if args:
        die(f"reconcile: unknown argument: {args[0]}", 2)
    path, document = open_state()
    repo = plan_repo(document, path)
    pr_states = {number: gh_pr_state(number, repo) for number in pending_prs(document)}
    document, transitions = st.reconcile(document, pr_states)
    if transitions:
        write_state(path, document)
    sys.stdout.write(dumps(transitions))


def plan_repo(document, path) -> str:
    """The repository the plan records, which is the one its PR numbers belong to.

    Not the current directory's: a pull request number means nothing without a
    repository, and `reconcile` run from another checkout would otherwise ask
    about that repository's #14 and mark a stream done on the answer. The plan
    records the repository `init` resolved, so that is what is asked.
    """
    repo = document.get("repo")
    if not isinstance(repo, str) or "/" not in repo:
        die(f"the plan at {path} does not record a repository to reconcile against")
    return repo


def pending_prs(document) -> list:
    """The pull request numbers of the streams that are not finished, in order.

    Deduplicated because a stack's layers each carry their own record but a
    caller may have written one PR to two of them; asking GitHub twice for the
    same number is a round trip that buys nothing.
    """
    numbers = []
    for stream in document["streams"]:
        number = stream.get("pr")
        if stream.get("status") in st.TERMINAL:
            continue
        # bool before int: True is an int in Python and is not a pull request.
        if isinstance(number, int) and not isinstance(number, bool) and number not in numbers:
            numbers.append(number)
    return numbers


def gh_pr_state(number: int, repo: str) -> str:
    """OPEN, MERGED or CLOSED for one pull request, or exit 4.

    Asked of `repo`, the repository the plan records, so the answer is about the
    pull request the plan means wherever this happens to be run from.

    Every way of not getting an answer is a 4, including a pull request that does
    not exist: the run loop already fails a stream on a missing PR at its review
    step, where it has the stream in hand, and guessing here that a number
    nothing resolves means the work was abandoned would fail a stream over a
    typo. Reconciling is a read; a read that could not be made changes nothing.
    """
    try:
        finished = subprocess.run(
            ["gh", "pr", "view", str(number), "--repo", repo, "--json", "state"],
            capture_output=True,
            check=False,
        )
    except OSError as error:
        die(f"reconcile: gh pr view failed for #{number}: {error}", 4)
    errors = finished.stderr.decode("utf-8", "replace")
    if errors:
        # gh's own message, unchanged: a rate limit, an expired token and a
        # number nobody can resolve all arrive here, and which one it was is
        # what the reader needs.
        sys.stderr.write(errors)
    if finished.returncode != 0:
        die(f"reconcile: gh pr view failed for #{number}", 4)
    try:
        answer = json.loads(finished.stdout.decode("utf-8", "replace"))["state"]
    except (ValueError, KeyError, TypeError):
        die(f"reconcile: gh pr view for #{number} did not answer with a state", 4)
    if answer not in st.PR_STATES:
        die(f"reconcile: gh pr view for #{number} answered with an unknown state: {answer}", 4)
    return answer


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


def cmd_bump(args):
    if len(args) != 2 or not args[0] or not args[1]:
        die("bump needs <stream-id> <numeric-field>", 2)
    stream_id, field = args
    st.check_field(field)
    st.check_numeric_field(field)
    path, document = open_state()
    value = st.bump_stream_field(document, stream_id, field)
    write_state(path, document)
    print(value)


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
    "finished": cmd_finished,
    "archive": cmd_archive,
    "reconcile": cmd_reconcile,
    "meta": cmd_meta,
    "add-stream": cmd_add_stream,
    "set": cmd_set,
    "bump": cmd_bump,
    "list-streams": cmd_list_streams,
    "defer": cmd_defer,
}


def body(argv) -> int:
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


def main(argv) -> int:
    return cli.run(PROG, lambda: body(argv), (cli.Failure, st.Invalid))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
