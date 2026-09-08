"""State-file transformations for ws-state.py.

Two kinds of thing live here. The jq programs the shell ws-state ran -- the add-stream
filter, both `set` filters, the list-streams selection, defer, meta, and the
shape check that decides whether a file is workstreams state at all -- and the
argument validation the shell did with regexes and substring tests against
space-padded vocabularies. Both are plain functions so each arm can be tested
directly. Under kcov a jq program counted as one line however many decisions it
held, which is the blind spot `.claude/rules/type-py.md` describes; here every
branch is its own arm of the coverage report and its own unit test in
`tests/workstreams/test_state.py`.

Beside them is the lifecycle the file itself has: whether a plan is finished,
what a finished plan is archived as, and how a plan is brought back into line
with what GitHub says about its pull requests. See
`plugins/workstreams/docs/spike-65-state-file.md` for why the file is kept at
all and what it would take to derive its contents instead.

Nothing here touches the filesystem or the environment: the functions take a
state document (the parsed JSON) and return a new value or raise `Invalid`. The
script owns reading, writing, and exit codes.
"""

from __future__ import annotations

import json
import re

# The vocabularies the script validates against.
STATUSES = ("planned", "running", "draft", "reviewing", "paused", "done", "failed")
# The statuses no later tick moves a stream off. `paused` is not one of them: the
# user owes an answer, and a plan holding a paused stream is still a plan being
# run. Everything else is work the loop expects to pick up again.
TERMINAL = ("done", "failed")
# The three states `gh pr view --json state` answers with, and what each of them
# settles. OPEN settles nothing -- it is the ordinary case the run loop is
# already working through -- so it is absent here rather than mapped to a status.
PR_STATES = ("OPEN", "MERGED", "CLOSED")
RECONCILED = {"MERGED": "done", "CLOSED": "failed"}
KINDS = ("independent", "stack")
FIELDS = (
    "status",
    "branch",
    "worktree",
    "pr",
    "prs",
    "agent",
    "question",
    "attempts",
    "review_rounds",
    "model",
    "effort",
    "reason",
    "base",
    "order",
    "stack",
)
NUMERIC_FIELDS = ("pr", "attempts", "order", "review_rounds")
EFFORTS = ("low", "medium", "high")
MODELS = ("haiku", "sonnet", "opus", "fable", "inherit")
# meta fields stored as JSON numbers rather than strings, with their accepted range
META_NUMERIC = ("loop_delay",)
LOOP_DELAY_MIN = 60
LOOP_DELAY_MAX = 3600

VERSION = 1

DIGITS = re.compile(r"^[0-9]+$")
ISSUE_LIST = re.compile(r"^[0-9]+(,[0-9]+)*$")
ORDER = re.compile(r"^[1-9][0-9]*$")


class Invalid(Exception):
    """A value the script must refuse, with the message and exit code to use.

    Usage errors exit 2 the way the shell script's `die "..." 2` did; the two
    cases that are not usage errors (a duplicate stream id, an unknown stream)
    carry status 1.
    """

    def __init__(self, message: str, status: int = 2) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# --- shape -------------------------------------------------------------------


def is_state(document) -> bool:
    """Whether a parsed JSON document is a workstreams state file.

    The shell asked only whether the top level was an object holding a `streams`
    array, which let a file through that every later step then had to guard
    against or crash on. This checks the whole shape the rest of the module
    assumes: `streams` is a list of objects, and `deferred` and `meta`, where the
    file has them at all, are a list of objects and an object. Anything else is
    another tool's JSON that happens to sit at the same path, and is refused
    before a single field is written.
    """
    if not isinstance(document, dict):
        return False
    streams = document.get("streams")
    if not isinstance(streams, list) or not all(isinstance(entry, dict) for entry in streams):
        return False
    if "deferred" in document:
        deferred = document["deferred"]
        if not isinstance(deferred, list) or not all(isinstance(entry, dict) for entry in deferred):
            return False
    if "meta" in document and not isinstance(document["meta"], dict):
        return False
    return True


