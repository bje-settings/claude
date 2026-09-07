#!/usr/bin/env python3
"""ft-harden-state.py: read and write the state of one hardening run.

  ft-harden-state.py path <plugin:skill>
  ft-harden-state.py init <plugin:skill> [--force] [--model <alias>] [--effort low|medium|high]
  ft-harden-state.py show <plugin:skill>
  ft-harden-state.py add-target <plugin:skill> <path> [--repo <owner/name>]
  ft-harden-state.py set <plugin:skill> <path> <field> <value> [--json]
  ft-harden-state.py next <plugin:skill>

One state file per skill being hardened, at
  ${FT_STATE_DIR:-$CLAUDE_PLUGIN_DATA}/harden/<plugin>__<skill>.json
Writes go to a temp file and are moved into place, so a crash mid-write leaves
the old state intact. `init` refuses to overwrite an existing run without
--force, because the targets already worked are the thing you would lose.

The loop writes every transition here before taking the next action, so a
session that stopped can re-run the skill and continue. `next` prints the path
of the first target still to do, and nothing when the list is exhausted.

`set` accepts only the fields below. pr and review_rounds take a number or null
and issues a JSON array (--json is implied for all three); everything else is
stored as a string. review_rounds is how many review rounds the target has had,
recorded so the harden skill can bound the review phase at one repeat across a
resumed session; nothing here reads it back.
  status phase issues pr review_rounds merge_sha question summary repo
Target statuses: pending running paused done failed
Phases: field-test verify fix review merge summary done

Exit 0 on success, 1 on any other failure, 2 on usage, 3 when init would
overwrite without --force.
"""

# Stdlib only, Python 3.9: an end user runs this with the python3 macOS ships.
# It lives here rather than in the docstring above, which is what `--help`
# prints and is addressed to whoever is running the script, not editing it.

from __future__ import annotations

import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from lib import cli, harden  # noqa: E402  (needs HERE on sys.path first)

PROG = "ft-harden-state.py"


class Failure(Exception):
    """Anything this script refuses to do: the message, and the status to exit with."""

    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1):
    raise Failure(message, status)


def need(flag: str, value):
    """A flag given last with no value is an error, not an empty string."""
    if not value or value.startswith("-"):
        die(f"{flag} needs a value", 2)
    return value


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dumps(document) -> str:
    """The pretty JSON `jq .` printed: two-space indent, one trailing newline.

    `ensure_ascii=False` because that is the parity: jq writes raw UTF-8, so a
    question or a summary with an accent stays readable in the file instead of
    becoming a run of escapes.
    """
    return json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def write_state(path: str, document) -> None:
    """Atomic in-place update: write a temp file beside it, then move it over.

    A crash or a full disk mid-write leaves the old state intact, and an
    unwritable directory fails before anything is destroyed. Whichever step
    fails, the temp file goes with it, so a run that changed nothing leaves
    nothing behind either -- which is what the shell's `rm -f "$tmp"` on every
    failing arm was for.
    """
    tmp = f"{path}.tmp.{os.getpid()}"
    trouble = ""
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(dumps(document))
        os.replace(tmp, path)
    except (OSError, ValueError) as error:
        # ValueError alongside OSError: dumps() can raise one of its own, and it
        # must land here too, so the temp file is not left behind by an
        # exception this function never caught.
        trouble = f"cannot write {path}: {error}"
    finally:
        if os.path.lexists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                trouble += f" (temp file left at {tmp})"
    if trouble:
        die(trouble)


def require_state(path: str, skill: str):
    """The parsed run, or this script's own message rather than a traceback."""
    if not os.path.isfile(path):
        die(f"no hardening run for {skill}; run init first")
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as error:
        # Separate from the JSON arm: a file this cannot open is a permission or
        # a device to fix, and "not valid field-test JSON" sends the reader to
        # the contents of a file they were never able to read.
        die(f"cannot read {path}: {error}")
    except ValueError:
        die(f"state file is not valid field-test JSON: {path}")
    if not harden.is_state(document):
        die(f"state file is not valid field-test JSON: {path}")
    return document


# --- commands ----------------------------------------------------------------


def cmd_path(args, path: str, skill: str) -> None:
    # `path` and `show` refuse a stray argument where the shell ignored it. A
    # third word after `path gh:shepherd` is a typo, and silently printing the
    # right answer to the wrong question is how it survives to the next caller.
    if args:
        die(f"path: unknown argument: {args[0]}", 2)
    cli.write_out(path + "\n")