def new_state(repo: str, created: str) -> dict:
    """The document `init` writes."""
    return {
        "version": VERSION,
        "repo": repo,
        "created": created,
        "meta": {},
        "streams": [],
        "deferred": [],
    }


# --- streams -----------------------------------------------------------------


def stream_record(
    stream_id: str,
    issues: str,
    kind: str,
    stack: str,
    order: str,
    base: str,
    model: str,
    effort: str,
    reason: str,
) -> dict:
    """One stream record, with the defaults filled in.

    The arguments arrive as the strings the command line carried: an empty
    `stack`, `order` or `base` becomes null rather than an empty string, and
    `issues` is split into numbers.
    """
    return {
        "id": stream_id,
        "issues": parse_issues(issues),
        "kind": kind,
        "stack": stack if stack != "" else None,
        "order": int(order) if order != "" else None,
        "base": base if base != "" else None,
        "model": model,
        "effort": effort,
        "reason": reason,
        "status": "planned",
        "branch": None,
        "worktree": None,
        "pr": None,
        "prs": None,
        "agent": None,
        "question": None,
        "attempts": 0,
        # How many review passes this stream's PR has had. On disk rather than
        # in the loop's head because the loop is resumable: a session that stops
        # between two ticks must still know that the round it is about to run is
        # the repeat, not the first.
        "review_rounds": 0,
    }


def find_stream(state: dict, stream_id: str):
    """The stream with that id, or None.

    The first match is the only one: `add_stream` refuses an id the plan already
    holds, so no state file this module wrote can carry two. Every entry is a
    dict because `is_state` refused the document otherwise.
    """
    for stream in state["streams"]:
        if stream.get("id") == stream_id:
            return stream
    return None


def add_stream(state: dict, record: dict) -> dict:
    """Append a stream, with the duplicate check that guarded it."""
    if find_stream(state, record["id"]) is not None:
        raise Invalid("add-stream: stream already exists: {}".format(record["id"]), 1)
    state["streams"].append(record)
    return state


def set_stream_field(state: dict, stream_id: str, field: str, value) -> dict:
    """Write one field of one stream, refusing an id no stream carries.

    The assignment on its own would match nothing and write the file back
    unchanged, so the refusal is what makes a mistyped id visible rather than a
    silent no-op. The named field is written as given; `check_field` is what
    keeps a typo from creating one.
    """
    stream = find_stream(state, stream_id)
    if stream is None:
        raise Invalid(f"set: unknown stream: {stream_id}", 1)
    stream[field] = value
    return state


def bump_stream_field(state: dict, stream_id: str, field: str) -> int:
    """Add one to a numeric field of one stream, and return what it now holds.

    The run skill counts review rounds and attempts, and every count it keeps is
    one a resumed session has to agree with. Reading the value, adding one, and
    writing it back would put that arithmetic in the skill, where a tick that
    stopped between the read and the write leaves the count behind by one and
    the next round repeats work already done. Here it is one call.

    A field that is null or absent counts as 0, which is what a stream planned
    before the field existed carries. A field holding something that is not a
    number is refused rather than replaced: it means the state file was written
    by something else, and overwriting it would lose whatever that was.
    """
    stream = find_stream(state, stream_id)
    if stream is None:
        raise Invalid(f"bump: unknown stream: {stream_id}", 1)
    current = stream.get(field)
    if current is None:
        current = 0
    # bool before int: True is an int in Python, and a field holding one is not a
    # count somebody meant to increment.
    if isinstance(current, bool) or not isinstance(current, int):
        raise Invalid(f"bump: {field} is not a number on stream {stream_id}: {current}", 1)
    stream[field] = current + 1
    return stream[field]


def check_numeric_field(field: str) -> None:
    """`bump` is arithmetic, so it takes only the fields that hold a number."""
    if field not in NUMERIC_FIELDS:
        raise Invalid(
            "bump: {} is not a numeric field (one of: {})".format(field, " ".join(NUMERIC_FIELDS))
        )


def filter_streams(state: dict, status: str) -> list:
    """The streams with that status, in order.

    An empty status is no filter at all, which is what `list-streams` with no
    `--status` passes.
    """
    return [stream for stream in state["streams"] if status == "" or stream.get("status") == status]


# --- lifecycle ---------------------------------------------------------------


def is_finished(document) -> bool:
    """Whether every stream of this plan has reached a terminal status.

    A finished plan is one nothing is left to do on, which is what `plan` reads
    to know it may replace the file without asking and what `run` reads to know
    the report it is about to print is the last one. `paused` is deliberately not
    terminal: a paused stream is waiting on an answer from the user, and treating
    it as finished would archive the question along with the plan.

    Vacuously true for a plan with no streams: that is what `init` writes before
    the first `add-stream`, so a half-written plan nobody carried on with is
    replaceable rather than something to ask about.
    """
    return all(stream.get("status") in TERMINAL for stream in document["streams"])


def reconcile(document, pr_states):
    """Bring the streams into line with what GitHub says about their PRs.

    `pr_states` maps a pull request number to its state (`PR_STATES`). A merged
    pull request is the stream's work landing, whoever merged it: the run loop
    marks a stream `done` off its own checks, but a PR merged in a browser, by
    another session, or by `harden` never comes back through the loop, and
    without this the plan says `reviewing` forever. A closed one is that stream
    failing, with the question saying so, because nothing is coming of the branch
    it left behind.

    Only non-terminal streams with a pull request are touched, and only the two
    states `RECONCILED` maps: `OPEN` is the ordinary case the loop is already
    handling, and a stream whose PR is not in the map was not asked about.

    Returns the document and the transitions applied, each `{"stream", "from",
    "to"}`, so the caller can report what moved rather than diffing the file.
    """
    transitions = []
    for stream in document["streams"]:
        was = stream.get("status")
        number = stream.get("pr")
        if was in TERMINAL or number is None:
            continue
        now = RECONCILED.get(pr_states.get(number))
        if now is None:
            continue
        if now == "failed":
            stream["question"] = f"PR #{number} was closed without merging"
        stream["status"] = now
        transitions.append({"stream": stream.get("id"), "from": was, "to": now})
    return document, transitions


def file_stem(repo: str) -> str:
    """owner/name as one path segment: the state file's name without `.json`."""
    return repo.replace("/", "__")


def safe_part(value: str) -> str:
    """One component of a file name, with anything a path could read as structure
    replaced.

    `created` carries colons (`2026-09-07T12:34:56Z`), which are a path separator
    on some filesystems and merely awkward on the rest, and the field is only as
    trustworthy as whatever last wrote the file, so a slash or a backslash in it
    must not decide where the archive lands.
    """
    for character in ":/\\":
        value = value.replace(character, "-")
    return value


def archive_name(document) -> str:
    """What a finished plan is filed under: `<owner>__<name>.<created>.json`.

    Named for the repository and the moment the plan was created, so a repository
    worked several times keeps one file per run rather than one file overwritten.
    A document missing either field -- possible only if something other than this
    wrote it -- is still archived, under `unknown`, because the point of the move
    is not losing the file.
    """
    repo = document.get("repo")
    created = document.get("created")
    stem = file_stem(repo) if isinstance(repo, str) and repo else "unknown"
    stamp = created if isinstance(created, str) and created else "unknown"
    return f"{safe_part(stem)}.{safe_part(stamp)}.json"


# --- meta and deferred -------------------------------------------------------


def set_meta(state: dict, field: str, value) -> dict:
    """Write one plan-level meta field.

    A state file written before `meta` existed has no such object; it gets one
    rather than being refused, and every other field of the document is left
    exactly as it was.
    """
    state.setdefault("meta", {})[field] = value
    return state


def defer(state: dict, issue: int, reason: str) -> dict:
    """Record an issue as deferred, with the reason.

    Deferring the same issue twice replaces the first reason rather than
    recording the issue twice; every other entry keeps its place.
    """
    kept = [entry for entry in state.get("deferred", []) if entry.get("issue") != issue]
    state["deferred"] = kept + [{"issue": issue, "reason": reason}]
    return state