def cmd_init(args, path: str, skill: str, directory: str) -> None:
    force = False
    model = "opus"
    effort = "high"
    index = 0
    while index < len(args):
        argument = args[index]
        if argument == "--force":
            force = True
            index += 1
            continue
        value = args[index + 1] if index + 1 < len(args) else ""
        if argument == "--model":
            model = need(argument, value)
        elif argument == "--effort":
            effort = need(argument, value)
        else:
            die(f"init: unknown argument: {argument}", 2)
        index += 2
    harden.check_model(model)
    harden.check_effort(effort)
    if os.path.isfile(path) and not force:
        die(f"a hardening run for {skill} already exists at {path}; pass --force to start over", 3)
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError:
        die(f"cannot create {directory}")
    write_state(path, harden.new_state(skill, now(), model, effort))
    # write_out, not sys.stdout.write: the state file is already on disk, and a
    # reader that went away must not be why this command reports a failure.
    cli.write_out(path + "\n")


def cmd_show(args, path: str, skill: str) -> None:
    if args:
        die(f"show: unknown argument: {args[0]}", 2)
    cli.write_out(dumps(require_state(path, skill)))


def cmd_add_target(args, path: str, skill: str) -> None:
    target = args[0] if args else ""
    if not target or target.startswith("-"):
        die("add-target needs a repository path", 2)
    repo = ""
    index = 1
    while index < len(args):
        argument = args[index]
        if argument != "--repo":
            die(f"add-target: unknown argument: {argument}", 2)
        repo = need(argument, args[index + 1] if index + 1 < len(args) else "")
        index += 2
    document = require_state(path, skill)
    write_state(path, harden.add_target(document, target, repo))


def cmd_set(args, path: str, skill: str) -> None:
    if len(args) < 3 or not args[0] or not args[1]:
        die("set needs <path> <field> <value> [--json]", 2)
    target, field, raw = args[0], args[1], args[2]
    mode = args[3] if len(args) > 3 else ""
    if mode not in ("", "--json"):
        die(f"set: unknown argument: {mode}", 2)
    value = harden.field_value(field, raw, mode)
    document = require_state(path, skill)
    write_state(path, harden.set_field(document, target, field, value))


def cmd_next(args, path: str, skill: str) -> None:
    if args:
        die(f"next: unknown argument: {args[0]}", 2)
    target = harden.next_target(require_state(path, skill))
    # Nothing at all when the list is exhausted, not an empty line: the skill
    # tests the output for emptiness to decide the run is finished.
    if target:
        cli.write_out(target + "\n")


def run(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command in ("-h", "--help"):
        sys.stdout.write(__doc__)
        return 0
    if command == "":
        sys.stderr.write(__doc__)
        return 2

    directory = os.environ.get("FT_STATE_DIR") or os.environ.get("CLAUDE_PLUGIN_DATA") or ""
    if not directory:
        die("set CLAUDE_PLUGIN_DATA (or FT_STATE_DIR) to locate the state file", 2)

    # The skill is checked before the command word, the order the shell used: a
    # mistyped command with no target reports the missing target first.
    skill = harden.check_skill(command, argv[2] if len(argv) > 2 else "")
    if command not in ("path", "init", "show", "add-target", "set", "next"):
        die(f"unknown command: {command}", 2)
    harden_dir = os.path.join(directory, "harden")
    path = os.path.join(harden_dir, harden.file_name(skill))
    args = argv[3:]

    if command == "path":
        cmd_path(args, path, skill)
    elif command == "init":
        cmd_init(args, path, skill, harden_dir)
    elif command == "show":
        cmd_show(args, path, skill)
    elif command == "add-target":
        cmd_add_target(args, path, skill)
    elif command == "set":
        cmd_set(args, path, skill)
    else:
        cmd_next(args, path, skill)
    return 0


def main(argv):
    cli.reconfigure_streams()
    try:
        status = run(argv)
        # Forced now, while a closed pipe still lands in the arm below rather
        # than in the interpreter's own shutdown flush, which prints its trace.
        sys.stdout.flush()
    except (Failure, harden.Invalid) as error:
        sys.stderr.write(f"{PROG}: {error.message}\n")
        return error.status
    except BrokenPipeError:
        # Only the flush above and the usage text can reach this: every answer
        # goes through cli.write_out, which stops the output and lets the write
        # finish. By here there is no work left, so losing stderr costs nothing.
        cli.silence_broken_pipe()
        return 0
    except Exception as error:
        # The docstring promises this script's own message, not a traceback. An
        # arm nobody anticipated still reports one line and exit 1, the way
        # every anticipated one does.
        sys.stderr.write(f"{PROG}: internal error: {type(error).__name__}: {error}\n")
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