# --- validation --------------------------------------------------------------


def parse_issues(issues: str) -> list:
    """Comma-separated issue numbers, split into a list of numbers."""
    if not ISSUE_LIST.match(issues):
        raise Invalid(f"add-stream: --issues must be comma-separated numbers, got: {issues}")
    return [int(part) for part in issues.split(",")]


def check_order(order: str) -> None:
    """`--order` is a position from the bottom, so it starts at 1."""
    if order != "" and not ORDER.match(order):
        raise Invalid(f"add-stream: --order must be a number from 1, got: {order}")


def check_layer(kind: str, stack: str, order: str, base: str) -> None:
    """A stack layer needs --stack and --order; an independent stream takes neither."""
    if kind == "stack":
        if stack == "" or order == "":
            raise Invalid("add-stream: a stack layer needs --stack and --order")
    elif stack != "" or order != "" or base != "":
        raise Invalid("add-stream: --stack, --order, and --base are for --kind stack")


def check_choice(kind: str, effort: str, model: str) -> None:
    """The three closed vocabularies add-stream accepts, in the shell's order."""
    if kind not in KINDS:
        raise Invalid(f"add-stream: kind must be independent or stack, got: {kind}")
    if effort not in EFFORTS:
        raise Invalid(f"add-stream: effort must be low, medium, or high, got: {effort}")
    if model not in MODELS:
        raise Invalid("add-stream: model must be one of {} got: {}".format(" ".join(MODELS), model))


def check_field(field: str) -> None:
    """`set` writes only the documented fields, so a typo cannot create one."""
    if field not in FIELDS:
        raise Invalid("set: unknown field: {} (one of: {})".format(field, " ".join(FIELDS)))


def check_status(status: str, command: str) -> None:
    """The same status vocabulary guards `set status` and `list-streams --status`."""
    if status not in STATUSES:
        raise Invalid(
            "{}: invalid status: {} (one of: {})".format(command, status, " ".join(STATUSES))
        )


def numeric_field_value(field: str, value: str):
    """A NUMERIC_FIELDS field takes a number or null, and is stored as JSON.

    Those fields are pr, attempts, order, and review_rounds. `bump` adds one to
    the same set; every other field is stored as the string it was given unless
    --json says otherwise.
    """
    if value == "null":
        return None
    if not DIGITS.match(value):
        raise Invalid(f"set: {field} takes a number or null, got: {value}")
    return int(value)


def json_value(value: str):
    """The `--json` value, parsed. An empty string is not JSON, and neither is `{oops`.

    NaN, Infinity and -Infinity are refused as well. Python's parser accepts all
    three, but they are not JSON: written back out they would produce a state
    file no other reader could parse, and the script writes with allow_nan off,
    so the file could not be written at all.
    """
    if value == "":
        raise Invalid(f"set: --json value is not valid JSON: {value}")
    try:
        return json.loads(value, parse_constant=no_constants)
    except ValueError:
        raise Invalid(f"set: --json value is not valid JSON: {value}") from None


def no_constants(name: str):
    """The `parse_constant` hook: refuse NaN and both infinities by name."""
    raise ValueError(f"not JSON: {name}")


def meta_value(field: str, value: str):
    """A meta value: a string, except loop_delay, which is a number in range.

    The run skill hands loop_delay straight to ScheduleWakeup, which takes a
    number in this range. int() drops any zero padding, so a padded 0600 is
    stored as 600 rather than as JSON no parser would accept.
    """
    if field not in META_NUMERIC:
        return value
    if not DIGITS.match(value) or not LOOP_DELAY_MIN <= int(value) <= LOOP_DELAY_MAX:
        raise Invalid(
            f"meta: {field} takes an integer from "
            f"{LOOP_DELAY_MIN} to {LOOP_DELAY_MAX}, got: {value}"
        )
    return int(value)
